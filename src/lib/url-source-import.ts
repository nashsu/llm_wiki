import { writeFile } from "@/commands/fs"
import type { LlmConfig, SourceWatchConfig } from "@/stores/wiki-store"
import type { WikiProject } from "@/types/wiki"
import { getHttpFetch } from "@/lib/tauri-fetch"
import { normalizeSourceWatchConfig } from "@/lib/source-watch-config"
import { enqueueSourceIngest, getUniqueDestPath } from "@/lib/source-lifecycle"
import { normalizePath } from "@/lib/path-utils"

export const MAX_BATCH_URLS = 50
const MAX_REDIRECTS = 10

export interface UrlImportResult {
  url: string
  path?: string
  error?: string
}

export function parseImportUrls(input: string): string[] {
  const unique = new Set<string>()
  for (const line of input.split(/\r?\n/)) {
    const candidate = line.trim()
    if (!candidate) continue
    let parsed: URL
    try {
      parsed = new URL(candidate)
    } catch {
      throw new Error(`Invalid URL: ${candidate}`)
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error(`Unsupported URL scheme: ${candidate}`)
    }
    if (parsed.username || parsed.password) {
      throw new Error(`URLs with embedded credentials are not allowed: ${candidate}`)
    }
    parsed.hash = ""
    unique.add(parsed.toString())
    if (unique.size > MAX_BATCH_URLS) {
      throw new Error(`A batch can contain at most ${MAX_BATCH_URLS} URLs`)
    }
  }
  return [...unique]
}

function isPrivateNetworkHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "")
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true
  if (host === "::" || host === "::1" || /^(?:fc|fd|fe[89ab])/i.test(host)) return true
  if (host.startsWith("::ffff:")) {
    const mapped = host.slice(7)
    if (mapped.includes(".")) return isPrivateNetworkHost(mapped)
    const groups = mapped.split(":")
    if (groups.length === 2 && groups.every((group) => /^[0-9a-f]{1,4}$/i.test(group))) {
      const high = Number.parseInt(groups[0], 16)
      const low = Number.parseInt(groups[1], 16)
      return isPrivateNetworkHost(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`)
    }
  }
  const parts = host.split(".").map(Number)
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false
  }
  const [a, b] = parts
  return a === 0
    || a === 10
    || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19))
    || a >= 224
}

function validateHttpUrl(value: string): URL {
  const parsed = new URL(value)
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Unsupported URL scheme: ${value}`)
  }
  if (parsed.username || parsed.password) {
    throw new Error(`URLs with embedded credentials are not allowed: ${value}`)
  }
  return parsed
}

/** @internal Exported for redirect-policy regression tests. */
export async function fetchImportUrl(
  fetch: typeof globalThis.fetch,
  initialUrl: string,
  signal: AbortSignal,
): Promise<Response> {
  let current = validateHttpUrl(initialUrl)
  const initialIsPrivate = isPrivateNetworkHost(current.hostname)
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
    // Tauri plugin-http does not forward the standard `redirect` option to
    // reqwest. Its transport-specific maxRedirections flag is therefore
    // required to expose each 3xx response to this policy loop. Native/Node
    // fetch ignores the extra field and follows `redirect: "manual"`.
    const requestInit: RequestInit & { maxRedirections: number } = {
      redirect: "manual",
      maxRedirections: 0,
      signal,
    }
    const response = await fetch(current.toString(), requestInit)
    if (![301, 302, 303, 307, 308].includes(response.status)) return response
    if (redirects === MAX_REDIRECTS) throw new Error(`Too many redirects (maximum ${MAX_REDIRECTS})`)
    const location = response.headers.get("location")
    if (!location) throw new Error("Redirect response is missing a Location header")
    const next = validateHttpUrl(new URL(location, current).toString())
    if (!initialIsPrivate && isPrivateNetworkHost(next.hostname)) {
      throw new Error("A public URL cannot redirect to a private or local network address")
    }
    current = next
  }
  throw new Error(`Too many redirects (maximum ${MAX_REDIRECTS})`)
}

function safeSlug(value: string): string {
  const slug = value
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}._-]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100)
  const stem = slug.split(".")[0]?.toUpperCase()
  return /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(stem) ? `${slug}-web` : slug
}

export function urlSourceFileName(url: string, contentType: string, body: string): string {
  const parsed = new URL(url)
  const html = /(?:text\/html|application\/xhtml\+xml)/i.test(contentType)
  const title = html ? body.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] : undefined
  const decodedTitle = title?.replace(/<[^>]+>/g, " ").replace(/&(?:amp|#38);/gi, "&").trim()
  const encodedLeaf = parsed.pathname.split("/").filter(Boolean).pop() ?? ""
  let pathLeaf = encodedLeaf
  try {
    pathLeaf = decodeURIComponent(encodedLeaf)
  } catch {
    // Keep the encoded path leaf. A malformed percent sequence in a remote
    // URL should not prevent importing an otherwise valid response.
  }
  const base = safeSlug(decodedTitle || pathLeaf.replace(/\.[^.]+$/, "") || parsed.hostname) || "web-page"
  return `${base}.${html ? "html" : "txt"}`
}

function attachSourceUrl(url: string, contentType: string, body: string): string {
  if (/(?:text\/html|application\/xhtml\+xml)/i.test(contentType)) {
    const escaped = url.replace(/&/g, "&amp;").replace(/"/g, "&quot;")
    const meta = `<meta name="llm-wiki-source-url" content="${escaped}">`
    return /<head\b[^>]*>/i.test(body)
      ? body.replace(/<head\b[^>]*>/i, (head) => `${head}\n${meta}`)
      : `${meta}\n${body}`
  }
  return `Source URL: ${url}\n\n${body}`
}

export async function importSourceUrls(
  project: WikiProject,
  urls: string[],
  llmConfig: LlmConfig,
  sourceWatchConfig?: SourceWatchConfig,
): Promise<UrlImportResult[]> {
  const fetch = await getHttpFetch()
  const maxBytes = normalizeSourceWatchConfig(sourceWatchConfig).maxFileSizeMb * 1024 * 1024
  const sourceRoot = `${normalizePath(project.path)}/raw/sources`
  const results: UrlImportResult[] = []
  const importedPaths: string[] = []

  for (const url of urls) {
    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 60_000)
      let response: Response
      try {
        response = await fetchImportUrl(fetch, url, controller.signal)
      } finally {
        clearTimeout(timeout)
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const declaredSize = Number(response.headers.get("content-length") ?? "0")
      if (Number.isFinite(declaredSize) && declaredSize > maxBytes) {
        throw new Error("Response exceeds the source file size limit")
      }
      const bytes = new Uint8Array(await response.arrayBuffer())
      if (bytes.byteLength > maxBytes) throw new Error("Response exceeds the source file size limit")
      const contentType = response.headers.get("content-type") ?? "text/plain"
      if (!/(?:text\/|application\/(?:xhtml\+xml|json|xml))/i.test(contentType)) {
        throw new Error(`Unsupported content type: ${contentType.split(";")[0]}`)
      }
      const body = new TextDecoder().decode(bytes)
      const fileName = urlSourceFileName(url, contentType, body)
      const path = await getUniqueDestPath(sourceRoot, fileName)
      await writeFile(path, attachSourceUrl(url, contentType, body))
      importedPaths.push(path)
      results.push({ url, path })
    } catch (error) {
      results.push({ url, error: error instanceof Error ? error.message : String(error) })
    }
  }

  try {
    await enqueueSourceIngest(project, importedPaths, llmConfig)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    for (const result of results) {
      if (result.path) result.error = `Saved, but failed to queue ingest: ${message}`
    }
  }
  return results
}

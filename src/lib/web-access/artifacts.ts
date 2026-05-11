import { writeFile } from "@/commands/fs"
import { normalizePath } from "@/lib/path-utils"
import { quoteFromMarkdown } from "./extract"
import type {
  WebAccessArtifactResult,
  WebAccessEvidence,
  WebAccessExtractedPage,
  WebAccessRunTrace,
  WebAccessTraceEvent,
} from "./contracts"
import { redactUrl } from "./policy"

export function createWebAccessRunId(taskId: string): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z")
  return `${stamp}-${safeSegment(taskId).slice(0, 12) || "run"}`
}

export async function persistWebAccessPage(
  projectPath: string,
  runId: string,
  page: WebAccessExtractedPage,
  ordinal: number,
): Promise<WebAccessArtifactResult> {
  const pp = normalizePath(projectPath)
  const relativePath = `raw/sources/web/${runId}/${String(ordinal).padStart(2, "0")}-${slugifyUrl(page.finalUrl)}.md`
  const absolutePath = `${pp}/${relativePath}`
  const contentHash = await sha256(page.markdown)
  const evidence: WebAccessEvidence = {
    id: `B${ordinal}`,
    url: page.url,
    finalUrl: page.finalUrl,
    title: page.title || page.finalUrl,
    quote: quoteFromMarkdown(page.markdown),
    fetchedAt: page.fetchedAt,
    contentHash,
    artifactPath: relativePath,
    method: "webaccess-cdp",
  }

  const frontmatter = [
    "---",
    "type: source",
    `origin: web-access`,
    `title: "${escapeYaml(evidence.title)}"`,
    `url: "${escapeYaml(redactUrl(evidence.finalUrl))}"`,
    `fetchedAt: ${evidence.fetchedAt}`,
    `contentHash: "${contentHash}"`,
    "---",
    "",
  ].join("\n")

  await writeFile(absolutePath, `${frontmatter}${page.markdown}\n`)
  return { evidence, absolutePath }
}

export async function persistWebAccessTrace(projectPath: string, trace: WebAccessRunTrace): Promise<string> {
  const pp = normalizePath(projectPath)
  const relativePath = `.llm-wiki/web-access/runs/${trace.runId}/trace.json`
  await writeFile(`${pp}/${relativePath}`, JSON.stringify(redactTrace(trace), null, 2))
  return relativePath
}

export function buildTrace(runId: string, topic: string): WebAccessRunTrace {
  return {
    runId,
    topic,
    startedAt: new Date().toISOString(),
    events: [],
    evidence: [],
  }
}

export function appendTraceEvents(trace: WebAccessRunTrace, events: WebAccessTraceEvent[]): void {
  trace.events.push(...events)
}

function redactTrace(trace: WebAccessRunTrace): WebAccessRunTrace {
  return {
    ...trace,
    events: trace.events.map((item) => ({ ...item, url: item.url ? redactUrl(item.url) : undefined })),
    evidence: trace.evidence.map((item) => ({
      ...item,
      url: redactUrl(item.url),
      finalUrl: redactUrl(item.finalUrl),
    })),
  }
}

export function slugifyUrl(url: string): string {
  try {
    const parsed = new URL(url)
    const path = parsed.pathname.replace(/\/$/, "").split("/").filter(Boolean).slice(-2).join("-")
    return safeSegment(`${parsed.hostname}-${path || "page"}`).slice(0, 80) || "page"
  } catch {
    return safeSegment(url).slice(0, 80) || "page"
  }
}

function safeSegment(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/gi, "-")
    .replace(/^-+|-+$/g, "")
}

function escapeYaml(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
}

async function sha256(value: string): Promise<string> {
  if (globalThis.crypto?.subtle) {
    const bytes = new TextEncoder().encode(value)
    const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes)
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
  }

  let hash = 0
  for (let i = 0; i < value.length; i++) {
    hash = (Math.imul(31, hash) + value.charCodeAt(i)) | 0
  }
  return `fallback-${Math.abs(hash).toString(16)}`
}

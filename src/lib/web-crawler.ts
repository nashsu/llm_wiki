export interface CrawledPage {
  url: string
  title: string
  content: string
  status: "success" | "failed"
  error?: string
}

const DEFAULT_CONCURRENCY = 4
const DEFAULT_TIMEOUT_MS = 15_000

function stripTags(html: string, tags: string[]): string {
  return tags.reduce((s, tag) => {
    const re = new RegExp(`<${tag}[^>]*>[\\s\\S]*?<\\/${tag}>`, "gi")
    return s.replace(re, "")
  }, html)
}

function extractBody(html: string): string {
  // Prefer <article>, then <main>, then <body>
  const article = /<article[^>]*>([\s\S]*?)<\/article>/i.exec(html)
  if (article) return article[1]

  const main = /<main[^>]*>([\s\S]*?)<\/main>/i.exec(html)
  if (main) return main[1]

  const body = /<body[^>]*>([\s\S]*?)<\/body>/i.exec(html)
  if (body) return body[1]

  return html
}

function extractTitle(html: string): string {
  const og = /<meta[^>]*property="og:title"[^>]*content="([^"]*)"/i.exec(html)
  if (og) return unescapeHtml(og[1])

  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)
  if (title) return unescapeHtml(title[1].trim())

  const h1 = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html)
  if (h1) return unescapeHtml(h1[1].replace(/<[^>]*>/g, "").trim())

  return ""
}

function unescapeHtml(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
}

const NOISE_TAGS = ["script", "style", "nav", "footer", "header", "aside", "noscript", "iframe"]

export function extractContentFromHtml(html: string): { title: string; content: string } {
  const title = extractTitle(html)
  let body = extractBody(html)
  body = stripTags(body, NOISE_TAGS)
  // Collapse excessive whitespace
  body = body.replace(/\n{3,}/g, "\n\n").trim()
  return { title, content: body }
}

async function crawlSingle(
  url: string,
  httpFetch: (url: string, init?: RequestInit) => Promise<Response>,
  timeoutMs: number,
): Promise<CrawledPage> {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const res = await httpFetch(url, {
      method: "GET",
      headers: {
        Accept: "text/html,application/xhtml+xml,*/*",
        "User-Agent": "Mozilla/5.0 (compatible; LLMWiki/1.0)",
      },
      signal: controller.signal,
    })
    clearTimeout(timer)

    if (!res.ok) {
      return { url, title: "", content: "", status: "failed", error: `HTTP ${res.status}` }
    }

    const ct = res.headers.get("content-type") || ""
    if (!ct.includes("text/html") && !ct.includes("application/xhtml")) {
      return { url, title: "", content: "", status: "failed", error: `Not HTML: ${ct}` }
    }

    const html = await res.text()
    const { title, content } = extractContentFromHtml(html)
    return { url, title, content, status: "success" }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { url, title: "", content: "", status: "failed", error: msg }
  }
}

export async function crawlUrls(
  urls: string[],
  httpFetch: (url: string, init?: RequestInit) => Promise<Response>,
  options?: { concurrency?: number; timeoutMs?: number; onProgress?: (done: number, total: number) => void },
): Promise<CrawledPage[]> {
  const concurrency = options?.concurrency ?? DEFAULT_CONCURRENCY
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const onProgress = options?.onProgress
  const results: CrawledPage[] = new Array(urls.length)
  let done = 0

  // Process in batches of `concurrency`
  for (let i = 0; i < urls.length; i += concurrency) {
    const batch = urls.slice(i, i + concurrency)
    const batchResults = await Promise.all(
      batch.map((url) => crawlSingle(url, httpFetch, timeoutMs)),
    )
    batchResults.forEach((r, j) => {
      results[i + j] = r
    })
    done += batch.length
    onProgress?.(done, urls.length)
  }

  return results
}

import { readFile, listDirectory } from "@/commands/fs"
import { streamChat } from "@/lib/llm-client"
import type { LlmConfig } from "@/stores/wiki-store"
import type { FileNode } from "@/types/wiki"
import { useActivityStore } from "@/stores/activity-store"
import { getFileName, getRelativePath, normalizePath } from "@/lib/path-utils"
import { buildLanguageDirective } from "@/lib/output-language"
import { normalizeReviewTitle } from "@/lib/review-utils"
import {
  computeStructuralLint,
  type StructuralLintFinding,
  type StructuralLintPage,
} from "@/lib/lint-structural-core"

export interface LintResult {
  type: "orphan" | "broken-link" | "no-outlinks" | "semantic"
  severity: "warning" | "info"
  page: string
  detail: string
  affectedPages?: string[]
  brokenTarget?: string
  suggestedTarget?: string
  suggestedSource?: string
}

const SUGGESTION_TOKEN_WINDOW = 4000

// ── helpers ───────────────────────────────────────────────────────────────────

function flattenMdFiles(nodes: FileNode[]): FileNode[] {
  const files: FileNode[] = []
  for (const node of nodes) {
    if (node.is_dir && node.children) {
      files.push(...flattenMdFiles(node.children))
    } else if (!node.is_dir && node.name.endsWith(".md")) {
      files.push(node)
    }
  }
  return files
}

function extractWikilinks(content: string): string[] {
  const links: string[] = []
  const regex = /\[\[([^\]|]+?)(?:\|[^\]]+?)?\]\]/g
  let match: RegExpExecArray | null
  while ((match = regex.exec(content)) !== null) {
    links.push(match[1].trim())
  }
  return links
}

function relativeToSlug(relativePath: string): string {
  // relativePath relative to wiki/ dir, e.g. "entities/foo-bar" or "queries/my-page-2024-01-01"
  return relativePath.replace(/\.md$/, "")
}

/**
 * Normalize a name for missing-page existence comparison. NFKC folds full-width
 * and compatibility forms so CJK / full-width variants compare equal.
 */
function normalizeForExistence(s: string): string {
  return normalizeReviewTitle(s).normalize("NFKC").trim().toLowerCase()
}

/**
 * Decide whether an LLM `missing-page` finding actually refers to a page that
 * already exists. The LLM does not reliably cross-reference the file list, so it
 * flags entities whose page is already present. Only exact normalized names are
 * accepted here. Substring matching is unsafe because short, valid page titles
 * can also be ordinary words inside an unrelated missing-page finding.
 */
function missingPageAlreadyExists(
  llmTitle: string,
  existingPageNames: Set<string>,
): boolean {
  const norm = normalizeForExistence(llmTitle)
  if (!norm) return false
  return existingPageNames.has(norm)
}

function extractTitle(content: string, fallbackPath: string): string {
  const frontmatter = content.match(/^---\s*\n([\s\S]*?)\n---/)
  if (frontmatter) {
    const title = frontmatter[1].match(/^title:\s*["']?(.+?)["']?\s*$/m)
    if (title?.[1]?.trim()) return title[1].trim()
  }
  const heading = content.match(/^#\s+(.+)$/m)
  if (heading?.[1]?.trim()) return heading[1].trim()
  return getFileName(fallbackPath)
    .replace(/\.md$/i, "")
    .replace(/[-_]+/g, " ")
}

function tokenizeForSuggestion(text: string): Set<string> {
  const tokens = new Set<string>()
  const normalized = text.normalize("NFKC").toLowerCase()
  for (const match of normalized.matchAll(/[\p{L}\p{N}]+/gu)) {
    const token = match[0]
    if (token.length >= 2) tokens.add(token)
    if (/[\u3400-\u9fff]/u.test(token)) {
      for (const char of Array.from(token)) tokens.add(char)
    }
  }
  return tokens
}

// ── Structural lint ───────────────────────────────────────────────────────────

export interface StructuralLintOptions {
  signal?: AbortSignal
  onProgress?: (completed: number, total: number) => void
}

function runStructuralWorker(
  pages: StructuralLintPage[],
  options: StructuralLintOptions,
): Promise<StructuralLintFinding[]> {
  if (typeof Worker === "undefined") {
    return Promise.resolve(computeStructuralLint(pages, options.onProgress))
  }
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./lint-structural.worker.ts", import.meta.url), { type: "module" })
    const abort = () => {
      worker.terminate()
      reject(new DOMException("Structural lint cancelled", "AbortError"))
    }
    if (options.signal?.aborted) {
      abort()
      return
    }
    options.signal?.addEventListener("abort", abort, { once: true })
    worker.onerror = (event) => {
      options.signal?.removeEventListener("abort", abort)
      worker.terminate()
      reject(new Error(event.message || "Structural lint worker failed"))
    }
    worker.onmessage = (event: MessageEvent<{
      type: "progress" | "done"
      completed?: number
      total?: number
      findings?: StructuralLintFinding[]
    }>) => {
      if (event.data.type === "progress") {
        options.onProgress?.(event.data.completed ?? 0, event.data.total ?? pages.length)
        return
      }
      options.signal?.removeEventListener("abort", abort)
      worker.terminate()
      resolve(event.data.findings ?? [])
    }
    worker.postMessage({ pages })
  })
}

export async function runStructuralLint(
  projectPath: string,
  options: StructuralLintOptions = {},
): Promise<LintResult[]> {
  const wikiRoot = `${normalizePath(projectPath)}/wiki`
  let tree: FileNode[]
  try {
    tree = await listDirectory(wikiRoot)
  } catch {
    return []
  }

  const wikiFiles = flattenMdFiles(tree)
  // Exclude index.md and log.md from orphan checks
  const contentFiles = wikiFiles.filter(
    (f) => f.name !== "index.md" && f.name !== "log.md"
  )

  const pages: StructuralLintPage[] = []

  for (let index = 0; index < contentFiles.length; index += 1) {
    if (options.signal?.aborted) throw new DOMException("Structural lint cancelled", "AbortError")
    const f = contentFiles[index]
    try {
      const content = await readFile(f.path)
      const shortName = getRelativePath(f.path, wikiRoot)
      const slug = relativeToSlug(shortName)
      const title = extractTitle(content, shortName)
      const outlinks = extractWikilinks(content)
      const slugName = getFileName(slug)
      const tokens = Array.from(tokenizeForSuggestion(`${title}\n${slugName}\n${content.slice(0, SUGGESTION_TOKEN_WINDOW)}`))
      pages.push({ shortName, slug, title, outlinks, tokens })
    } catch {
      // skip unreadable files
    }
    options.onProgress?.(index + 1, contentFiles.length * 2)
  }
  return runStructuralWorker(pages, {
    ...options,
    onProgress: (completed, total) => options.onProgress?.(contentFiles.length + completed, contentFiles.length + total),
  })
}

// ── Semantic lint ─────────────────────────────────────────────────────────────

const LINT_BLOCK_REGEX =
  /---LINT:\s*([^\n|]+?)\s*\|\s*([^\n|]+?)\s*\|\s*([^\n-]+?)\s*---\n([\s\S]*?)---END LINT---/g

export async function runSemanticLint(
  projectPath: string,
  llmConfig: LlmConfig,
  signal?: AbortSignal,
): Promise<LintResult[]> {
  const pp = normalizePath(projectPath)
  const activity = useActivityStore.getState()
  const activityId = activity.addItem({
    type: "lint",
    title: "Semantic wiki lint",
    status: "running",
    detail: "Reading wiki pages...",
    filesWritten: [],
  })

  const wikiRoot = `${pp}/wiki`
  let tree: FileNode[]
  try {
    tree = await listDirectory(wikiRoot)
  } catch {
    activity.updateItem(activityId, { status: "error", detail: "Failed to read wiki directory." })
    return []
  }

  const wikiFiles = flattenMdFiles(tree).filter(
    (f) => f.name !== "log.md"
  )

  // Build a compact summary of each page (frontmatter + first 500 chars), and
  // collect the set of existing page names (basename + frontmatter title) used
  // to filter out `missing-page` findings for pages that already exist (#537).
  const summaries: string[] = []
  const existingPageNames = new Set<string>()
  for (const f of wikiFiles) {
    if (signal?.aborted) throw new DOMException("Semantic lint cancelled", "AbortError")
    const basename = f.name.replace(/\.md$/i, "")
    if (basename) existingPageNames.add(normalizeForExistence(basename))
    try {
      const content = await readFile(f.path)
      const preview = content.slice(0, 500) + (content.length > 500 ? "..." : "")
      const shortPath = getRelativePath(f.path, wikiRoot)
      const title = extractTitle(content, shortPath)
      if (title) existingPageNames.add(normalizeForExistence(title))
      summaries.push(`### ${shortPath}\n${preview}`)
    } catch {
      // skip
    }
  }

  if (summaries.length === 0) {
    activity.updateItem(activityId, { status: "done", detail: "No wiki pages to lint." })
    return []
  }

  activity.updateItem(activityId, { detail: "Running LLM semantic analysis..." })

  // For auto-mode language detection, sample the concatenated summaries
  // so non-English wikis get a matching language directive.
  const summarySample = summaries.join("\n").slice(0, 2000)

  const prompt = [
    "You are a wiki quality analyst. Review the following wiki page summaries and identify issues.",
    "",
    buildLanguageDirective(summarySample),
    "",
    "For each issue, output exactly this format:",
    "",
    "---LINT: type | severity | Short title---",
    "Description of the issue.",
    "PAGES: page1.md, page2.md",
    "---END LINT---",
    "",
    "Types:",
    "- contradiction: two or more pages make conflicting claims",
    "- stale: information that appears outdated or superseded",
    "- missing-page: an important concept is heavily referenced but has no dedicated page",
    "- suggestion: a question or source worth adding to the wiki",
    "For missing-page findings, Short title must be only the exact missing concept or entity name, without explanatory prefixes or suffixes.",
    "",
    "Severities:",
    "- warning: should be addressed",
    "- info: nice to have",
    "",
    "Only report genuine issues. Do not invent problems. Output ONLY the ---LINT--- blocks, no other text.",
    "",
    "## Wiki Pages",
    "",
    summaries.join("\n\n"),
  ].join("\n")

  let raw = ""
  let hadError = false

  await streamChat(
    llmConfig,
    [{ role: "user", content: prompt }],
    {
      onToken: (token) => { raw += token },
      onDone: () => {},
      onError: (err) => {
        hadError = true
        activity.updateItem(activityId, {
          status: "error",
          detail: `LLM error: ${err.message}`,
        })
      },
    },
    signal,
  )

  if (signal?.aborted) throw new DOMException("Semantic lint cancelled", "AbortError")
  if (hadError) return []

  const results: LintResult[] = []
  const matches = raw.matchAll(LINT_BLOCK_REGEX)

  for (const match of matches) {
    const rawType = match[1].trim().toLowerCase()
    const severity = match[2].trim().toLowerCase()
    const title = match[3].trim()
    const body = match[4].trim()

    // Drop `missing-page` findings whose page already exists — the LLM often
    // flags entities that already have a page, especially in non-English wikis
    // where its free-form titles don't match a fixed prefix (#537).
    if (rawType === "missing-page" && missingPageAlreadyExists(title, existingPageNames)) {
      continue
    }

    const pagesMatch = body.match(/^PAGES:\s*(.+)$/m)
    const affectedPages = pagesMatch
      ? pagesMatch[1].split(",").map((p) => p.trim())
      : undefined

    const detail = body.replace(/^PAGES:.*$/m, "").trim()

    results.push({
      type: "semantic",
      severity: (severity === "warning" ? "warning" : "info") as LintResult["severity"],
      page: title,
      detail: `[${rawType}] ${detail}`,
      affectedPages,
    })
  }

  activity.updateItem(activityId, {
    status: "done",
    detail: `Found ${results.length} semantic issue(s).`,
  })

  return results
}

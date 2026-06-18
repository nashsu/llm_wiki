import { readFile, writeFile } from "@/commands/fs"
import { streamChat } from "./llm-client"
import { useWikiStore, type LlmConfig } from "@/stores/wiki-store"
import { buildLanguageDirective } from "./output-language"
import { normalizePath } from "@/lib/path-utils"

/**
 * Lightweight post-save enrichment: ask LLM to add [[wikilinks]] to a saved wiki page.
 *
 * DESIGN NOTE (v2): previously we asked the LLM to return the complete page
 * with [[ ]] inserted, but many models (confirmed on MiniMax-M2.7-highspeed)
 * treat this as an invitation to rewrite / expand the page, destroying
 * user content. No prompt-level instruction reliably prevents this for
 * mid-size models.
 *
 * New design: LLM only returns a list of `(term → target)` substitutions as
 * JSON. The code then does the actual string replacement (first occurrence
 * per page). This way:
 *   - content is byte-identical outside the inserted [[ ]] brackets
 *   - frontmatter is untouched
 *   - length grows by exactly 4 × number_of_links
 *   - catastrophic LLM output (rewrites, translations, commentary) can't
 *     corrupt the user's page
 */
export async function enrichWithWikilinks(
  projectPath: string,
  filePath: string,
  llmConfig: LlmConfig,
  signal?: AbortSignal,
): Promise<void> {
  // Early abort check
  if (signal?.aborted) return

  const pp = normalizePath(projectPath)
  const fp = normalizePath(filePath)
  const [content, index] = await Promise.all([
    readFile(fp),
    readFile(`${pp}/wiki/index.md`).catch(() => ""),
  ])

  if (signal?.aborted) return
  if (!content || !index) return

  // Extract valid page names from index for target validation
  const validTargets = extractPageNamesFromIndex(index)
  if (validTargets.size === 0) return

  // Ask the LLM to return a JSON list of {term, target} substitutions.
  // Much easier task than rewriting the whole page, and the model can't
  // corrupt anything it doesn't put in the list.
  let raw = ""

  await streamChat(
    llmConfig,
    [
      {
        role: "system",
        content: [
          "You identify which terms in a wiki page should become [[wikilinks]] pointing to existing wiki pages.",
          "",
          buildLanguageDirective(content),
          "",
          "You will receive:",
          "  - a wiki index listing existing pages (each line roughly like `- pagename`)",
          "  - the content of ONE wiki page",
          "",
          "Return a JSON object listing which terms in the page content should be linked to which index entries.",
          "",
          "Response format (EXACTLY this JSON shape, nothing else):",
          "{",
          '  "links": [',
          '    { "term": "exact text appearing in the content", "target": "index page name" }',
          "  ]",
          "}",
          "",
          "Rules:",
          '- Each "term" MUST be a literal substring present in the page content (case-sensitive).',
          '- Each "target" MUST be a page listed in the wiki index.',
          "- Include at most one entry per target (first mention).",
          "- Only include clearly-matching terms (e.g. if content mentions 'Transformer' and index has 'transformer', target='transformer' is correct).",
          "- If no terms should be linked, return {\"links\": []}.",
          "- Do NOT output preamble, explanations, or markdown fences — ONLY the JSON object.",
          "",
          `## Wiki Index\n${index}`,
        ].join("\n"),
      },
      {
        role: "user",
        content: `Page content:\n\n${content}`,
      },
    ],
    {
      onToken: (token) => { raw += token },
      onDone: () => {},
      onError: () => {},
    },
    signal,
  )

  // Check abort again after LLM call
  if (signal?.aborted) return

  // Parse the LLM response. Be tolerant of fences / prose wrappers.
  const links = parseLinkResponse(raw)
  if (links.length === 0) return // nothing to do

  // Filter out links with targets not in the wiki index
  const validLinks = links.filter(({ target }) => {
    const normalizedTarget = target.toLowerCase().replace(/\.md$/, "")
    return validTargets.has(normalizedTarget)
  })
  if (validLinks.length === 0) return

  // Apply substitutions to the ORIGINAL content. This guarantees the only
  // change is inserted [[...]] brackets.
  const enriched = applyLinks(content, validLinks)
  if (enriched === content) return
  if (signal?.aborted) return

  await writeFile(fp, enriched)
  useWikiStore.getState().bumpDataVersion()
}

/**
 * Extract valid page names/ids from wiki index content.
 * Supports formats:
 * - `- page-name`
 * - `- [[page-name]]`
 * - `- [[page-name|Title]]`
 * - `[Title](page-name.md)`
 */
function extractPageNamesFromIndex(indexContent: string): Set<string> {
  const targets = new Set<string>()
  const lines = indexContent.split("\n")
  
  for (const line of lines) {
    // Match `- page-name`
    const simpleMatch = line.match(/^-\s+([\w-]+)/)
    if (simpleMatch) {
      targets.add(simpleMatch[1].toLowerCase())
      continue
    }
    
    // Match `- [[page-name]]` or `- [[page-name|Title]]`
    const wikilinkMatches = line.match(/\[\[([^\]|]+?)(?:\|[^\]]+)?\]\]/g)
    if (wikilinkMatches) {
      for (const match of wikilinkMatches) {
        const pageName = match.replace(/\[\[|\]\]/g, "").split("|")[0].trim()
        if (pageName) targets.add(pageName.toLowerCase())
      }
      continue
    }
    
    // Match `[Title](page-name.md)`
    const mdLinkMatches = line.match(/\[([^\]]+)\]\(([^)]+\.md)\)/g)
    if (mdLinkMatches) {
      for (const match of mdLinkMatches) {
        const pathMatch = match.match(/\]\(([^)]+)\)/)
        if (pathMatch) {
          const pageName = pathMatch[1].replace(/\.md$/, "").split("/").pop()
          if (pageName) targets.add(pageName.toLowerCase())
        }
      }
    }
  }
  
  return targets
}

interface LinkEntry {
  term: string
  target: string
}

function parseLinkResponse(raw: string): LinkEntry[] {
  if (!raw.trim()) return []
  // Extract the first balanced {...}
  let text = raw.trim()
  text = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "")
  const start = text.indexOf("{")
  if (start === -1) return []

  let depth = 0
  let inStr = false
  let escape = false
  let end = -1
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (escape) { escape = false; continue }
    if (ch === "\\" && inStr) { escape = true; continue }
    if (ch === '"') { inStr = !inStr; continue }
    if (inStr) continue
    if (ch === "{") depth++
    else if (ch === "}") {
      depth--
      if (depth === 0) { end = i; break }
    }
  }
  if (end === -1) return []

  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as { links?: unknown }
    if (!parsed || !Array.isArray(parsed.links)) return []
    const result: LinkEntry[] = []
    for (const item of parsed.links) {
      if (
        item &&
        typeof item === "object" &&
        typeof (item as LinkEntry).term === "string" &&
        typeof (item as LinkEntry).target === "string" &&
        (item as LinkEntry).term.length > 0 &&
        (item as LinkEntry).target.length > 0
      ) {
        result.push({
          term: (item as LinkEntry).term,
          target: (item as LinkEntry).target,
        })
      }
    }
    return result
  } catch {
    return []
  }
}

/**
 * For each {term, target}, replace the FIRST literal occurrence of `term`
 * in content (outside of frontmatter and existing [[...]]) with `[[target|term]]`
 * if the displayed text should differ from target, or `[[target]]` if they
 * already match case-insensitively. Skip terms that don't appear as a
 * literal substring. Skip terms already inside an existing wikilink.
 */
function applyLinks(content: string, links: LinkEntry[]): string {
  // Split off YAML frontmatter so we don't touch it
  const fmEnd = content.startsWith("---\n") ? content.indexOf("\n---\n", 3) : -1
  const frontmatter = fmEnd > 0 ? content.slice(0, fmEnd + 5) : ""
  let body = fmEnd > 0 ? content.slice(fmEnd + 5) : content

  // Track what we've already linked so we don't double-link
  const linkedTargets = new Set<string>()

  for (const { term, target } of links) {
    if (linkedTargets.has(target.toLowerCase())) continue
    if (!term || !target) continue

    // Find first literal occurrence NOT already inside a [[...]] block
    const idx = findUnlinkedOccurrence(body, term)
    if (idx === -1) continue

    // Check if term matches target case-insensitively
    const displayEqualsTarget = term.toLowerCase() === target.toLowerCase()
    const replacement = displayEqualsTarget
      ? `[[${term}]]`
      : `[[${target}|${term}]]`
    body = body.slice(0, idx) + replacement + body.slice(idx + term.length)
    linkedTargets.add(target.toLowerCase())
  }

  return frontmatter + body
}

/**
 * Find the first occurrence of `term` in text that isn't already wrapped in [[...]].
 * Pre-scans all [[...]] intervals to accurately detect if a match falls inside one.
 */
function findUnlinkedOccurrence(text: string, term: string): number {
  // Pre-scan all [[...]] intervals
  const wikilinkIntervals: Array<[number, number]> = []
  let scanPos = 0
  while (scanPos < text.length) {
    const openIdx = text.indexOf("[[", scanPos)
    if (openIdx === -1) break
    const closeIdx = text.indexOf("]]", openIdx + 2)
    if (closeIdx === -1) break
    wikilinkIntervals.push([openIdx, closeIdx + 2])
    scanPos = closeIdx + 2
  }

  // Helper to check if a position falls inside any wikilink interval
  const isInsideWikilink = (pos: number): boolean => {
    for (const [start, end] of wikilinkIntervals) {
      if (pos >= start && pos < end) return true
    }
    return false
  }

  // Find first occurrence not inside a wikilink
  let searchFrom = 0
  while (searchFrom < text.length) {
    const idx = text.indexOf(term, searchFrom)
    if (idx === -1) return -1
    
    // Check if this occurrence is inside a wikilink
    if (isInsideWikilink(idx)) {
      searchFrom = idx + term.length
      continue
    }
    
    return idx
  }
  return -1
}

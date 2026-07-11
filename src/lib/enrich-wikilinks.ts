import { readFile, writeFile } from "@/commands/fs"
import { streamChat } from "./llm-client"
import { useWikiStore, type LlmConfig } from "@/stores/wiki-store"
import { buildLanguageDirective } from "./output-language"
import { normalizePath } from "@/lib/path-utils"
import { parseFrontmatter } from "./frontmatter"
import type { LinkEntry } from "@/lib/auto-link-types"
import { insertWikilinksInMarkdown } from "./markdown-wikilink-insertion"
import {
  hashAutoLinkContent,
  StaleAutoLinkReviewError,
} from "./auto-link-content-version"

export type { LinkEntry } from "@/lib/auto-link-types"

export interface SuggestWikilinksOptions {
  content?: string
}

export interface ApplyWikilinksOptions {
  expectedContentHash?: string
}

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
export async function suggestWikilinks(
  projectPath: string,
  filePath: string,
  llmConfig: LlmConfig,
  options: SuggestWikilinksOptions = {},
): Promise<LinkEntry[]> {
  const pp = normalizePath(projectPath).replace(/\/+$/, "")
  const fp = normalizePath(filePath)
  const [content, index] = await Promise.all([
    options.content === undefined ? readFile(fp) : Promise.resolve(options.content),
    readFile(`${pp}/wiki/index.md`).catch(() => ""),
  ])

  if (!content || !index) return []

  // Ask the LLM to return a JSON list of {term, target} substitutions.
  // Much easier task than rewriting the whole page, and the model can't
  // corrupt anything it doesn't put in the list.
  let raw = ""
  let streamError: Error | null = null
  let terminalSettled = false
  let resolveTerminal!: () => void
  const terminal = new Promise<void>((resolve) => {
    resolveTerminal = resolve
  })
  const settleTerminal = () => {
    if (terminalSettled) return
    terminalSettled = true
    resolveTerminal()
  }

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
          "  \"links\": [",
          "    { \"term\": \"exact text appearing in the content\", \"target\": \"index page name\" }",
          "  ]",
          "}",
          "",
          "Rules:",
          "- Each \"term\" MUST be a literal substring present in the page content (case-sensitive).",
          "- Each \"target\" MUST be a page listed in the wiki index.",
          "- Include at most one entry per target (first mention).",
          "- Only include clearly-matching terms (e.g. if content mentions 'Transformer' and index has 'transformer', target='transformer' is correct).",
          "- If no terms should be linked, return `{\"links\": []}`.",
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
      onDone: settleTerminal,
      onError: (error) => {
        streamError ??= error
        settleTerminal()
      },
    },
    undefined,
    {
      temperature: 0.1,
      max_tokens: 2048,
      reasoning: { mode: "off" },
    },
  )

  if (!terminalSettled) await terminal
  if (streamError) throw streamError
  return parseLinkResponse(raw)
}

export async function applyWikilinks(
  _projectPath: string,
  filePath: string,
  selectedLinks: LinkEntry[],
  options: ApplyWikilinksOptions = {},
): Promise<void> {
  const fp = normalizePath(filePath)
  const content = await readFile(fp)

  if (
    options.expectedContentHash &&
    await hashAutoLinkContent(content) !== options.expectedContentHash
  ) {
    throw new StaleAutoLinkReviewError()
  }

  // Apply substitutions to the ORIGINAL content. This guarantees the only
  // change is inserted [[...]] brackets.
  const enriched = applyLinks(content, selectedLinks)
  if (enriched === content) return

  await writeFile(fp, enriched)
  useWikiStore.getState().bumpDataVersion()
}

export async function enrichWithWikilinks(
  projectPath: string,
  filePath: string,
  llmConfig: LlmConfig,
): Promise<void> {
  const links = await suggestWikilinks(projectPath, filePath, llmConfig)
  if (links.length === 0) return
  await applyWikilinks(projectPath, filePath, links)
}

export function parseLinkResponse(raw: string): LinkEntry[] {
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
export function applyLinks(content: string, links: LinkEntry[]): string {
  const { body: parsedBody, rawBlock } = parseFrontmatter(content)
  const bodyStart = rawBlock && content.endsWith(parsedBody)
    ? content.length - parsedBody.length
    : 0
  const protectedPrefix = content.slice(0, bodyStart)
  const body = content.slice(bodyStart)
  return protectedPrefix + insertWikilinksInMarkdown(body, links)
}

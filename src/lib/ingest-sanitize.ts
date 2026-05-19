/**
 * Clean up an LLM-generated wiki page body before it hits disk.
 *
 * Audit of one real corpus (67 entity pages from `/Test321/wiki/entities`)
 * showed 30/67 pages had frontmatter that couldn't be parsed strictly.
 * Three recurring shapes the model emits:
 *
 *   1. The whole page wrapped in a `\`\`\`yaml … \`\`\`` (or `\`\`\`md`,
 *      `\`\`\`markdown`) code fence, e.g.
 *
 *          ```yaml
 *          ---
 *          type: entity
 *          ---
 *          # Body
 *          ```
 *
 *      — looks fine in the generation context but has no place in a
 *      real .md file.
 *
 *   2. A leading `frontmatter:` key that turns the document into a
 *      malformed nested-yaml shape, e.g.
 *
 *          frontmatter:
 *          ---
 *          type: entity
 *          ---
 *
 *   3. Inline wikilink lists without the outer brackets, e.g.
 *
 *          related: [[a]], [[b]], [[c]]
 *
 *      — semantically what the model wanted (a list of wikilinks),
 *      but not valid YAML flow syntax.
 *
 *   4. All frontmatter keys squeezed onto one line (no `---` fences),
 *      e.g.
 *
 *          type: entity title: Foo tags: [a] related: [b] created: 2026-01-01
 *
 *      — invalid YAML; the read-time parser can't build FrontmatterPanel
 *      fields and the body may render as raw text.
 *
 * This sanitizer rewrites all four shapes into the standard
 * `---\n…\n---\n` frontmatter form before write. It's deliberately
 * conservative: each pattern is anchored at the very start of the
 * document (or at top-level frontmatter scope), so a legitimate
 * fenced code block deep in the body or a `frontmatter:` mention
 * inside prose is left alone.
 *
 * The read-time parser still retains its fallback paths so old,
 * already-written corrupt files render correctly. Sanitizing on
 * write means newly-generated files never need that fallback,
 * which means re-ingesting an old file once cleans it up
 * permanently.
 */
export function sanitizeIngestedFileContent(content: string): string {
  let cleaned = content

  // (1) Strip an outer code fence wrapping the whole document.
  // We only act when the FIRST non-empty line is an opening fence
  // (`\`\`\`yaml`, `\`\`\`md`, `\`\`\`markdown`, or just `\`\`\``)
  // AND the LAST non-empty line is a matching closing fence. This
  // avoids touching pages that legitimately end with an unclosed
  // fence (we don't try to "fix" mid-stream truncation here).
  cleaned = stripOuterCodeFence(cleaned)

  // (2) Strip a stray `frontmatter:` line that prefixes the real
  // `---` block. Some prompts seem to make the model interpret
  // the request as "produce a YAML document with a `frontmatter`
  // key" rather than "produce a markdown document with a
  // frontmatter block".
  cleaned = stripFrontmatterKeyPrefix(cleaned)

  // (3) Split single-line / fenceless frontmatter into `---` blocks.
  cleaned = repairInlineFrontmatter(cleaned)

  // (4) Repair `key: [[a]], [[b]], [[c]]` lines inside the
  // frontmatter block so they're valid YAML. Body wikilinks are
  // left alone — those render fine via the wikilink → markdown
  // link transform applied at read time.
  cleaned = repairWikilinkListsInFrontmatter(cleaned)

  return cleaned
}

/** Top-level fence wrapper. Removes the open + close fence lines. */
function stripOuterCodeFence(content: string): string {
  const open = content.match(/^[ \t]*```(?:yaml|md|markdown)?[ \t]*\r?\n/)
  if (!open) return content
  const afterOpen = content.slice(open[0].length)

  // Closing fence: a final ``` on its own line, ignoring trailing
  // whitespace/newlines after it.
  const close = afterOpen.match(/\r?\n[ \t]*```[ \t]*\r?\n?\s*$/)
  if (!close) return content
  return afterOpen.slice(0, close.index)
}

/**
 * Strip a leading `frontmatter:` line followed by the real
 * frontmatter block. Only acts when the next non-empty line is
 * `---`, so a body that legitimately mentions the word
 * "frontmatter:" in prose is unaffected.
 */
function stripFrontmatterKeyPrefix(content: string): string {
  const m = content.match(/^[ \t]*frontmatter\s*:\s*\r?\n(?=[ \t]*---\s*\r?\n)/)
  if (!m) return content
  return content.slice(m[0].length)
}

/** Keys the ingest pipeline may emit — used to split inline frontmatter. */
const INLINE_FM_KEYS = [
  "type",
  "title",
  "tags",
  "related",
  "created",
  "updated",
  "sources",
  "description",
  "origin",
  "summary",
  "status",
] as const

const INLINE_FM_KEY_RE = new RegExp(
  `\\b(${INLINE_FM_KEYS.join("|")})\\s*:`,
  "gi",
)

function countInlineFmKeys(line: string): number {
  return [...line.matchAll(INLINE_FM_KEY_RE)].length
}

/**
 * Rewrite fenceless, space-separated frontmatter (usually one long line
 * starting with `type:`) into a standard `---` block. Requires at least
 * two recognized keys on the opening line(s) so prose that mentions
 * "type:" mid-sentence is left alone.
 */
function repairInlineFrontmatter(content: string): string {
  if (/^---\s*\r?\n/.test(content)) return content

  const lines = content.split(/\r?\n/)
  const firstLine = lines[0] ?? ""
  if (!/^\s*type\s*:/i.test(firstLine)) return content
  if (countInlineFmKeys(firstLine) < 2) return content

  let fmLineCount = 1
  while (fmLineCount < lines.length) {
    const line = lines[fmLineCount]
    if (line.trim() === "" || /^\s*#/.test(line)) break
    if (countInlineFmKeys(line) >= 2) {
      fmLineCount++
      continue
    }
    if (
      /^\s*(?:type|title|tags|related|created|updated|sources|description|origin)\s*:/i.test(
        line,
      )
    ) {
      fmLineCount++
      continue
    }
    break
  }

  const fmText = lines.slice(0, fmLineCount).join("\n")
  const yamlLines = splitInlineFrontmatterToLines(fmText)
  if (yamlLines.length < 2) return content

  let bodyStart = fmLineCount
  while (bodyStart < lines.length && lines[bodyStart].trim() === "") {
    bodyStart++
  }
  const body = lines.slice(bodyStart).join("\n")

  const fmBlock = `---\n${yamlLines.join("\n")}\n---\n`
  if (!body) return fmBlock.endsWith("\n") ? fmBlock : `${fmBlock}\n`
  return `${fmBlock}\n${body}`
}

function splitInlineFrontmatterToLines(text: string): string[] {
  const out: string[] = []
  for (const line of text.split("\n")) {
    const matches = [...line.matchAll(INLINE_FM_KEY_RE)]
    for (let i = 0; i < matches.length; i++) {
      const key = matches[i][1].toLowerCase()
      const valueStart = matches[i].index! + matches[i][0].length
      const valueEnd = i + 1 < matches.length ? matches[i + 1].index! : line.length
      const value = line.slice(valueStart, valueEnd).trim()
      out.push(`${key}: ${value}`)
    }
  }
  return out
}

/**
 * Inside the frontmatter block (between the opening `---` and the
 * closing `---`), rewrite invalid wikilink-list lines. Lines
 * outside the frontmatter block are left untouched.
 */
function repairWikilinkListsInFrontmatter(content: string): string {
  const fmRe = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*(\r?\n|$)/
  const m = content.match(fmRe)
  if (!m) return content

  const repairedPayload = m[1]
    .split("\n")
    .map((line) => {
      const lm = line.match(
        /^(\s*[A-Za-z_][\w-]*\s*:\s*)(\[\[[^\]]+\]\](?:\s*,\s*\[\[[^\]]+\]\])+)\s*$/,
      )
      if (!lm) return line
      const items = lm[2]
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => `"${s}"`)
        .join(", ")
      return `${lm[1]}[${items}]`
    })
    .join("\n")

  // Replace ONLY the payload between fences; preserve the original
  // fence lines and trailing newline shape.
  return (
    content.slice(0, m.index! + 4) + // up to and including "---\n"
    repairedPayload +
    content.slice(m.index! + 4 + m[1].length)
  )
}

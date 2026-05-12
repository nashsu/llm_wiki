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
 * This sanitizer rewrites all three shapes into the standard
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

  // (3) Repair `key: [[a]], [[b]], [[c]]` lines inside the
  // frontmatter block so they're valid YAML. Body wikilinks are
  // left alone — those render fine via the wikilink → markdown
  // link transform applied at read time.
  cleaned = repairWikilinkListsInFrontmatter(cleaned)

  // (4) Some local models emit the frontmatter payload and closing
  // fence, but forget the opening `---` as the very first line.
  // Repair only when the document starts with a known frontmatter
  // key and has a closing fence before the first heading/body.
  cleaned = addMissingOpeningFrontmatterFence(cleaned)

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

function addMissingOpeningFrontmatterFence(content: string): string {
  if (/^\s*---\s*\r?\n/.test(content)) return content
  if (!/^(type|title|created|updated|tags|related|sources|confidence|last_reviewed)\s*:/i.test(content)) {
    return content
  }

  const headingIndex = content.search(/\r?\n#{1,6}\s+/)
  const fenceIndex = content.search(/\r?\n---\s*(\r?\n|$)/)
  if (fenceIndex < 0) return content
  if (headingIndex >= 0 && fenceIndex > headingIndex) return content

  return `---\n${content}`
}


/**
 * Keep generated index pages out of archive/history mode.
 *
 * The index is part of the ingest bootstrap surface, so model-generated
 * listings that advertise archived, deprecated, or ephemeral pages are
 * prompt-contamination risk. This filter is intentionally narrow: it only
 * removes list/table rows that look like index entries and carry explicit
 * archive/deprecation/ephemeral markers. Policy prose and headings are left
 * intact.
 */
export function sanitizeGeneratedIndexContent(content: string): string {
  const lines = content.split(/\r?\n/)
  let changed = false
  const kept = lines.filter((line) => {
    if (!isIndexListingLine(line)) return true
    if (!hasInactiveIndexMarker(line)) return true
    changed = true
    return false
  })

  if (!changed) return content
  return `${kept.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`
}

function isIndexListingLine(line: string): boolean {
  const trimmed = line.trim()
  return /^[-*]\s+/.test(trimmed) || /^\|.*\|$/.test(trimmed)
}

function hasInactiveIndexMarker(line: string): boolean {
  return /\bretention\s*:\s*(?:ephemeral|archive)\b|\bstate\s*:\s*(?:archived|deprecated)\b|\b(?:archived|deprecated)\b|아카이브|폐기|보관됨/iu.test(line)
}


/**
 * Keep generated overview pages as a current identity snapshot.
 *
 * Overview is part of the bootstrap prompt. Historical taxonomy changes,
 * deprecated direction narratives, and long design-rationale sections can
 * become hidden prompts on the next ingest. This removes only explicit
 * history/deprecation sections or lines; current map prose is preserved.
 */
export function sanitizeGeneratedOverviewContent(content: string): string {
  const lines = content.split(/\r?\n/)
  const kept: string[] = []
  let changed = false
  let skipHeadingLevel: number | null = null

  for (const line of lines) {
    const heading = line.match(/^(#{2,6})\s+(.+)$/)
    if (heading) {
      const level = heading[1].length
      if (skipHeadingLevel !== null && level <= skipHeadingLevel) {
        skipHeadingLevel = null
      }
      if (skipHeadingLevel === null && hasHistoricalOverviewMarker(heading[2])) {
        skipHeadingLevel = level
        changed = true
        continue
      }
    }

    if (skipHeadingLevel !== null) {
      changed = true
      continue
    }

    if (hasHistoricalOverviewMarker(line)) {
      changed = true
      continue
    }
    kept.push(line)
  }

  if (!changed) return content
  return `${kept.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`
}

function hasHistoricalOverviewMarker(line: string): boolean {
  return /전체\s*역사|taxonomy\s+evolution|deprecated\s+direction|오래된\s+design\s+rationale|design\s+rationale|history\s+of\s+the\s+wiki|과거\s*분류|분류\s*진화|이전\s*방향|폐기된\s*방향/iu.test(line)
}

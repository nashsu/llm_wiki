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
 *   4. A frontmatter payload whose opening `---` is missing but whose
 *      closing `---` is present, e.g.
 *
 *          type: entity
 *          title: Foo
 *          ---
 *
 *      — common when the model starts "inside" the YAML block.
 *
 * This sanitizer rewrites these shapes into the standard
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

  // (1) Strip a code fence wrapping the whole document or just its
  // frontmatter block.
  // We only act when the FIRST non-empty line is an opening fence
  // (`\`\`\`yaml`, `\`\`\`md`, `\`\`\`markdown`, or just `\`\`\``)
  // with a matching close either at the end of the document or directly
  // after a complete frontmatter block. This avoids touching pages that
  // legitimately start with an unclosed fence (we don't try to "fix"
  // mid-stream truncation here).
  cleaned = stripOuterCodeFence(cleaned)

  // (2) Strip a stray `frontmatter:` line that prefixes the real
  // `---` block. Some prompts seem to make the model interpret
  // the request as "produce a YAML document with a `frontmatter`
  // key" rather than "produce a markdown document with a
  // frontmatter block".
  cleaned = stripFrontmatterKeyPrefix(cleaned)

  // (2.5) Repair a missing opening frontmatter fence when the model
  // clearly emitted frontmatter lines followed by a closing fence.
  cleaned = addMissingOpeningFrontmatterFence(cleaned)

  // (3) Repair `key: [[a]], [[b]], [[c]]` lines inside the
  // frontmatter block so they're valid YAML. Body wikilinks are
  // left alone — those render fine via the wikilink → markdown
  // link transform applied at read time.
  cleaned = repairWikilinkListsInFrontmatter(cleaned)

  return cleaned
}

/** Top-level fence wrapper. Removes the open + matching close fence lines. */
function stripOuterCodeFence(content: string): string {
  const open = content.match(
    /^(?:\uFEFF)?(?:[ \t]*\r?\n)*[ \t]*```(?:yaml|md|markdown)?[ \t]*\r?\n/i,
  )
  if (!open) return content
  const afterOpen = content.slice(open[0].length)

  // Closing fence: a final ``` on its own line, ignoring trailing
  // whitespace/newlines after it.
  const close = afterOpen.match(/\r?\n[ \t]*```[ \t]*\r?\n?\s*$/)
  if (close) return afterOpen.slice(0, close.index)

  // Some models close the fence immediately after the frontmatter and
  // continue with an unfenced Markdown body. Only strip this shape when
  // the fenced section is exactly a complete `---` frontmatter block.
  const frontmatterOnly = afterOpen.match(
    /^(---[ \t]*\r?\n[\s\S]*?^---[ \t]*\r?\n)[ \t]*```[ \t]*(?:\r?\n|$)/m,
  )
  if (!frontmatterOnly) return content
  return frontmatterOnly[1] + afterOpen.slice(frontmatterOnly[0].length)
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

function addMissingOpeningFrontmatterFence(content: string): string {
  if (/^[ \t]*---\s*(\r?\n|$)/.test(content)) return content

  const lines = content.split(/\r?\n/)
  const firstContentIdx = lines.findIndex((line) => line.trim().length > 0)
  if (firstContentIdx < 0) return content

  const first = lines[firstContentIdx].trim()
  if (!/^(type|title|created|updated|tags|related|sources)\s*:/i.test(first)) {
    return content
  }

  const searchEnd = Math.min(lines.length, firstContentIdx + 30)
  for (let i = firstContentIdx + 1; i < searchEnd; i += 1) {
    const trimmed = lines[i].trim()
    if (trimmed === "---") {
      return `---\n${lines.slice(firstContentIdx).join("\n")}`
    }
    if (/^#{1,6}\s+/.test(trimmed)) break
  }

  return content
}

/**
 * Inside the frontmatter block (between the opening `---` and the
 * closing `---`), rewrite invalid wikilink-list lines. Lines
 * outside the frontmatter block are left untouched.
 */
function repairWikilinkListsInFrontmatter(content: string): string {
  const fmRe = /^(---[ \t]*(\r?\n))([\s\S]*?)(\r?\n---[ \t]*(?:\r?\n|$))/
  const m = content.match(fmRe)
  if (!m) return content

  const repairedPayload = m[3]
    .split(/\r?\n/)
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
    .join(m[2])

  // Rebuild from captured delimiters instead of assuming the opening fence is
  // four bytes. Windows CRLF makes `---\r\n` five bytes, and hard-coded offsets
  // corrupt both the opening fence and the payload boundary.
  return m[1] + repairedPayload + m[4] + content.slice(m[0].length)
}

/**
 * Frontmatter array-field merging during ingest.
 *
 * Originally written for the `sources:` field alone — re-ingesting a
 * page from a second source would clobber `sources: [...]` to a
 * single entry, and the source-delete flow would later treat the page
 * as single-sourced and delete it (silent data loss). The fix unions
 * old and new sources before writing.
 *
 * Generalized to handle any frontmatter array field (`sources`,
 * `tags`, `related`, …): the same loss-on-clobber pattern applied to
 * `tags` and `related` too — old contributing tags / wikilinks
 * disappeared every time a different source brought new ones. The
 * generic API merges any subset of fields the caller names.
 *
 * Two callers today:
 *   - sources-view.tsx — uses `parseSources` / `writeSources` for
 *     the source-delete flow (operates on the single sources field)
 *   - ingest.ts — uses `mergeArrayFieldsIntoContent` to union
 *     sources + tags + related when writing a content page that
 *     already exists on disk
 */

// ─── Generic helpers (the implementation core) ────────────────────

/**
 * Extract a frontmatter array field by name. Handles both:
 *   inline form:    `name: ["a", "b"]` or `name: [a, b]`
 *   block form:     `name:\n  - a\n  - b`
 * Strips quotes (single or double) from items. Returns `[]` for
 * missing field, malformed parse, or content with no frontmatter.
 *
 * The field name is matched as a whole word at line start, so
 * `parseFrontmatterArray(c, "rel")` won't match `related: [...]`.
 */
export function parseFrontmatterArray(content: string, fieldName: string): string[] {
  const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!fmMatch) return []
  const fm = fmMatch[1]
  // Anchor to start of line + exact field name + colon. The negative
  // lookahead-style check is done by requiring `:` immediately after.
  const escapedName = fieldName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const blockRe = new RegExp(
    `^${escapedName}:\\s*\\r?\\n((?:[ \\t]+-\\s+.+(?:\\r?\\n|$))+)`,
    "m",
  )
  const block = fm.match(blockRe)
  if (block) {
    const out: string[] = []
    for (const line of block[1].split(/\r?\n/)) {
      const m = line.match(/^\s+-\s+["']?(.+?)["']?\s*$/)
      if (m && m[1]) out.push(m[1].trim())
    }
    return out
  }

  const inlineRe = new RegExp(`^${escapedName}:\\s*\\[`, "m")
  const inline = fm.match(inlineRe)
  if (!inline) return []
  const body = scanInlineArrayBody(fm, inline.index! + inline[0].length)
  if (!body || body.trim() === "") return []
  return splitInlineArray(body)
}

/**
 * Extract an inline array body between a `[` and its matching `]`,
 * quote-aware: a `]` inside a quoted value (e.g. a filename like
 * `[202603251545]标题.html`) does not close the array. Scans a single
 * line only — an unterminated array is treated as malformed and
 * returns null. `start` points just past the opening `[`.
 */
function scanInlineArrayBody(text: string, start: number): string | null {
  let quote: "\"" | "'" | null = null
  let escaped = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (ch === "\n" || ch === "\r") return null
    if (escaped) {
      escaped = false
      continue
    }
    if (quote === "\"" && ch === "\\") {
      escaped = true
      continue
    }
    if (quote === null && (ch === "\"" || ch === "'")) {
      quote = ch
      continue
    }
    if (quote !== null && ch === quote) {
      quote = null
      continue
    }
    if (quote === null && ch === "]") return text.slice(start, i)
  }
  return null
}

function splitInlineArray(body: string): string[] {
  const out: string[] = []
  let current = ""
  let quote: "\"" | "'" | null = null
  let escaped = false

  for (const ch of body) {
    if (escaped) {
      current += ch
      escaped = false
      continue
    }
    if (quote === "\"" && ch === "\\") {
      escaped = true
      continue
    }
    if ((ch === "\"" || ch === "'") && quote === null) {
      quote = ch
      continue
    }
    if (quote === ch) {
      quote = null
      continue
    }
    if (ch === "," && quote === null) {
      const value = current.trim()
      if (value) out.push(value)
      current = ""
      continue
    }
    current += ch
  }

  const value = current.trim()
  if (value) out.push(value)
  return out
}

/**
 * Rewrite (or insert) a frontmatter array field. Preserves all other
 * frontmatter lines and order. Returns content unchanged if the
 * input has no frontmatter at all (don't manufacture frontmatter for
 * unconventional pages — almost certainly malformed emission worth
 * surfacing rather than silently fixing).
 *
 * Always emits the inline form `name: ["a", "b"]` so downstream
 * parsers see a consistent shape regardless of the original input
 * shape.
 */
export function writeFrontmatterArray(
  content: string,
  fieldName: string,
  values: string[],
): string {
  const fmMatch = content.match(/^(---\r?\n)([\s\S]*?)(\r?\n---)/)
  if (!fmMatch) return content

  const [, openDelim, fmBody, closeDelim] = fmMatch
  const newline = openDelim.endsWith("\r\n") ? "\r\n" : "\n"
  const escapedName = fieldName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const serialized = values.map(quoteInlineArrayValue).join(", ")
  const newLine = `${fieldName}: [${serialized}]`

  // Replace inline form in place — preserves field ordering. Match
  // through the array's *closing* `]` with the quote-aware scanner so
  // values containing `]` (e.g. `[202603251545]标题.html` filenames)
  // don't leave a trailing tail behind the replacement.
  const inlineStartRe = new RegExp(`^${escapedName}:\\s*\\[`, "m")
  const inlineStart = fmBody.match(inlineStartRe)
  if (inlineStart) {
    const arrayStart = inlineStart.index! + inlineStart[0].length
    const body = scanInlineArrayBody(fmBody, arrayStart)
    if (body !== null) {
      const arrayEnd = arrayStart + body.length + 1 // past the closing `]`
      const lineStart = inlineStart.index!
      // Replace from line start so a malformed prefix (`sources:  [`) normalizes too.
      const rewritten =
        fmBody.slice(0, lineStart) + newLine + fmBody.slice(arrayEnd)
      return `${openDelim}${rewritten}${closeDelim}${content.slice(fmMatch[0].length)}`
    }
    // Unterminated inline array — fall through and replace the whole
    // matched line prefix (treat as malformed emission).
    const rewritten = fmBody.replace(
      new RegExp(`^${escapedName}:\\s*\\[[^\\r\\n]*`, "m"),
      newLine,
    )
    return `${openDelim}${rewritten}${closeDelim}${content.slice(fmMatch[0].length)}`
  }

  // Replace block form in place, normalized to inline form.
  const blockRe = new RegExp(
    `^${escapedName}:\\s*\\r?\\n((?:[ \\t]+-\\s+.+(?:\\r?\\n|$))+)`,
    "m",
  )
  if (blockRe.test(fmBody)) {
    const rewritten = fmBody.replace(blockRe, (matched) =>
      `${newLine}${/\r?\n$/.test(matched) ? newline : ""}`,
    )
    return `${openDelim}${rewritten}${closeDelim}${content.slice(fmMatch[0].length)}`
  }

  // Field absent — append at end of frontmatter.
  const rewritten = `${fmBody}${newline}${newLine}`
  return `${openDelim}${rewritten}${closeDelim}${content.slice(fmMatch[0].length)}`
}

function quoteInlineArrayValue(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
}

/**
 * Union-merge two array values. Case-insensitive dedup. First-seen
 * casing wins (matches sources-merge's historical contract — keeps
 * users' original filename casing stable across re-ingests).
 */
function mergeLists(
  existing: readonly string[],
  incoming: readonly string[],
): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const s of [...existing, ...incoming]) {
    const key = s.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(s)
  }
  return out
}

/**
 * Multi-field merge entry point. For each requested field, union the
 * existing-on-disk value with the LLM-emitted new value, and rewrite
 * the new content's frontmatter with the merged values.
 *
 * Fast-paths:
 *   - existingContent null/empty → return newContent verbatim
 *   - existing has no frontmatter at all → return newContent verbatim
 *   - no field actually changes → return newContent verbatim (stable
 *     reference, callers can rely on this for cache-key invariance)
 */
export function mergeArrayFieldsIntoContent(
  newContent: string,
  existingContent: string | null,
  fields: readonly string[],
): string {
  if (!existingContent) return newContent
  if (!/^---\r?\n/.test(existingContent)) return newContent

  let result = newContent
  let changed = false
  for (const field of fields) {
    const oldValues = parseFrontmatterArray(existingContent, field)
    if (oldValues.length === 0) continue // field absent in existing → nothing to preserve
    const newValues = parseFrontmatterArray(result, field)
    const merged = mergeLists(oldValues, newValues)
    if (
      merged.length === newValues.length &&
      merged.every((s, i) => s === newValues[i])
    ) {
      continue // no-op for this field
    }
    result = writeFrontmatterArray(result, field, merged)
    changed = true
  }
  return changed ? result : newContent
}

// ─── Backward-compatible single-field exports ─────────────────────

/**
 * Extract `sources: [...]` from a wiki page's frontmatter.
 * Handles inline and block forms; strips quotes; returns [] when
 * absent. Thin wrapper around the generic parser, kept stable for
 * sources-view.tsx (source-delete flow).
 */
export function parseSources(content: string): string[] {
  return parseFrontmatterArray(content, "sources")
}

/**
 * Rewrite the `sources:` field. Thin wrapper around the generic
 * writer, kept stable for sources-view.tsx (writes the post-delete
 * sources list back).
 */
export function writeSources(content: string, sources: string[]): string {
  return writeFrontmatterArray(content, "sources", sources)
}

/**
 * Merge two source lists into one (case-insensitive dedup, first-
 * seen casing wins). Exported for tests and sources-view consumers
 * that prefer to call the merge directly without going through the
 * content-rewrite path.
 */
export function mergeSourcesLists(
  existing: readonly string[],
  incoming: readonly string[],
): string[] {
  return mergeLists(existing, incoming)
}

/**
 * Sources-only convenience wrapper — equivalent to
 * `mergeArrayFieldsIntoContent(newContent, existingContent, ["sources"])`.
 * Kept for ingest-flow callers that pre-date the multi-field
 * generalization; new code should prefer the generic version which
 * also unions tags / related.
 */
export function mergeSourcesIntoContent(
  newContent: string,
  existingContent: string | null,
): string {
  return mergeArrayFieldsIntoContent(newContent, existingContent, ["sources"])
}

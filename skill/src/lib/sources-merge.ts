/**
 * Frontmatter array-field merging during ingest.
 * Ported from nashsu/llm_wiki — pure functions.
 */

export function parseFrontmatterArray(content: string, fieldName: string): string[] {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/)
  if (!fmMatch) return []
  const fm = fmMatch[1]
  const escapedName = fieldName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

  const blockRe = new RegExp(`^${escapedName}:\\s*\\n((?:[ \\t]+-\\s+.+\\n?)+)`, "m")
  const block = fm.match(blockRe)
  if (block) {
    const out: string[] = []
    for (const line of block[1].split("\n")) {
      const m = line.match(/^\s+-\s+["']?(.+?)["']?\s*$/)
      if (m && m[1]) out.push(m[1].trim())
    }
    return out
  }

  const inlineRe = new RegExp(`^${escapedName}:\\s*\\[([^\\]]*)\\]`, "m")
  const inline = fm.match(inlineRe)
  if (!inline) return []
  const body = inline[1].trim()
  if (body === "") return []
  return body.split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter((s) => s.length > 0)
}

export function writeFrontmatterArray(content: string, fieldName: string, values: string[]): string {
  const fmMatch = content.match(/^(---\n)([\s\S]*?)(\n---)/)
  if (!fmMatch) return content
  const [, openDelim, fmBody, closeDelim] = fmMatch
  const escapedName = fieldName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const serialized = values.map((s) => `"${s}"`).join(", ")
  const newLine = `${fieldName}: [${serialized}]`

  const inlineRe = new RegExp(`^${escapedName}:\\s*\\[[^\\]]*\\]`, "m")
  if (inlineRe.test(fmBody)) {
    return `${openDelim}${fmBody.replace(inlineRe, newLine)}${closeDelim}${content.slice(fmMatch[0].length)}`
  }

  const blockRe = new RegExp(`^${escapedName}:\\s*\\n((?:[ \\t]+-\\s+.+\\n?)+)`, "m")
  if (blockRe.test(fmBody)) {
    return `${openDelim}${fmBody.replace(blockRe, newLine)}${closeDelim}${content.slice(fmMatch[0].length)}`
  }

  return `${openDelim}${fmBody}\n${newLine}${closeDelim}${content.slice(fmMatch[0].length)}`
}

function mergeLists(existing: readonly string[], incoming: readonly string[]): string[] {
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

export function mergeArrayFieldsIntoContent(newContent: string, existingContent: string | null, fields: readonly string[]): string {
  if (!existingContent) return newContent
  if (!/^---\n/.test(existingContent)) return newContent

  let result = newContent
  let changed = false
  for (const field of fields) {
    const oldValues = parseFrontmatterArray(existingContent, field)
    if (oldValues.length === 0) continue
    const newValues = parseFrontmatterArray(result, field)
    const merged = mergeLists(oldValues, newValues)
    if (merged.length === newValues.length && merged.every((s, i) => s === newValues[i])) continue
    result = writeFrontmatterArray(result, field, merged)
    changed = true
  }
  return changed ? result : newContent
}

/**
 * Models occasionally wrap an otherwise valid replacement in one Markdown
 * fence. Strip only that complete outer fence; partial or embedded fences are
 * user content and must remain untouched.
 */
export function normalizeSelectionReplacement(content: string): string {
  const trimmed = content.trim()
  const fenced = trimmed.match(/^```[^\n]*\n([\s\S]*?)\n```$/)
  return fenced ? fenced[1] : content
}

export interface TextSelectionSnapshot {
  prefix: string
  selectedText: string
  suffix: string
}

/**
 * Resolve rendered text back to one unambiguous Markdown source range. Browser
 * rendering can collapse line breaks and repeated spaces, so a whitespace-
 * flexible fallback is allowed. Ambiguous matches are rejected because an edit
 * action must never guess which occurrence the user selected.
 */
export function findUniqueTextSelection(
  markdown: string,
  renderedSelection: string,
): TextSelectionSnapshot | null {
  const selected = renderedSelection.trim()
  if (!selected) return null

  const exactStart = markdown.indexOf(selected)
  if (exactStart >= 0 && markdown.indexOf(selected, exactStart + selected.length) < 0) {
    return snapshot(markdown, exactStart, exactStart + selected.length)
  }

  const tokens = selected.split(/\s+/u).filter(Boolean)
  if (tokens.length < 2) return null
  const pattern = tokens.map(escapeRegExp).join("\\s+")
  const matches = [...markdown.matchAll(new RegExp(pattern, "gu"))]
  if (matches.length !== 1 || matches[0].index === undefined) return null
  const start = matches[0].index
  return snapshot(markdown, start, start + matches[0][0].length)
}

/**
 * Resolve a browser Range through source-position attributes emitted by the
 * Markdown renderer. The renderer narrows each endpoint to its source block;
 * walking text nodes in DOM order then disambiguates repeated text without
 * relying on a project-wide string match.
 */
export function findDomTextSelection(
  markdown: string,
  selection: Selection,
  root: HTMLElement,
): TextSelectionSnapshot | null {
  if (selection.rangeCount === 0 || selection.isCollapsed) return null
  const range = selection.getRangeAt(0)
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null
  const start = domPointToSourceOffset(markdown, range.startContainer, range.startOffset, root)
  const end = domPointToSourceOffset(markdown, range.endContainer, range.endOffset, root)
  if (start === null || end === null || start >= end) return null
  return snapshot(markdown, start, end)
}

function domPointToSourceOffset(
  markdown: string,
  container: Node,
  offset: number,
  root: HTMLElement,
): number | null {
  const textPoint = normalizeToTextPoint(container, offset)
  if (!textPoint) return null
  const [target, targetOffset] = textPoint
  const parent = target.parentElement?.closest<HTMLElement>("[data-source-start][data-source-end]")
  if (!parent || !root.contains(parent)) return null
  const start = Number(parent.dataset.sourceStart)
  const end = Number(parent.dataset.sourceEnd)
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end > markdown.length || start >= end) return null

  const walker = document.createTreeWalker(parent, NodeFilter.SHOW_TEXT)
  let cursor = start
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const value = node.nodeValue ?? ""
    if (!value) continue
    const match = findTextFrom(markdown, value, cursor, end)
    if (!match) continue
    if (node === target) return Math.min(match.start + targetOffset, match.end)
    cursor = match.end
  }
  return null
}

function normalizeToTextPoint(container: Node, offset: number): [Text, number] | null {
  if (container.nodeType === Node.TEXT_NODE) {
    const text = container as Text
    return [text, Math.min(offset, text.data.length)]
  }
  const element = container as Element
  const child = element.childNodes[Math.min(offset, element.childNodes.length - 1)]
  if (!child) return null
  const walker = document.createTreeWalker(child, NodeFilter.SHOW_TEXT)
  const text = child.nodeType === Node.TEXT_NODE ? child as Text : walker.nextNode() as Text | null
  return text ? [text, 0] : null
}

function findTextFrom(markdown: string, value: string, from: number, to: number): { start: number; end: number } | null {
  const exact = markdown.indexOf(value, from)
  if (exact >= from && exact + value.length <= to) return { start: exact, end: exact + value.length }
  const tokens = value.trim().split(/\s+/u).filter(Boolean)
  if (tokens.length === 0) return null
  const match = new RegExp(tokens.map(escapeRegExp).join("\\s+"), "u").exec(markdown.slice(from, to))
  if (!match?.[0]) return null
  return { start: from + match.index, end: from + match.index + match[0].length }
}

function snapshot(markdown: string, start: number, end: number): TextSelectionSnapshot {
  return {
    prefix: markdown.slice(0, start),
    selectedText: markdown.slice(start, end),
    suffix: markdown.slice(end),
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

import remarkGfm from "remark-gfm"
import remarkParse from "remark-parse"
import { unified } from "unified"
import type { LinkEntry } from "./auto-link-types"

interface SourcePoint {
  offset?: number
}

interface SourcePosition {
  start: SourcePoint
  end: SourcePoint
}

interface MarkdownNode {
  type: string
  children?: MarkdownNode[]
  position?: SourcePosition
}

interface SourceRange {
  start: number
  end: number
}

interface WikilinkEdit extends SourceRange {
  replacement: string
}

interface TargetTermGroup {
  target: string
  terms: string[]
}

const BLOCKED_NODE_TYPES = new Set([
  "code",
  "definition",
  "html",
  "image",
  "imageReference",
  "inlineCode",
  "link",
  "linkReference",
])

export function insertWikilinksInMarkdown(
  markdown: string,
  links: LinkEntry[],
): string {
  const edits = planWikilinkEdits(markdown, links)
  if (edits.length === 0) return markdown

  let result = markdown
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    result = result.slice(0, edit.start) + edit.replacement + result.slice(edit.end)
  }
  return result
}

function planWikilinkEdits(
  markdown: string,
  links: LinkEntry[],
): WikilinkEdit[] {
  const linkableRanges = collectLinkableTextRanges(markdown)
  if (linkableRanges.length === 0) return []

  const wikilinkRanges = collectExistingWikilinkRanges(markdown)
  const edits: WikilinkEdit[] = []
  const targetGroups = groupTermsByTarget(links).sort(
    (left, right) => longestTermLength(right) - longestTermLength(left),
  )

  for (const { target, terms } of targetGroups) {
    const occurrence = findBestGroupOccurrence(
      markdown,
      terms,
      linkableRanges,
      wikilinkRanges,
      edits,
    )
    if (!occurrence) continue

    edits.push({
      start: occurrence.start,
      end: occurrence.start + occurrence.term.length,
      replacement: occurrence.term.toLowerCase() === target.toLowerCase()
        ? `[[${occurrence.term}]]`
        : `[[${target}|${occurrence.term}]]`,
    })
  }

  return edits
}

function groupTermsByTarget(links: LinkEntry[]): TargetTermGroup[] {
  const groups = new Map<string, TargetTermGroup>()
  for (const link of links) {
    if (!link.target) continue
    const terms = [link.term, ...(link.alternativeTerms ?? [])].filter(Boolean)
    if (terms.length === 0) continue
    const key = link.target.toLowerCase()
    const group = groups.get(key)
    if (group) {
      for (const term of terms) {
        if (!group.terms.includes(term)) group.terms.push(term)
      }
    } else {
      groups.set(key, { target: link.target, terms: [...new Set(terms)] })
    }
  }
  return [...groups.values()]
}

function longestTermLength(group: TargetTermGroup): number {
  return Math.max(...group.terms.map((term) => term.length))
}

function findBestGroupOccurrence(
  markdown: string,
  terms: string[],
  linkableRanges: SourceRange[],
  protectedRanges: SourceRange[],
  plannedEdits: SourceRange[],
): { start: number; term: string } | null {
  const occurrences = terms.flatMap((term) => {
    const start = findLinkableOccurrence(
      markdown,
      term,
      linkableRanges,
      protectedRanges,
      plannedEdits,
    )
    return start === -1 ? [] : [{ start, term }]
  })
  occurrences.sort(
    (left, right) => left.start - right.start || right.term.length - left.term.length,
  )
  return occurrences[0] ?? null
}

function collectLinkableTextRanges(markdown: string): SourceRange[] {
  let tree: MarkdownNode
  try {
    tree = unified().use(remarkParse).use(remarkGfm).parse(markdown) as MarkdownNode
  } catch {
    return []
  }

  const ranges: SourceRange[] = []
  const visit = (node: MarkdownNode, blocked: boolean) => {
    const blocksChildren =
      blocked ||
      BLOCKED_NODE_TYPES.has(node.type) ||
      Boolean(
        node.type !== "root" &&
        node.children?.some((child) => child.type === "html"),
      )

    if (node.type === "text" && !blocksChildren) {
      const start = node.position?.start.offset
      const end = node.position?.end.offset
      if (typeof start === "number" && typeof end === "number" && end > start) {
        ranges.push({ start, end })
      }
      return
    }

    for (const child of node.children ?? []) visit(child, blocksChildren)
  }
  visit(tree, false)
  return ranges
}

function collectExistingWikilinkRanges(markdown: string): SourceRange[] {
  const ranges: SourceRange[] = []
  let index = 0
  while (index < markdown.length - 1) {
    if (markdown[index] !== "[" || markdown[index + 1] !== "[") {
      index++
      continue
    }

    let close = index + 2
    while (close < markdown.length - 1) {
      if (markdown[close] === "]" && markdown[close + 1] === "]") {
        ranges.push({ start: index, end: close + 2 })
        index = close + 2
        break
      }
      close++
    }
    if (close >= markdown.length - 1) index += 2
  }
  return ranges
}

function findLinkableOccurrence(
  markdown: string,
  term: string,
  linkableRanges: SourceRange[],
  protectedRanges: SourceRange[],
  plannedEdits: SourceRange[],
): number {
  let searchFrom = 0
  while (searchFrom < markdown.length) {
    const start = markdown.indexOf(term, searchFrom)
    if (start === -1) return -1
    const end = start + term.length
    const insideTextNode = linkableRanges.some(
      (range) => start >= range.start && end <= range.end,
    )
    const overlapsProtected = protectedRanges.some(
      (range) => rangesOverlap({ start, end }, range),
    )
    const overlapsPlanned = plannedEdits.some(
      (range) => rangesOverlap({ start, end }, range),
    )
    if (insideTextNode && !overlapsProtected && !overlapsPlanned) return start
    searchFrom = start + 1
  }
  return -1
}

function rangesOverlap(left: SourceRange, right: SourceRange): boolean {
  return left.start < right.end && left.end > right.start
}

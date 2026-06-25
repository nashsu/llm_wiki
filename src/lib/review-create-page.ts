import type { ReviewItem } from "@/stores/review-store"

export type ReviewPageType = "entity" | "concept" | "comparison" | "synthesis" | "query"

export interface ReviewPageDraft {
  title: string
  pageType: ReviewPageType
  dir: string
}

const ACTION_PREFIX_RE = /^(Create|Save|Add|Missing page|Missing pages|缺失页面|缺少页面|创建|保存|新增)[:：\s-]*/i
const ENTITY_RE = /\b(entity|entities)\b|实体/i
const CONCEPT_RE = /\b(concept|concepts)\b|概念/i

function cleanCandidateTitle(value: string): string {
  return value
    .replace(ACTION_PREFIX_RE, "")
    .replace(/^(missing|缺失|缺少)\s*/i, "")
    .replace(/\s*(page|pages|页面|页)\s*$/i, "")
    .replace(/\s*(entity|entities|concept|concepts|实体|概念)\s*(page|pages|页面|页)?\s*$/i, "")
    .replace(/^[\s"'“”‘’`[\]【】()（）]+|[\s"'“”‘’`[\]【】()（）:：.。]+$/g, "")
    .trim()
}

function splitCandidateList(value: string): string[] {
  return value
    .replace(/\band\b/gi, ",")
    .replace(/\s+和\s+/g, ",")
    .split(/[,，、;；\n]+/)
    .map(cleanCandidateTitle)
    .filter((title) => title.length > 0)
}

function extractMissingPageCandidates(text: string): string[] {
  const candidates: string[] = []
  const segments = text
    .split(/[\n。]+/)
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter(Boolean)

  for (const segment of segments) {
    const colonTail = segment.match(/[:：]\s*(.+)$/)?.[1]
    if (colonTail) candidates.push(...splitCandidateList(colonTail))

    const chineseMissing = segment.match(/(?:缺少|缺失|未创建|没有)\s*([^；;]+?)(?:等)?\s*(?:实体|概念)?\s*(?:页面|页)(?:缺失|不存在|未创建)?/i)
    if (chineseMissing?.[1]) candidates.push(...splitCandidateList(chineseMissing[1]))

    const englishMissing = segment.match(/missing\s+(?:entity|entities|concept|concepts|page|pages)?\s*([^.;]+?)(?:\s+pages?|\s+entities?|\s+concepts?)?$/i)
    if (englishMissing?.[1]) candidates.push(...splitCandidateList(englishMissing[1]))
  }

  if (candidates.length === 0) candidates.push(cleanCandidateTitle(segments[0] ?? "") || "Untitled")

  return Array.from(new Set(candidates))
}

function detectPageType(action: string, reviewType: ReviewItem["type"], text: string): ReviewPageType {
  const combined = `${action}\n${text}`
  if (ENTITY_RE.test(combined)) return "entity"
  if (CONCEPT_RE.test(combined)) return "concept"
  if (/comparison|compare|比较/i.test(combined)) return "comparison"
  if (/synthesis|综合/i.test(combined)) return "synthesis"
  if (reviewType === "missing-page") return "concept"
  if (reviewType === "contradiction") return "query"
  if (reviewType === "suggestion") return "query"
  return "query"
}

function dirForPageType(pageType: ReviewPageType): string {
  switch (pageType) {
    case "entity":
      return "entities"
    case "concept":
      return "concepts"
    case "comparison":
      return "comparisons"
    case "synthesis":
      return "synthesis"
    case "query":
    default:
      return "queries"
  }
}

export function createReviewPageDrafts(item: ReviewItem, action: string): ReviewPageDraft[] {
  const text = `${item.title}\n${item.description}`
  const pageType = detectPageType(action, item.type, text)
  const titles = item.type === "missing-page"
    ? extractMissingPageCandidates(text)
    : [cleanCandidateTitle(item.title) || "Untitled"]

  return titles.map((title) => ({
    title,
    pageType,
    dir: dirForPageType(pageType),
  }))
}

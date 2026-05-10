import type { WebSearchResult } from "@/lib/web-search"
import { makeQuerySlug } from "@/lib/wiki-filename"
import {
  buildResearchQueryFileName,
  canonicalizeWikiTitle,
} from "@/lib/wiki-title"

export type ResearchArtifactType = "query" | "synthesis" | "comparison"

export interface ResearchArtifactClassification {
  type: ResearchArtifactType
  reason: string
}

export interface ResearchSavePlan {
  date: string
  queryRecordPath: string
  queryRecordFileName: string
  primaryPath: string
  primaryFileName: string
  primaryType: ResearchArtifactType
  title: string
  related: string[]
  classificationReason: string
}

export const RESEARCH_REQUIRED_DIRS = [
  "wiki/queries",
  "wiki/synthesis",
  "wiki/comparisons",
  "wiki/sources",
  "wiki/entities",
  "wiki/concepts",
]

const COMPARISON_RE = /\b(vs\.?|versus|compare[sd]?|comparison|trade-?off)\b|비교|대비|차이|장단점|선택\s*기준/iu
const COMPARISON_TOPIC_RE = /\b(vs\.?|versus|compare|comparison|trade-?off)\b|비교(?:\s*분석|\s*해|\s*해줘|\s*정리|\s*표)?|대비|차이|장단점|선택\s*기준/iu
const SYNTHESIS_RE = /종합|결론|운영\s*모델|모델|프레임워크|가이드|정리|요약|핵심|전략|workflow|워크플로|방법론|architecture|overview|synthesis/iu
const OPEN_QUERY_RE = /추가\s*조사|열린\s*질문|미해결|알아봐|찾아봐|조사해줘|무엇인가|어떻게|왜|여부|가능한가|\?/iu

export function getResearchArtifactLabel(type: ResearchArtifactType | null | undefined): string {
  if (type === "comparison") return "Comparison"
  if (type === "synthesis") return "Synthesis"
  return "Query"
}

export function cleanResearchSynthesis(text: string): string {
  return stripLooseLeadingMetadata(stripLeadingFrontmatter(stripThinkingBlocks(text))).trimStart()
}

export function stripThinkingBlocks(text: string): string {
  return text
    .replace(/<think(?:ing)?>\s*[\s\S]*?<\/think(?:ing)?>\s*/gi, "")
    .replace(/<think(?:ing)?>\s*[\s\S]*$/gi, "")
}

export function stripLeadingFrontmatter(text: string): string {
  return text.replace(/^\s*---\s*\n[\s\S]*?\n---\s*\n?/, "")
}

export function stripLooseLeadingMetadata(text: string): string {
  const trimmed = text.trimStart()
  if (!/^title:\s+/i.test(trimmed)) return text

  const headingIndex = trimmed.search(/\n#\s+/)
  if (headingIndex >= 0 && headingIndex < 1200) {
    return trimmed.slice(headingIndex + 1)
  }

  const blankIndex = trimmed.search(/\n\s*\n/)
  if (blankIndex >= 0 && blankIndex < 1200) {
    return trimmed.slice(blankIndex).trimStart()
  }

  return text
}

export function extractResearchTitle(topic: string, synthesis: string): string {
  const yamlTitle = synthesis.match(/^\s*---\s*\n[\s\S]*?^title:\s*["']?(.+?)["']?\s*$/im)?.[1]?.trim()
  if (yamlTitle) return canonicalizeWikiTitle(yamlTitle.replace(/^["']|["']$/g, "").trim(), topic)

  const headingTitle = stripThinkingBlocks(synthesis).match(/^#\s+(.+?)\s*$/m)?.[1]?.trim()
  if (headingTitle) return canonicalizeWikiTitle(headingTitle, topic)

  return canonicalizeWikiTitle(topic.trim(), "Deep Research")
}

export function classifyResearchArtifact(args: {
  topic: string
  synthesis: string
  webResults: WebSearchResult[]
}): ResearchArtifactClassification {
  const haystack = `${args.topic}\n${args.synthesis}`
  if (isComparisonTopic(args.topic) || hasComparisonTable(args.synthesis)) {
    return { type: "comparison", reason: "comparison signals found in topic or result" }
  }

  const hasMultipleSources = args.webResults.length >= 2
  const hasSynthesisSignal = SYNTHESIS_RE.test(haystack)
  const isOpenQuestion = OPEN_QUERY_RE.test(args.topic) && !hasSynthesisSignal

  if (hasMultipleSources && (hasSynthesisSignal || !isOpenQuestion)) {
    return { type: "synthesis", reason: "multi-source reusable synthesis" }
  }

  return { type: "query", reason: "open research question or insufficient synthesis signals" }
}

function isComparisonTopic(topic: string): boolean {
  return COMPARISON_TOPIC_RE.test(topic)
}

export function buildResearchSavePlan(args: {
  topic: string
  synthesis: string
  webResults: WebSearchResult[]
  now?: Date
}): ResearchSavePlan {
  const now = args.now ?? new Date()
  const iso = now.toISOString()
  const date = iso.slice(0, 10)
  const time = iso.slice(11, 19).replace(/:/g, "")
  const title = extractResearchTitle(args.topic, args.synthesis)
  const titleSlug = makeQuerySlug(title)
  const queryRecordFileName = buildResearchQueryFileName(title, date, time)
  const classification = classifyResearchArtifact(args)
  const primaryFolder = classification.type === "comparison"
    ? "comparisons"
    : classification.type === "synthesis"
      ? "synthesis"
      : "queries"
  const primaryFileName = classification.type === "query"
    ? queryRecordFileName
    : `${titleSlug}.md`

  return {
    date,
    queryRecordPath: `wiki/queries/${queryRecordFileName}`,
    queryRecordFileName,
    primaryPath: `wiki/${primaryFolder}/${primaryFileName}`,
    primaryFileName,
    primaryType: classification.type,
    title,
    related: extractRelatedSlugs(args.synthesis),
    classificationReason: classification.reason,
  }
}

export function buildResearchRecordPage(args: {
  topic: string
  title: string
  date: string
  content: string
  references: string
}): string {
  const body = stripLeadingHeading(args.content)
  const title = canonicalizeWikiTitle(args.title, args.topic.trim() || "Deep Research")
  const sourceCount = countReferences(args.references)
  return [
    "---",
    "type: query",
    `title: "${escapeYaml(title)}"`,
    `created: ${args.date}`,
    `updated: ${args.date}`,
    "origin: deep-research",
    `original_query: "${escapeYaml(args.topic.trim())}"`,
    "tags: [research]",
    "related: []",
    "sources: []",
    "confidence: medium",
    `last_reviewed: ${args.date}`,
    "quality: draft",
    "coverage: medium",
    "needs_upgrade: true",
    "freshness_required: true",
    `source_count: ${sourceCount}`,
    "---",
    "",
    `# ${title}`,
    "",
    "## Original Query",
    "",
    args.topic,
    "",
    body,
    "",
    "## Evidence / Source Trace",
    "",
    "This query record is grounded in the web results listed in References. Treat snippets and search-result summaries as currentness signals, not as canonical source text.",
    "",
    "## Verification & Freshness",
    "",
    "External facts, product status, pricing, API behavior, release dates, and benchmark claims should remain reviewable unless confirmed by the cited primary source.",
    "",
    "## Reuse / Upgrade Decision",
    "",
    "Keep this page as a query record until the findings are promoted into a concept, entity, comparison, or synthesis page with durable source trace.",
    "",
    "## References",
    "",
    args.references,
    "",
  ].join("\n")
}

export function buildPrimaryResearchPage(args: {
  type: ResearchArtifactType
  title: string
  date: string
  content: string
  queryRecordFileName: string
  references: string
  related: string[]
}): string {
  const body = stripLeadingHeading(args.content)
  const sourceCount = countReferences(args.references)
  const tags = args.type === "comparison"
    ? "[research, comparison]"
    : args.type === "synthesis"
      ? "[research, synthesis]"
      : "[research]"

  return [
    "---",
    `type: ${args.type}`,
    `title: "${escapeYaml(args.title)}"`,
    `created: ${args.date}`,
    `updated: ${args.date}`,
    tags ? `tags: ${tags}` : "tags: []",
    `related: [${args.related.join(", ")}]`,
    `sources: ["${escapeYaml(args.queryRecordFileName)}"]`,
    "confidence: medium",
    `last_reviewed: ${args.date}`,
    "quality: draft",
    "coverage: medium",
    "needs_upgrade: true",
    "freshness_required: true",
    `source_count: ${sourceCount}`,
    "---",
    "",
    `# ${args.title}`,
    "",
    body,
    "",
    "## Evidence / Source Trace",
    "",
    `This page is derived from the linked Deep Research query record: \`${args.queryRecordFileName}\`. Use the References below for source trace and keep search-result snippets separate from confirmed source claims.`,
    "",
    "## Verification & Freshness",
    "",
    "Current or fast-changing claims should be rechecked against primary sources before this page is marked reviewed or canonical.",
    "",
    "## Reuse / Upgrade Decision",
    "",
    "Promote this page only after the durable operating pattern, limits, and source-backed claims are separated from one-off search findings.",
    "",
    "## References",
    "",
    args.references,
    "",
  ].join("\n")
}

function countReferences(references: string): number {
  const numbered = references
    .split("\n")
    .filter((line) => /^\s*\d+\.\s+/.test(line))
    .length
  return Math.max(1, numbered)
}

function hasComparisonTable(text: string): boolean {
  const lines = text.split("\n")
  for (let i = 0; i < lines.length - 1; i++) {
    if (!lines[i].includes("|") || !lines[i + 1].includes("|")) continue
    if (/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(lines[i + 1])) {
      const window = lines.slice(Math.max(0, i - 4), Math.min(lines.length, i + 10)).join("\n")
      if (COMPARISON_RE.test(window)) return true
    }
  }
  return false
}

function extractRelatedSlugs(text: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const re = /\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g
  let match: RegExpExecArray | null
  while ((match = re.exec(text)) && out.length < 12) {
    const slug = makeQuerySlug(match[1].trim())
    if (!seen.has(slug)) {
      seen.add(slug)
      out.push(slug)
    }
  }
  return out
}

function stripLeadingHeading(text: string): string {
  return text.replace(/^\s*#\s+.+?\s*\n+/, "").trimStart()
}

function escapeYaml(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
}

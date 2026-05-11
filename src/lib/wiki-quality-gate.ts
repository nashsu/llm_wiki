import { parseFrontmatter } from "@/lib/frontmatter"
import {
  CONFIDENCE_VALUES,
  EVIDENCE_STRENGTH_VALUES,
  KNOWLEDGE_TYPE_VALUES,
  QUERY_RETENTION_VALUES,
  REVIEW_STATUS_VALUES,
  WIKI_STATE_VALUES,
} from "@/lib/wiki-metadata"

export type WikiQualityIssueType =
  | "thin-page"
  | "missing-quality-metadata"
  | "invalid-quality-metadata"
  | "stale-or-invalid-metadata-date"
  | "weak-source-trace"
  | "source-coverage-gap"
  | "missing-operating-implication"
  | "missing-verification"

export interface WikiQualityIssue {
  type: WikiQualityIssueType
  message: string
}

export interface WikiQualityAssessment {
  path: string
  pageType: string
  issues: WikiQualityIssue[]
  shouldRepair: boolean
}

export interface WikiQualityOptions {
  expectedDate?: string
  enforceIngestDates?: boolean
}

const CONTENT_QUALITY_FIELDS = [
  "state",
  "confidence",
  "evidence_strength",
  "review_status",
  "knowledge_type",
  "quality",
  "coverage",
  "needs_upgrade",
  "source_count",
]
const QUERY_QUALITY_FIELDS = ["retention"]
const QUALITY_VALUES = new Set(["seed", "draft", "reviewed", "canonical"])
const COVERAGE_VALUES = new Set(["low", "medium", "high"])
const STATE_VALUES = new Set<string>(WIKI_STATE_VALUES)
const CONFIDENCE_VALUE_SET = new Set<string>(CONFIDENCE_VALUES)
const EVIDENCE_STRENGTH_VALUE_SET = new Set<string>(EVIDENCE_STRENGTH_VALUES)
const REVIEW_STATUS_VALUE_SET = new Set<string>(REVIEW_STATUS_VALUES)
const KNOWLEDGE_TYPE_VALUE_SET = new Set<string>(KNOWLEDGE_TYPE_VALUES)
const QUERY_RETENTION_VALUE_SET = new Set<string>(QUERY_RETENTION_VALUES)

const STRUCTURAL_TYPES = new Set(["index", "overview", "log", "schema", "purpose"])

function inferPageType(relativePath: string, content: string): string {
  const parsedType = parseFrontmatter(content).frontmatter?.type
  if (typeof parsedType === "string" && parsedType.trim()) {
    return parsedType.trim().toLowerCase()
  }
  if (relativePath.includes("/sources/")) return "source"
  if (relativePath.includes("/entities/")) return "entity"
  if (relativePath.includes("/concepts/")) return "concept"
  if (relativePath.includes("/queries/")) return "query"
  if (relativePath.includes("/synthesis/")) return "synthesis"
  if (relativePath.includes("/comparisons/")) return "comparison"
  return ""
}

function hasHeading(content: string, heading: string): boolean {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return new RegExp(`^#{2,3}[ \\t]+${escaped}(?:[ \\t].*)?$`, "mi").test(content)
}

function hasAnyHeading(content: string, headings: string[]): boolean {
  return headings.some((h) => hasHeading(content, h))
}

function getHeadingBody(content: string, heading: string): string {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const match = new RegExp(`(?:^|\\n)#{2,3}[ \\t]+${escaped}(?:[ \\t].*)?\\n([\\s\\S]*?)(?=\\n#{2,3}[ \\t]+|$)`, "i").exec(content)
  return match?.[1]?.trim() ?? ""
}

function isPlaceholderBody(body: string): boolean {
  const normalized = body.replace(/\s+/g, " ").trim().toLowerCase()
  if (!normalized) return true
  return /^(?:[-*]\s*)?(?:tbd|todo|not available|manual repair|fallback summary|확인 필요|추후 보강|보류|원본 claim 추출이 필요|아직 충분히 반영되지 않았)(?:[.!。]*$|[:：])/iu.test(normalized)
}

function hasSubstantialHeading(content: string, heading: string, minBodyLength = 32): boolean {
  if (!hasHeading(content, heading)) return false
  const body = getHeadingBody(content, heading)
  return body.length >= minBodyLength && !isPlaceholderBody(body)
}

function hasAnySubstantialHeading(content: string, headings: string[], minBodyLength = 32): boolean {
  return headings.some((h) => hasSubstantialHeading(content, h, minBodyLength))
}

function missingFrontmatterQualityFields(content: string, pageType: string): string[] {
  const fm = parseFrontmatter(content).frontmatter ?? {}
  const required = pageType === "query"
    ? [...CONTENT_QUALITY_FIELDS, ...QUERY_QUALITY_FIELDS]
    : CONTENT_QUALITY_FIELDS
  return required.filter((field) => !(field in fm))
}

function frontmatterScalar(content: string, field: string): string {
  const value = parseFrontmatter(content).frontmatter?.[field]
  if (Array.isArray(value)) return value.join(", ")
  return value ?? ""
}

function isTrue(value: string): boolean {
  return value.trim().toLowerCase() === "true"
}

function isFalse(value: string): boolean {
  return value.trim().toLowerCase() === "false"
}

function hasSourceTrace(content: string): boolean {
  const fm = parseFrontmatter(content).frontmatter ?? {}
  const sources = fm.sources
  if (Array.isArray(sources) && sources.length > 0) return true
  return /##\s*(?:Evidence Map|Source Trace|References|근거|출처)/iu.test(content)
}

function hasFreshnessSection(content: string): boolean {
  return hasAnySubstantialHeading(content, [
    "검증 및 최신성",
    "검증",
    "최신성",
    "Verification & Freshness",
    "Freshness & Verification",
    "Source Cross-Check",
    "Currentness",
  ])
}

function getMinimumBodyLength(pageType: string): number {
  if (pageType === "source") return 1000
  if (pageType === "query" || pageType === "synthesis" || pageType === "comparison") return 800
  if (pageType === "concept" || pageType === "entity") return 600
  return 700
}

function isThin(content: string, pageType: string): boolean {
  const body = parseFrontmatter(content).body.trim()
  const headings = body.match(/^##\s+/gm)?.length ?? 0
  return body.length < getMinimumBodyLength(pageType) || headings < 3
}

export function assessWikiPageQuality(
  relativePath: string,
  content: string,
  options: WikiQualityOptions = {},
): WikiQualityAssessment {
  const pageType = inferPageType(relativePath, content)
  const issues: WikiQualityIssue[] = []

  if (!pageType || STRUCTURAL_TYPES.has(pageType)) {
    return { path: relativePath, pageType, issues, shouldRepair: false }
  }

  const missingQualityFields = missingFrontmatterQualityFields(content, pageType)
  if (missingQualityFields.length > 0) {
    issues.push({
      type: "missing-quality-metadata",
      message: `Missing quality metadata: ${missingQualityFields.join(", ")}`,
    })
  }

  const quality = frontmatterScalar(content, "quality").trim().toLowerCase()
  const state = frontmatterScalar(content, "state").trim().toLowerCase()
  const confidence = frontmatterScalar(content, "confidence").trim().toLowerCase()
  const evidenceStrength = frontmatterScalar(content, "evidence_strength").trim().toLowerCase()
  const reviewStatus = frontmatterScalar(content, "review_status").trim().toLowerCase()
  const knowledgeType = frontmatterScalar(content, "knowledge_type").trim().toLowerCase()
  const retention = frontmatterScalar(content, "retention").trim().toLowerCase()
  const coverage = frontmatterScalar(content, "coverage").trim().toLowerCase()
  const needsUpgrade = frontmatterScalar(content, "needs_upgrade").trim().toLowerCase()
  const sourceCount = frontmatterScalar(content, "source_count").trim()
  const invalidMetadata: string[] = []
  if (state && !STATE_VALUES.has(state)) {
    invalidMetadata.push(`state must be seed|draft|active|canonical|deprecated|archived, got "${state}"`)
  }
  if (confidence && !CONFIDENCE_VALUE_SET.has(confidence)) {
    invalidMetadata.push(`confidence must be low|medium|high, got "${confidence}"`)
  }
  if (evidenceStrength && !EVIDENCE_STRENGTH_VALUE_SET.has(evidenceStrength)) {
    invalidMetadata.push(`evidence_strength must be weak|moderate|strong, got "${evidenceStrength}"`)
  }
  if (reviewStatus && !REVIEW_STATUS_VALUE_SET.has(reviewStatus)) {
    invalidMetadata.push(`review_status must be ai_generated|ai_reviewed|human_reviewed|validated, got "${reviewStatus}"`)
  }
  if (knowledgeType && !KNOWLEDGE_TYPE_VALUE_SET.has(knowledgeType)) {
    invalidMetadata.push(`knowledge_type must be conceptual|operational|experimental|strategic, got "${knowledgeType}"`)
  }
  if (retention && !QUERY_RETENTION_VALUE_SET.has(retention)) {
    invalidMetadata.push(`retention must be ephemeral|reusable|promote|archive, got "${retention}"`)
  }
  if (quality && !QUALITY_VALUES.has(quality)) {
    invalidMetadata.push(`quality must be seed|draft|reviewed|canonical, got "${quality}"`)
  }
  if (coverage && !COVERAGE_VALUES.has(coverage)) {
    invalidMetadata.push(`coverage must be low|medium|high, got "${coverage}"`)
  }
  if (needsUpgrade && !isTrue(needsUpgrade) && !isFalse(needsUpgrade)) {
    invalidMetadata.push(`needs_upgrade must be true|false, got "${needsUpgrade}"`)
  }
  if (sourceCount && !/^[1-9]\d*$/.test(sourceCount)) {
    invalidMetadata.push(`source_count must be a positive integer, got "${sourceCount}"`)
  }
  if (
    evidenceStrength === "weak" &&
    (state === "canonical" || quality === "canonical" || isFalse(needsUpgrade))
  ) {
    invalidMetadata.push("weak evidence cannot be marked canonical or closed with needs_upgrade: false")
  }
  if (state === "canonical" || quality === "canonical") {
    if (evidenceStrength !== "moderate" && evidenceStrength !== "strong") {
      invalidMetadata.push("canonical pages require evidence_strength: moderate|strong")
    }
    if (!["ai_reviewed", "human_reviewed", "validated"].includes(reviewStatus)) {
      invalidMetadata.push("canonical pages require review_status: ai_reviewed|human_reviewed|validated")
    }
    if (!isFalse(needsUpgrade)) {
      invalidMetadata.push("canonical pages require needs_upgrade: false")
    }
    if (!sourceCount && !hasSourceTrace(content)) {
      invalidMetadata.push("canonical pages require source_count or explicit source trace")
    }
  }
  if (invalidMetadata.length > 0) {
    issues.push({
      type: "invalid-quality-metadata",
      message: invalidMetadata.join("; "),
    })
  }

  if (options.enforceIngestDates && options.expectedDate) {
    const staleFields = ["created", "updated", "last_reviewed"].filter(
      (field) => frontmatterScalar(content, field).trim() !== options.expectedDate,
    )
    if (staleFields.length > 0) {
      issues.push({
        type: "stale-or-invalid-metadata-date",
        message: `Ingest metadata dates must be ${options.expectedDate}: ${staleFields.join(", ")}`,
      })
    }
  }

  if (!hasSourceTrace(content)) {
    issues.push({
      type: "weak-source-trace",
      message: "Missing explicit source trace in frontmatter or body.",
    })
  }

  if (isThin(content, pageType)) {
    issues.push({
      type: "thin-page",
      message: "Page is too thin for a durable wiki node.",
    })
  }

  if (pageType === "source") {
    const required = [
      "Source Coverage Matrix",
      "Atomic Claims",
      "Evidence Map",
      "검증 및 최신성",
      "운영 노트",
      "열린 질문",
    ]
    const missing = required.filter((h) => !hasSubstantialHeading(content, h))
    if (missing.length > 0) {
      issues.push({
        type: "source-coverage-gap",
        message: `Source summary is missing sections: ${missing.join(", ")}`,
      })
    }
    if (!hasAnySubstantialHeading(content, ["Kevin 운영체계 적용", "AI Native Solo Business OS 적용"])) {
      issues.push({
        type: "missing-operating-implication",
        message: "Missing Kevin / AI Native Solo Business OS implication section.",
      })
    }
  }

  if (pageType === "concept") {
    const requiredGroups = [
      ["정의", "Definition"],
      ["판단 기준", "Decision Criteria"],
      ["적용 조건", "Application Conditions", "사용 조건"],
      ["실패 모드", "Failure Modes", "주의점", "Caveats"],
    ]
    const missingGroups = requiredGroups.filter((group) => !hasAnySubstantialHeading(content, group))
    if (missingGroups.length > 0) {
      issues.push({
        type: "source-coverage-gap",
        message: "Concept page lacks definition, decision criteria, application conditions, or caveats.",
      })
    }
  }

  if (pageType === "entity") {
    const hasRole = hasAnySubstantialHeading(content, ["Kevin OS에서의 역할", "OS 역할", "운영체계 역할", "Role"])
    const hasConstraint = hasAnySubstantialHeading(content, ["제약", "주의점", "Constraints", "Risks", "권한 모드"])
    if (!hasRole || !hasConstraint) {
      issues.push({
        type: "source-coverage-gap",
        message: "Entity page lacks role and constraint sections.",
      })
    }
  }

  if (pageType === "query" || pageType === "synthesis" || pageType === "comparison") {
    if (!hasFreshnessSection(content) && !hasAnyHeading(content, ["Evidence", "근거"])) {
      issues.push({
        type: "missing-verification",
        message: "Research page lacks verification, freshness, or evidence cross-check section.",
      })
    }
  }

  if (coverage === "high" && isFalse(needsUpgrade) && !hasFreshnessSection(content)) {
    issues.push({
      type: "missing-verification",
      message: "coverage: high with needs_upgrade: false requires a substantial verification/currentness section.",
    })
  }

  return {
    path: relativePath,
    pageType,
    issues,
    shouldRepair: issues.length > 0 && !STRUCTURAL_TYPES.has(pageType),
  }
}

export function buildQualityRepairPrompt(args: {
  relativePath: string
  content: string
  sourceFileName: string
  sourceContent: string
  analysis: string
  verificationContext?: string
  issues: WikiQualityIssue[]
  expectedDate?: string
}): { system: string; user: string } {
  const issueText = args.issues.map((i) => `- ${i.type}: ${i.message}`).join("\n")
  return {
    system: [
      "You are a strict LLM Wiki quality repair editor.",
      "Repair exactly one generated wiki page so it satisfies the quality contract.",
      "Do not output chain-of-thought, hidden reasoning, or explanatory preamble.",
      `Your first line must be exactly: ---FILE: ${args.relativePath}---`,
      "Your last line must be exactly: ---END FILE---",
      "",
      "Quality requirements:",
      "- Add frontmatter fields: state, confidence, evidence_strength, review_status, knowledge_type, quality, coverage, needs_upgrade, source_count.",
      "- Query pages must also include retention: ephemeral | reusable | promote | archive.",
      "- Allowed state values are only seed, draft, active, canonical, deprecated, archived.",
      "- Allowed quality values are only seed, draft, reviewed, canonical. Never use gold.",
      "- Allowed evidence_strength values are only weak, moderate, strong.",
      "- Allowed review_status values are only ai_generated, ai_reviewed, human_reviewed, validated.",
      "- Allowed knowledge_type values are only conceptual, operational, experimental, strategic.",
      args.expectedDate
        ? `- Use created/updated/last_reviewed date exactly ${args.expectedDate}.`
        : "- Use the current ingest date for created/updated/last_reviewed.",
      "- Preserve valid existing frontmatter and wikilinks.",
      "- For source pages, include Source Coverage Matrix, Atomic Claims, Evidence Map, 검증 및 최신성, 오래 유지할 개념, 관련 엔티티, Kevin 운영체계 적용, 운영 노트, 열린 질문.",
      "- Required sections must contain real source-derived content, not empty headings or placeholder bullets.",
      "- For concept pages, include definition, decision criteria, application conditions, failure modes/caveats, and source trace.",
      "- For entity pages, include what it is, OS role, constraints/risks, connections, and source trace.",
      "- For query/synthesis/comparison pages, include source cross-check, freshness/currentness note, evidence limits, and follow-up search needs.",
      "- Use supplied ingest verification search results when they exist, but keep raw-source evidence separate from external evidence.",
      "- Do not invent facts. If raw evidence is insufficient, mark state: draft, quality: draft, evidence_strength: weak, needs_upgrade: true, and state what must be verified.",
      "- If latest data or truth verification is needed but no web evidence is supplied, add explicit follow-up search questions instead of pretending certainty.",
      "- Do not set coverage: high together with needs_upgrade: false unless the page states what was checked for freshness/currentness.",
      "- Do not mark state: canonical or quality: canonical when evidence_strength is weak.",
    ].join("\n"),
    user: [
      `## Page path\n${args.relativePath}`,
      "",
      `## Source filename\n${args.sourceFileName}`,
      "",
      "## Quality issues to repair",
      issueText,
      "",
      "## Stage 1 analysis",
      args.analysis,
      "",
      "## Ingest verification / currentness context",
      args.verificationContext?.trim() || "No external verification context was supplied. Do not claim latest/current status unless the raw source itself supports it.",
      "",
      "## Original raw source",
      args.sourceContent,
      "",
      "## Generated page to repair",
      args.content,
    ].join("\n"),
  }
}

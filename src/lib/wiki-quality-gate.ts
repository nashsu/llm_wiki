import { parseFrontmatter } from "@/lib/frontmatter"

export type WikiQualityIssueType =
  | "thin-page"
  | "missing-quality-metadata"
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

const QUALITY_FIELDS = ["quality", "coverage", "needs_upgrade", "source_count"]

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

function missingFrontmatterQualityFields(content: string): string[] {
  const fm = parseFrontmatter(content).frontmatter ?? {}
  return QUALITY_FIELDS.filter((field) => !(field in fm))
}

function hasSourceTrace(content: string): boolean {
  const fm = parseFrontmatter(content).frontmatter ?? {}
  const sources = fm.sources
  if (Array.isArray(sources) && sources.length > 0) return true
  return /##\s*(?:Evidence Map|Source Trace|References|근거|출처)/iu.test(content)
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
): WikiQualityAssessment {
  const pageType = inferPageType(relativePath, content)
  const issues: WikiQualityIssue[] = []

  if (!pageType || STRUCTURAL_TYPES.has(pageType)) {
    return { path: relativePath, pageType, issues, shouldRepair: false }
  }

  const missingQualityFields = missingFrontmatterQualityFields(content)
  if (missingQualityFields.length > 0) {
    issues.push({
      type: "missing-quality-metadata",
      message: `Missing quality metadata: ${missingQualityFields.join(", ")}`,
    })
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
    if (!hasAnyHeading(content, ["검증", "최신성", "Evidence", "Source Cross-Check", "근거"])) {
      issues.push({
        type: "missing-verification",
        message: "Research page lacks verification, freshness, or evidence cross-check section.",
      })
    }
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
      "- Add frontmatter fields: quality, coverage, needs_upgrade, source_count.",
      "- Preserve valid existing frontmatter and wikilinks.",
      "- For source pages, include Source Coverage Matrix, Atomic Claims, Evidence Map, 오래 유지할 개념, 관련 엔티티, Kevin 운영체계 적용, 운영 노트, 열린 질문.",
      "- Required sections must contain real source-derived content, not empty headings or placeholder bullets.",
      "- For concept pages, include definition, decision criteria, application conditions, failure modes/caveats, and source trace.",
      "- For entity pages, include what it is, OS role, constraints/risks, connections, and source trace.",
      "- For query/synthesis/comparison pages, include source cross-check, freshness/currentness note, evidence limits, and follow-up search needs.",
      "- Use supplied ingest verification search results when they exist, but keep raw-source evidence separate from external evidence.",
      "- Do not invent facts. If raw evidence is insufficient, mark quality: draft, needs_upgrade: true, and state what must be verified.",
      "- If latest data or truth verification is needed but no web evidence is supplied, add explicit follow-up search questions instead of pretending certainty.",
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

import type { FrontmatterValue } from "@/lib/frontmatter"

export const WIKI_STATE_VALUES = [
  "seed",
  "draft",
  "active",
  "canonical",
  "deprecated",
  "archived",
] as const
export type WikiLifecycleState = (typeof WIKI_STATE_VALUES)[number]

export const CONFIDENCE_VALUES = ["low", "medium", "high"] as const
export type WikiConfidence = (typeof CONFIDENCE_VALUES)[number]

export const EVIDENCE_STRENGTH_VALUES = ["weak", "moderate", "strong"] as const
export type EvidenceStrength = (typeof EVIDENCE_STRENGTH_VALUES)[number]

export const REVIEW_STATUS_VALUES = [
  "ai_generated",
  "ai_reviewed",
  "human_reviewed",
  "validated",
] as const
export type ReviewStatus = (typeof REVIEW_STATUS_VALUES)[number]

export const KNOWLEDGE_TYPE_VALUES = [
  "conceptual",
  "operational",
  "experimental",
  "strategic",
] as const
export type KnowledgeType = (typeof KNOWLEDGE_TYPE_VALUES)[number]

export const QUERY_RETENTION_VALUES = [
  "ephemeral",
  "reusable",
  "promote",
  "archive",
] as const
export type QueryRetention = (typeof QUERY_RETENTION_VALUES)[number]

export const RELATIONSHIP_STRENGTH_VALUES = [
  "weak",
  "related",
  "strong",
  "foundational",
] as const
export type RelationshipStrength = (typeof RELATIONSHIP_STRENGTH_VALUES)[number]

export const RELATIONSHIP_STRENGTH_WEIGHT: Record<RelationshipStrength, number> = {
  weak: 0.5,
  related: 1,
  strong: 1.5,
  foundational: 2,
}

export function scalarFrontmatterValue(value: FrontmatterValue | undefined): string | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

export function normalizeWikiState(value: FrontmatterValue | string | undefined): WikiLifecycleState | undefined {
  return normalizeEnum(value, WIKI_STATE_VALUES)
}

export function normalizeConfidence(value: FrontmatterValue | string | undefined): WikiConfidence | undefined {
  return normalizeEnum(value, CONFIDENCE_VALUES)
}

export function normalizeEvidenceStrength(value: FrontmatterValue | string | undefined): EvidenceStrength | undefined {
  return normalizeEnum(value, EVIDENCE_STRENGTH_VALUES)
}

export function normalizeReviewStatus(value: FrontmatterValue | string | undefined): ReviewStatus | undefined {
  return normalizeEnum(value, REVIEW_STATUS_VALUES)
}

export function normalizeKnowledgeType(value: FrontmatterValue | string | undefined): KnowledgeType | undefined {
  return normalizeEnum(value, KNOWLEDGE_TYPE_VALUES)
}

export function normalizeQueryRetention(value: FrontmatterValue | string | undefined): QueryRetention | undefined {
  return normalizeEnum(value, QUERY_RETENTION_VALUES)
}

export function normalizeRelationshipStrength(value: FrontmatterValue | string | undefined): RelationshipStrength | undefined {
  return normalizeEnum(value, RELATIONSHIP_STRENGTH_VALUES)
}

export function inferStateFromQuality(quality: string | undefined): WikiLifecycleState {
  const normalized = quality?.trim().toLowerCase()
  if (normalized === "canonical") return "canonical"
  if (normalized === "reviewed") return "active"
  if (normalized === "seed") return "seed"
  return "draft"
}

export function inferKnowledgeTypeFromPageType(pageType: string): KnowledgeType {
  const normalized = pageType.trim().toLowerCase()
  if (normalized === "query") return "experimental"
  if (normalized === "comparison" || normalized === "synthesis") return "strategic"
  return "conceptual"
}

export function shouldExcludeFromDefaultKnowledgeSurface(args: {
  path: string
  type?: string
  state?: string
  retention?: string
}): boolean {
  const state = normalizeWikiState(args.state)
  if (state === "deprecated" || state === "archived") return true

  const retention = normalizeQueryRetention(args.retention)
  if (retention === "ephemeral" || retention === "archive") return true

  const type = args.type?.trim().toLowerCase()
  if ((type === "query" || hasQueryPathSegment(args.path)) && retention === undefined) {
    return true
  }

  return false
}

function normalizeEnum<T extends string>(
  value: FrontmatterValue | string | undefined,
  allowed: readonly T[],
): T | undefined {
  const scalar = typeof value === "string" ? value : scalarFrontmatterValue(value)
  const normalized = scalar?.trim().toLowerCase().replace(/-/g, "_")
  return allowed.find((item) => item === normalized)
}

function hasQueryPathSegment(path: string): boolean {
  return path.replace(/\\/g, "/").toLowerCase().split("/").includes("queries")
}

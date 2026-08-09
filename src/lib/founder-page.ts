import type { FrontmatterValue } from "./frontmatter"

export const FOUNDER_PAGE_SCHEMA_VERSION = "founder-page/v1"

export type FounderPageStatus = "draft" | "review" | "published"
export type FounderPageSensitivity = "local_only" | "private" | "shareable"
export type FounderRetrievalStatus = "ok" | "unavailable"

export interface FounderReference {
  title: string
  path: string
  source: string
  version_or_hash: string
  evidence_snippet: string
}

export interface FounderRetrievalResult {
  status: FounderRetrievalStatus
  answer: string
  grounding_source: "canonical" | "projection" | "gbrain" | "none"
  references: FounderReference[]
  confidence: number
  freshness: string | null
  sensitivity: FounderPageSensitivity
}

export interface FounderPageValidation {
  valid: boolean
  errors: string[]
}

const REQUIRED_FIELDS = [
  "schema_version", "type", "title", "source_id", "source_slug",
  "content_hash", "evidence_refs", "status", "owner", "confidence",
  "verified_at", "review_by", "sensitivity", "contradictions", "supersedes",
] as const

function scalar(value: FrontmatterValue | undefined): string {
  return Array.isArray(value) ? "" : (value ?? "")
}

export function isGeneratedFrankBrainProjection(
  path: string,
  frontmatter?: Record<string, FrontmatterValue> | null,
): boolean {
  const normalized = path.replace(/\\/g, "/").replace(/^\.\//, "")
  const projection = scalar(frontmatter?.projection).toLowerCase()
  return normalized === "wiki/frankbrain"
    || normalized.startsWith("wiki/frankbrain/")
    || projection === "true"
}

export function validateFounderPage(
  frontmatter: Record<string, FrontmatterValue> | null,
  path: string,
): FounderPageValidation {
  const errors: string[] = []
  if (!frontmatter) return { valid: false, errors: ["missing frontmatter"] }

  for (const field of REQUIRED_FIELDS) {
    if (!(field in frontmatter)) errors.push("missing " + field)
  }
  if (scalar(frontmatter.schema_version) !== FOUNDER_PAGE_SCHEMA_VERSION) {
    errors.push("schema_version must be " + FOUNDER_PAGE_SCHEMA_VERSION)
  }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(scalar(frontmatter.source_slug))) {
    errors.push("source_slug must be kebab-case")
  }
  if (!/^[a-f0-9]{64}$/.test(scalar(frontmatter.content_hash))) {
    errors.push("content_hash must be a lowercase SHA-256")
  }
  if (!["draft", "review", "published"].includes(scalar(frontmatter.status))) {
    errors.push("invalid status")
  }
  if (!["local_only", "private", "shareable"].includes(scalar(frontmatter.sensitivity))) {
    errors.push("invalid sensitivity")
  }
  const confidence = Number(scalar(frontmatter.confidence))
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    errors.push("confidence must be between 0 and 1")
  }
  for (const field of ["verified_at", "review_by"] as const) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(scalar(frontmatter[field]))) {
      errors.push(field + " must be YYYY-MM-DD")
    }
  }
  if (isGeneratedFrankBrainProjection(path, frontmatter)
      && scalar(frontmatter.status) === "published") {
    errors.push("generated projection pages cannot be canonical published pages")
  }
  return { valid: errors.length === 0, errors }
}

export function canPublishFounderPage(
  frontmatter: Record<string, FrontmatterValue> | null,
  path: string,
  founderApproved: boolean,
): FounderPageValidation {
  const result = validateFounderPage(frontmatter, path)
  const errors = [...result.errors]
  if (isGeneratedFrankBrainProjection(path, frontmatter)) {
    errors.push("generated projection pages cannot be published back to gbrain")
  }
  if (!path.replace(/\\/g, "/").startsWith("wiki/inbox/fbrain/")) {
    errors.push("AI proposals must originate in wiki/inbox/fbrain/")
  }
  if (!founderApproved) errors.push("founder approval is required")
  return { valid: errors.length === 0, errors: [...new Set(errors)] }
}

export function unavailableFounderResult(
  sensitivity: FounderPageSensitivity = "local_only",
): FounderRetrievalResult {
  return {
    status: "unavailable",
    answer: "unavailable",
    grounding_source: "none",
    references: [],
    confidence: 0,
    freshness: null,
    sensitivity,
  }
}

/** Keep local founder evidence away from CLI/frontier synthesis by default. */
export function requiresLocalFounderSynthesis(
  references: Array<{ kind?: string; path?: string; url?: string }>,
  projectPath = "",
): boolean {
  const projectName = projectPath.replace(/\\/g, "/").replace(/\/$/, "").split("/").pop()
  if (projectName?.toLowerCase() === "frankbrain" && references.length > 0) return true
  return references.some((reference) => {
    if (reference.kind?.toLowerCase() === "gbrain") return true
    const path = (reference.path ?? reference.url ?? "")
      .replace(/\\/g, "/")
      .replace(/^\.\//, "")
      .toLowerCase()
    return path === "wiki/frankbrain" || path.startsWith("wiki/frankbrain/")
  })
}

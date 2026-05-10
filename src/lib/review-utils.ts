/**
 * Shared helpers for reasoning about review items.
 * Kept dependency-free so both the Zustand store and sweep logic can import
 * it without creating cycles or pulling heavy LLM modules into the store.
 */
import { normalizePath } from "@/lib/path-utils"
import type { ReviewItem } from "@/stores/review-store"

// Common prefixes LLM may prepend in English or Chinese review titles.
// Kept in one place so dedupe and sweep agree on what "the same concept" means.
const REVIEW_TITLE_PREFIX_RE =
  /^(missing[\s-]?page[:：]\s*|duplicate[\s-]?page[:：]\s*|possible[\s-]?duplicate[:：]\s*|缺失页面[:：]\s*|缺少页面[:：]\s*|重复页面[:：]\s*|疑似重复[:：]\s*)/i

export interface ReviewBuckets {
  currentPending: ReviewItem[]
  currentResolved: ReviewItem[]
  unassigned: ReviewItem[]
}

function normalizeProjectPath(projectPath: string | undefined): string {
  return projectPath ? normalizePath(projectPath) : ""
}

function normalizeProjectId(projectId: string | undefined): string {
  return projectId?.trim() ?? ""
}

function visibilityKey(item: Pick<ReviewItem, "projectPath" | "type" | "title">): string {
  return `${normalizeProjectPath(item.projectPath)}::${item.type}::${normalizeReviewTitle(item.title)}`
}

function isAssigned(item: Pick<ReviewItem, "projectId" | "projectPath">): boolean {
  return normalizeProjectId(item.projectId).length > 0 && normalizeProjectPath(item.projectPath).length > 0
}

function pickMoreCanonical(a: ReviewItem, b: ReviewItem): ReviewItem {
  const aAssigned = isAssigned(a)
  const bAssigned = isAssigned(b)
  if (aAssigned !== bAssigned) return aAssigned ? a : b

  if (a.resolved !== b.resolved) return a.resolved ? b : a

  if ((a.createdAt ?? 0) !== (b.createdAt ?? 0)) {
    return (a.createdAt ?? 0) >= (b.createdAt ?? 0) ? a : b
  }

  return a
}

/**
 * Normalize a review title for equality comparison:
 *   - strip leading "Missing page:" / "缺失页面:" / etc.
 *   - collapse whitespace
 *   - lowercase
 *
 * Two review items with the same (type, normalized title) are considered
 * the same concept and should be merged rather than duplicated.
 */
export function normalizeReviewTitle(title: string): string {
  return title
    .replace(REVIEW_TITLE_PREFIX_RE, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
}

export function canonicalizeReviewItems(items: ReviewItem[]): ReviewItem[] {
  const byKey = new Map<string, ReviewItem>()

  for (const item of items) {
    const key = visibilityKey(item)
    const existing = byKey.get(key)
    byKey.set(key, existing ? pickMoreCanonical(existing, item) : item)
  }

  const survivors = new Set(byKey.values())
  return items.filter((item) => survivors.has(item))
}

export function bucketReviewItems(
  items: ReviewItem[],
  currentProjectPath: string | null | undefined,
): ReviewBuckets {
  const canonical = canonicalizeReviewItems(items)
  const currentPath = normalizeProjectPath(currentProjectPath ?? "")
  const currentPending: ReviewItem[] = []
  const currentResolved: ReviewItem[] = []
  const unassigned: ReviewItem[] = []
  const visibleInCurrent = new Set<string>()

  for (const item of canonical) {
    const itemPath = normalizeProjectPath(item.projectPath)
    if (currentPath && itemPath === currentPath) {
      visibleInCurrent.add(visibilityKey(item))
      if (item.resolved) currentResolved.push(item)
      else currentPending.push(item)
    }
  }

  for (const item of canonical) {
    const key = visibilityKey(item)
    if (visibleInCurrent.has(key)) continue
    if (!isAssigned(item)) {
      unassigned.push(item)
    }
  }

  return { currentPending, currentResolved, unassigned }
}

export function needsProjectAssignment(
  item: Pick<ReviewItem, "projectId" | "projectPath">,
  currentProjectPath: string | null | undefined,
): boolean {
  const currentPath = normalizeProjectPath(currentProjectPath ?? "")
  if (!currentPath) return false
  return normalizeProjectPath(item.projectPath) === currentPath && normalizeProjectId(item.projectId).length === 0
}

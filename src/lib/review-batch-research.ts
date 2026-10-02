import type { ReviewItem } from "@/stores/review-store"
import { groundBareResearchQueries } from "@/lib/research-query-grounding"

const ACTIVE_RESEARCH_STATUSES = new Set([
  "queued",
  "searching",
  "synthesizing",
  "saving",
])

export function reviewSupportsResearch(item: ReviewItem): boolean {
  return item.type === "suggestion" || item.type === "missing-page"
}

export function reviewResearchTopic(item: ReviewItem): string {
  return item.title.trim() || item.description.split("\n")[0]?.trim() || ""
}

export function reviewResearchQueries(item: ReviewItem, topic = reviewResearchTopic(item)): string[] {
  return groundBareResearchQueries(
    item.searchQueries?.length ? item.searchQueries : [topic],
    topic,
    item.description,
    [item.title],
  )
}

export function selectedResearchReviews(
  items: ReviewItem[],
  selectedIds: ReadonlySet<string>,
  researchTasks: Array<{ sourceReviewId?: string; status: string }>,
): ReviewItem[] {
  const activeReviewIds = new Set(
    researchTasks
      .filter((task) => task.sourceReviewId && ACTIVE_RESEARCH_STATUSES.has(task.status))
      .map((task) => task.sourceReviewId as string),
  )
  return items.filter((item) =>
    !item.resolved &&
    selectedIds.has(item.id) &&
    reviewSupportsResearch(item) &&
    !activeReviewIds.has(item.id),
  )
}

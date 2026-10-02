import { describe, expect, it } from "vitest"
import type { ReviewItem } from "@/stores/review-store"
import { reviewResearchQueries, reviewResearchTopic, selectedResearchReviews } from "./review-batch-research"

function review(id: string, type: ReviewItem["type"], resolved = false): ReviewItem {
  return {
    id,
    type,
    title: `Topic ${id}`,
    description: "Description",
    options: [],
    resolved,
    createdAt: 1,
  }
}

describe("selectedResearchReviews", () => {
  it("keeps selected researchable pending reviews and skips active tasks", () => {
    const items = [
      review("a", "suggestion"),
      review("b", "missing-page"),
      review("c", "confirm"),
      review("d", "suggestion", true),
    ]

    expect(selectedResearchReviews(
      items,
      new Set(["a", "b", "c", "d"]),
      [{ sourceReviewId: "b", status: "searching" }],
    ).map((item) => item.id)).toEqual(["a"])
  })

  it("uses the description only when the title is empty", () => {
    expect(reviewResearchTopic({
      ...review("a", "suggestion"),
      title: " ",
      description: "First line\nSecond line",
    })).toBe("First line")
  })

  it("grounds bare generated queries with the review description", () => {
    expect(reviewResearchQueries({
      ...review("a", "suggestion"),
      title: "AF",
      description: "attention filter signal in the project pipeline",
      searchQueries: ["AF", "AF cognitive signal"],
    })).toEqual([
      "AF attention filter signal in the project pipeline",
      "AF cognitive signal",
    ])
  })

  it("uses an action-derived topic without reusing queries for the original title", () => {
    const item = {
      ...review("a", "suggestion"),
      title: "Original topic",
      description: "comparison of two internal mechanisms",
      searchQueries: undefined,
    }
    expect(reviewResearchQueries(item, "X comparison"))
      .toEqual(["X comparison comparison of two internal mechanisms"])
  })
})

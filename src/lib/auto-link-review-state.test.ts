import { describe, expect, it } from "vitest"
import type {
  AutoLinkSuggestion,
  ConfidenceBand,
} from "./auto-link-types"
import {
  countSuggestionsByBand,
  createInitialAutoLinkSelection,
  groupAutoLinkSuggestionsByTarget,
  isAutoLinkReviewInteractionBusy,
  selectedLinksFromState,
  setSuggestionSelected,
  setSuggestionTarget,
  shouldAllowAutoLinkOpenChange,
} from "./auto-link-review-state"

function suggestion(
  id: string,
  band: ConfidenceBand,
  selectedByDefault: boolean,
  targets: string[] = [`${id}-target`],
): AutoLinkSuggestion {
  return {
    id,
    term: `${id}-term`,
    selectedTarget: targets[0],
    preferredTarget: targets[0],
    alternatives: targets.map((target) => ({
      target,
      title: target,
      path: `/project/wiki/${target}.md`,
      band,
      matchKind: band === "high" ? "slug-exact" : "title-related",
      reason: `${band} reason`,
    })),
    band,
    selectedByDefault,
    reason: `${band} reason`,
  }
}

describe("createInitialAutoLinkSelection", () => {
  it("selects only default-selected High suggestions and keeps Low collapsed", () => {
    const suggestions = [
      suggestion("high", "high", true),
      suggestion("medium", "medium", false),
      suggestion("low", "low", false),
    ]

    const state = createInitialAutoLinkSelection(suggestions)

    expect([...state.selectedIds]).toEqual(["high"])
    expect(state.selectedTargets).toEqual({
      high: "high-target",
      medium: "medium-target",
      low: "low-target",
    })
    expect(state.lowExpanded).toBe(false)
  })
})

describe("selection updates", () => {
  it("selects immutably and changes the chosen alternative", () => {
    const suggestions = [
      suggestion("medium", "medium", false, ["first", "second"]),
    ]
    const initial = createInitialAutoLinkSelection(suggestions)
    const selected = setSuggestionSelected(initial, "medium", true)
    const changed = setSuggestionTarget(selected, "medium", "second")

    expect(initial.selectedIds.size).toBe(0)
    expect(initial.selectedTargets.medium).toBe("first")
    expect([...changed.selectedIds]).toEqual(["medium"])
    expect(changed.selectedTargets.medium).toBe("second")
    expect(selectedLinksFromState(suggestions, changed)).toEqual([
      { term: "medium-term", target: "second" },
    ])
  })

  it("falls back to a real suggestion target when state contains an invalid target", () => {
    const suggestions = [suggestion("high", "high", true, ["real"])]
    const state = createInitialAutoLinkSelection(suggestions)
    state.selectedTargets.high = "invented"

    expect(selectedLinksFromState(suggestions, state)).toEqual([
      { term: "high-term", target: "real" },
    ])
  })

  it("groups selected occurrences into one apply item per target", () => {
    const suggestions = [
      suggestion("first", "high", true, ["shared-target"]),
      suggestion("second", "high", true, ["shared-target"]),
    ]
    const state = createInitialAutoLinkSelection(suggestions)

    expect(groupAutoLinkSuggestionsByTarget(suggestions, state)).toEqual([
      expect.objectContaining({
        target: "shared-target",
        primary: suggestions[0],
        suggestions,
      }),
    ])
    expect(selectedLinksFromState(suggestions, state)).toEqual([
      {
        term: "first-term",
        target: "shared-target",
        alternativeTerms: ["second-term"],
      },
    ])
  })

  it("includes every occurrence when any member of a target group is selected", () => {
    const suggestions = [
      suggestion("high", "high", true, ["shared-target"]),
      suggestion("medium", "medium", false, ["shared-target"]),
    ]
    const state = createInitialAutoLinkSelection(suggestions)

    expect([...state.selectedIds]).toEqual(["high"])
    expect(selectedLinksFromState(suggestions, state)).toEqual([
      {
        term: "high-term",
        target: "shared-target",
        alternativeTerms: ["medium-term"],
      },
    ])
  })
})

describe("countSuggestionsByBand", () => {
  it("returns stable zero-filled counts", () => {
    expect(
      countSuggestionsByBand([
        suggestion("h1", "high", true),
        suggestion("h2", "high", true),
        suggestion("low", "low", false),
      ]),
    ).toEqual({ high: 2, medium: 0, low: 1 })
  })
})

describe("review interaction guards", () => {
  it("blocks dismissal while links are being applied", () => {
    expect(shouldAllowAutoLinkOpenChange(false, true)).toBe(false)
    expect(shouldAllowAutoLinkOpenChange(false, false)).toBe(true)
    expect(shouldAllowAutoLinkOpenChange(true, true)).toBe(true)
  })

  it("locks apply and ignore interactions during either mutation", () => {
    expect(isAutoLinkReviewInteractionBusy(true, null)).toBe(true)
    expect(isAutoLinkReviewInteractionBusy(false, "term:suggestion")).toBe(true)
    expect(isAutoLinkReviewInteractionBusy(false, null)).toBe(false)
  })
})

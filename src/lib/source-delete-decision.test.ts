/**
 * Regression suite for decidePageFate — the three-way branch that
 * decides whether a wiki page survives, loses a source reference, or
 * gets deleted when the user removes a source document.
 *
 * The key case is the one that used to silently lose data:
 *
 *   `frontmatterSources` = ["other.md"]
 *   `deletingSource`     = "test.md"
 *   → must return { action: "skip" }, NOT { action: "delete" }
 *
 * Before the extraction, this branch in sources-view.tsx didn't check
 * whether the sole source was the one being deleted — it just saw
 * length === 1 and fell through to delete. findRelatedWikiPages'
 * over-eager matching (see fs.rs Strategy 3) could surface pages whose
 * sources list didn't actually contain the target, and those would
 * then be wiped.
 */
import { describe, it, expect } from "vitest"
import { decidePageFate } from "./source-delete-decision"

describe("decidePageFate — single-source page", () => {
  it("deletes when the sole source is the one being removed", () => {
    expect(decidePageFate(["test.md"], "test.md")).toEqual({ action: "delete" })
  })

  it("SKIPS when the sole source is NOT the one being removed (Bug #1 fix)", () => {
    // The user-reported / review-surfaced data-loss path: page shows up
    // in findRelatedWikiPages via a loose match, but its actual single
    // source is unrelated. Must NOT be deleted.
    const decision = decidePageFate(["other.md"], "test.md")
    expect(decision.action).toBe("skip")
  })

  it("matches case-insensitively when deciding to delete", () => {
    expect(decidePageFate(["Test.md"], "test.md")).toEqual({ action: "delete" })
    expect(decidePageFate(["test.md"], "TEST.MD")).toEqual({ action: "delete" })
  })
})

describe("decidePageFate — multi-source page", () => {
  it("keeps and drops the deleted source from the list", () => {
    expect(decidePageFate(["a.md", "b.md"], "a.md")).toEqual({
      action: "keep",
      updatedSources: ["b.md"],
    })
  })

  it("preserves the order of surviving sources", () => {
    expect(decidePageFate(["a.md", "b.md", "c.md"], "b.md")).toEqual({
      action: "keep",
      updatedSources: ["a.md", "c.md"],
    })
  })

  it("SKIPS when the deleted source is not in the multi-source list", () => {
    // Again the false-positive-from-loose-match scenario, but the page
    // has multiple genuine sources, none of which is the deleted one.
    const decision = decidePageFate(["a.md", "b.md"], "c.md")
    expect(decision.action).toBe("skip")
  })

  it("matches case-insensitively AND strips all case variants on keep", () => {
    // If a page somehow has both "Test.md" and "test.md" in its sources
    // list (rare but possible via manual editing or ingest glitch), a
    // single deletion request should remove every case variant so
    // residual duplicates don't linger.
    const decision = decidePageFate(
      ["Test.md", "Other.md", "test.md"],
      "test.md",
    )
    expect(decision).toEqual({
      action: "keep",
      updatedSources: ["Other.md"],
    })
  })
})

describe("decidePageFate — empty / edge inputs", () => {
  it("skips a page with an empty sources list (no claim on this deletion)", () => {
    // Pre-0.3.x pages without a sources field, or pages manually edited
    // to an empty list. They shouldn't be deleted just because
    // findRelatedWikiPages happened to return them via the file-path
    // heuristic.
    const decision = decidePageFate([], "test.md")
    expect(decision.action).toBe("skip")
  })

  it("skips when the deleting source is itself empty", () => {
    // Defensive: an empty deleting source never matches anything.
    const decision = decidePageFate(["a.md"], "")
    expect(decision.action).toBe("skip")
  })

  it("handles a single-source list where the source is some other casing", () => {
    expect(
      decidePageFate(["SomeFile.Md"], "somefile.md"),
    ).toEqual({ action: "delete" })
  })
})

describe("decidePageFate — the full lifecycle of a shared page", () => {
  it("walks from multi-source → multi-source → single-source → deleted across source deletions", () => {
    // Page starts with three sources.
    let sources = ["a.md", "b.md", "c.md"]

    // Delete a.md first → keep, drop a.
    let d = decidePageFate(sources, "a.md")
    expect(d.action).toBe("keep")
    sources = (d as { action: "keep"; updatedSources: string[] }).updatedSources
    expect(sources).toEqual(["b.md", "c.md"])

    // Delete c.md → keep, drop c.
    d = decidePageFate(sources, "c.md")
    expect(d.action).toBe("keep")
    sources = (d as { action: "keep"; updatedSources: string[] }).updatedSources
    expect(sources).toEqual(["b.md"])

    // Delete b.md (now the sole source) → delete the page.
    d = decidePageFate(sources, "b.md")
    expect(d.action).toBe("delete")
  })
})

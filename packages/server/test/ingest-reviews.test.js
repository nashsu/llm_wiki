/**
 * Server port of src/stores/review-store.test.ts (fold/dedup cases) plus
 * a parse matrix for parseReviewBlocks (ported from src/lib/ingest.ts)
 * and a file round-trip suite for saveIngestReviewItems.
 *
 * Mapping from the client suite:
 *   - reviewIdFor tests port 1:1.
 *   - addItem/addItems store actions are pure-logic folds; they are
 *     tested against foldReviewItems(existing, incoming), the server's
 *     explicit-parameter port of the store callback.
 *   - setItems (migrate-on-load) is tested against normalizeReviewItems.
 *
 * Not ported: resolveItem / dismissItem / clearResolved — those are UI
 * store actions (state flag flips + list filters) with no role in the
 * server ingest pipeline; the server's resolve/dismiss surface is the
 * reviews API, not this module.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { ReviewItemSchema } from "@llm-wiki/api-types"
import {
  reviewIdFor,
  normalizeReviewItems,
  foldReviewItems,
  parseReviewBlocks,
  saveIngestReviewItems,
} from "../src/ingest/reviews.js"

// Minimal builder so each test only specifies what it cares about.
function makeInput(overrides = {}) {
  return {
    type: "missing-page",
    title: "Attention",
    description: "description",
    options: [],
    ...overrides,
  }
}

describe("reviewIdFor — content-stable id", () => {
  it("is identical for the same type + normalized title (survives regeneration)", () => {
    // "Missing page: Attention" and "缺失页面: Attention" normalize equal.
    expect(reviewIdFor({ type: "missing-page", title: "Missing page: Attention" }))
      .toBe(reviewIdFor({ type: "missing-page", title: "缺失页面: Attention" }))
  })

  it("matches the API stable-id fixtures", () => {
    expect(reviewIdFor({ type: "missing-page", title: "Missing page: Attention" }))
      .toBe("review-dbdcf949")
    expect(reviewIdFor({ type: "missing-page", title: "Missing page Attention" }))
      .toBe("review-fa5d9960")
    expect(reviewIdFor({ type: "missing-page", title: "疑似重复 注意力" }))
      .toBe("review-d2dacda0")
  })

  it("differs across types", () => {
    expect(reviewIdFor({ type: "missing-page", title: "Attention" }))
      .not.toBe(reviewIdFor({ type: "duplicate", title: "Attention" }))
  })

  it("differs across distinct titles", () => {
    expect(reviewIdFor({ type: "missing-page", title: "Attention" }))
      .not.toBe(reviewIdFor({ type: "missing-page", title: "Transformer" }))
  })

  it("does not depend on sourcePath (file moves keep the id stable)", () => {
    // reviewIdFor only takes type + title; sourcePath cannot affect it.
    const a = reviewIdFor({ type: "missing-page", title: "Attention" })
    const b = reviewIdFor({ type: "missing-page", title: "Attention" })
    expect(a).toBe(b)
  })
})

describe("foldReviewItems — addItem semantics", () => {
  it("adds a single item with content-stable id and resolved=false", () => {
    const items = foldReviewItems([], [makeInput()])
    expect(items).toHaveLength(1)
    expect(items[0].id).toBe(reviewIdFor(makeInput()))
    expect(items[0].resolved).toBe(false)
    expect(items[0].createdAt).toBeTypeOf("number")
  })

  it("dedupes same-content items (stable id identity), keeps distinct ones", () => {
    let items = foldReviewItems([], [makeInput({ title: "Same" })])
    items = foldReviewItems(items, [makeInput({ title: "Same" })])
    expect(items).toHaveLength(1)
    items = foldReviewItems(items, [makeInput({ title: "Different" })])
    expect(items).toHaveLength(2)
  })

  it("does not revive a resolved item when the same content is added again", () => {
    let items = foldReviewItems([], [makeInput({ title: "Attention" })])
    const id = items[0].id
    items = items.map((item) =>
      item.id === id ? { ...item, resolved: true, resolvedAction: "user-resolved" } : item
    )
    items = foldReviewItems(items, [makeInput({ title: "Attention" })])
    expect(items).toHaveLength(1)
    expect(items[0].resolved).toBe(true)
    expect(items[0].resolvedAction).toBe("user-resolved")
  })
})

describe("foldReviewItems — addItems dedupe", () => {
  it("merges two incoming items with the same type + normalized title", () => {
    const items = foldReviewItems([], [
      makeInput({ title: "Missing page: Attention", affectedPages: ["a.md"] }),
      makeInput({ title: "缺失页面: Attention", affectedPages: ["b.md"] }),
    ])
    expect(items).toHaveLength(1)
    expect(items[0].affectedPages).toEqual(expect.arrayContaining(["a.md", "b.md"]))
  })

  it("merges against existing pending items", () => {
    let items = foldReviewItems([], [
      makeInput({ title: "Attention", affectedPages: ["x.md"] }),
    ])
    items = foldReviewItems(items, [
      makeInput({ title: "Missing page: Attention", affectedPages: ["y.md"] }),
    ])
    expect(items).toHaveLength(1)
    expect(items[0].affectedPages).toEqual(expect.arrayContaining(["x.md", "y.md"]))
  })

  it("does NOT merge across different types", () => {
    const items = foldReviewItems([], [
      makeInput({ type: "missing-page", title: "Attention" }),
      makeInput({ type: "duplicate", title: "Attention" }),
    ])
    expect(items).toHaveLength(2)
  })

  it("MERGES into a resolved item and preserves its resolved state (resolved wins)", () => {
    // This is the core fix: re-surfacing a review during ingest must NOT
    // discard its resolution. The same-content item folds into the
    // resolved one (same id), keeping resolved + merging new pages.
    let items = foldReviewItems([], [makeInput({ title: "Attention" })])
    const oldId = items[0].id
    items = items.map((item) =>
      item.id === oldId ? { ...item, resolved: true, resolvedAction: "user-resolved" } : item
    )
    items = foldReviewItems(items, [makeInput({ title: "Attention", affectedPages: ["new.md"] })])
    expect(items).toHaveLength(1)
    expect(items[0].id).toBe(oldId)
    expect(items[0].resolved).toBe(true)
    expect(items[0].resolvedAction).toBe("user-resolved")
    expect(items[0].affectedPages).toEqual(["new.md"])
  })

  it("covers contradiction type", () => {
    const items = foldReviewItems([], [
      makeInput({ type: "contradiction", title: "Conflict A", affectedPages: ["a.md"] }),
      makeInput({ type: "contradiction", title: "Conflict A", affectedPages: ["b.md"] }),
    ])
    expect(items).toHaveLength(1)
    expect(items[0].affectedPages).toEqual(expect.arrayContaining(["a.md", "b.md"]))
  })

  it("covers confirm type", () => {
    const items = foldReviewItems([], [
      makeInput({ type: "confirm", title: "Confirm X" }),
      makeInput({ type: "confirm", title: "Confirm X" }),
    ])
    expect(items).toHaveLength(1)
  })

  it("prefers the newer non-empty description on merge", () => {
    let items = foldReviewItems([], [makeInput({ title: "A", description: "old desc" })])
    items = foldReviewItems(items, [makeInput({ title: "A", description: "new desc" })])
    expect(items[0].description).toBe("new desc")
  })

  it("keeps old description if incoming is empty", () => {
    let items = foldReviewItems([], [makeInput({ title: "A", description: "keep me" })])
    items = foldReviewItems(items, [makeInput({ title: "A", description: "" })])
    expect(items[0].description).toBe("keep me")
  })

  it("deduplicates affectedPages within the merge", () => {
    let items = foldReviewItems([], [makeInput({ title: "A", affectedPages: ["x.md", "y.md"] })])
    items = foldReviewItems(items, [makeInput({ title: "A", affectedPages: ["y.md", "z.md"] })])
    expect(items[0].affectedPages).toEqual(["x.md", "y.md", "z.md"])
  })

  it("merges searchQueries without duplicates", () => {
    let items = foldReviewItems([], [makeInput({ title: "A", searchQueries: ["q1"] })])
    items = foldReviewItems(items, [makeInput({ title: "A", searchQueries: ["q1", "q2"] })])
    expect(items[0].searchQueries).toEqual(["q1", "q2"])
  })

  it("sets affectedPages to undefined when the merged result is empty", () => {
    const items = foldReviewItems([], [makeInput({ title: "A" }), makeInput({ title: "A" })])
    expect(items[0].affectedPages).toBeUndefined()
  })

  it("handles many incoming items at once, merging same-key pairs", () => {
    const items = foldReviewItems([], [
      makeInput({ title: "A", affectedPages: ["1.md"] }),
      makeInput({ title: "A", affectedPages: ["2.md"] }),
      makeInput({ title: "B", affectedPages: ["3.md"] }),
      makeInput({ title: "A", affectedPages: ["4.md"] }),
    ])
    expect(items).toHaveLength(2)
    const a = items.find((i) => i.title.toLowerCase().includes("a"))
    const b = items.find((i) => i.title.toLowerCase().includes("b"))
    expect(a?.affectedPages).toEqual(["1.md", "2.md", "4.md"])
    expect(b?.affectedPages).toEqual(["3.md"])
  })

  it("invariant: after addItems, every item has a unique stable id", () => {
    const items = foldReviewItems([], [
      makeInput({ type: "missing-page", title: "Missing page: Foo" }),
      makeInput({ type: "missing-page", title: "缺失页面: Foo" }),
      makeInput({ type: "missing-page", title: "Foo" }),
      makeInput({ type: "duplicate", title: "Foo" }),
      makeInput({ type: "duplicate", title: "Duplicate page: Foo" }),
    ])
    const ids = items.map((i) => i.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe("normalizeReviewItems — migrate-on-load", () => {
  it("remaps old counter ids to content-stable ids", () => {
    const items = normalizeReviewItems([
      { ...makeInput({ title: "Attention" }), id: "review-6", resolved: false, createdAt: 1 },
    ])
    expect(items[0].id).toBe(reviewIdFor({ type: "missing-page", title: "Attention" }))
  })

  it("collapses two old items with identical content into one — resolved wins", () => {
    // Acceptance: two counter-id rows for the same review (one resolved)
    // must fold into a single resolved item on load.
    const items = normalizeReviewItems([
      {
        ...makeInput({ title: "Attention", affectedPages: ["a.md"] }),
        id: "review-6",
        resolved: false,
        createdAt: 5,
      },
      {
        ...makeInput({ title: "Missing page: Attention", affectedPages: ["b.md"] }),
        id: "review-99",
        resolved: true,
        resolvedAction: "user-resolved",
        createdAt: 2,
      },
    ])
    expect(items).toHaveLength(1)
    expect(items[0].resolved).toBe(true)
    expect(items[0].resolvedAction).toBe("user-resolved")
    expect(items[0].affectedPages).toEqual(expect.arrayContaining(["a.md", "b.md"]))
    expect(items[0].createdAt).toBe(2) // earliest
  })

  it("preserves a later duplicate resolvedAction when the first resolved item lacks one", () => {
    const normalized = normalizeReviewItems([
      {
        ...makeInput({ title: "Attention" }),
        id: "review-1",
        resolved: true,
        createdAt: 1,
      },
      {
        ...makeInput({ title: "Missing page: Attention" }),
        id: "review-2",
        resolved: true,
        resolvedAction: "user-resolved",
        createdAt: 2,
      },
    ])

    expect(normalized).toHaveLength(1)
    expect(normalized[0].resolved).toBe(true)
    expect(normalized[0].resolvedAction).toBe("user-resolved")
  })

  it("merges options when duplicate legacy items collapse", () => {
    const normalized = normalizeReviewItems([
      {
        ...makeInput({
          title: "Attention",
          options: [{ label: "Create", action: "create" }],
        }),
        id: "review-1",
        resolved: false,
        createdAt: 1,
      },
      {
        ...makeInput({
          title: "Missing page: Attention",
          options: [{ label: "Skip", action: "skip" }],
        }),
        id: "review-2",
        resolved: false,
        createdAt: 2,
      },
    ])

    expect(normalized).toHaveLength(1)
    expect(normalized[0].options).toEqual([
      { label: "Create", action: "create" },
      { label: "Skip", action: "skip" },
    ])
  })

  it("is idempotent — loading already-stable ids changes nothing", () => {
    const stable = reviewIdFor({ type: "missing-page", title: "Attention" })
    const first = normalizeReviewItems([
      { ...makeInput({ title: "Attention" }), id: stable, resolved: true, resolvedAction: "x", createdAt: 1 },
    ])
    const second = normalizeReviewItems(first)
    expect(second).toHaveLength(1)
    expect(second[0].id).toBe(stable)
    expect(second[0].resolved).toBe(true)
  })

  it("resolve survives a re-ingest of the same source (same id, stays resolved)", () => {
    // End-to-end of the user's scenario: resolve, then ingest re-surfaces
    // the same review via addItems → it keeps its id and resolution.
    let items = foldReviewItems([], [makeInput({ title: "Attention" })])
    const id = items[0].id
    items = items.map((item) =>
      item.id === id ? { ...item, resolved: true, resolvedAction: "user-resolved" } : item
    )
    // simulate queue-shrink rebuild re-emitting the same review
    items = foldReviewItems(items, [makeInput({ title: "Attention", affectedPages: ["regen.md"] })])
    const item = items[0]
    expect(items).toHaveLength(1)
    expect(item.id).toBe(id)
    expect(item.resolved).toBe(true)
  })
})

// ── parseReviewBlocks matrix (from src/lib/ingest.ts) ──────────────

function reviewBlock(type, title, body) {
  return `---REVIEW: ${type} | ${title}---\n${body}\n---END REVIEW---`
}

describe("parseReviewBlocks — type classification", () => {
  it.each(["contradiction", "duplicate", "missing-page", "suggestion"])(
    "known type %s passes through",
    (type) => {
      const items = parseReviewBlocks(reviewBlock(type, "Some title", "Body text."), "sources/a.md")
      expect(items).toHaveLength(1)
      expect(items[0].type).toBe(type)
    },
  )

  it("unknown type falls back to confirm", () => {
    const items = parseReviewBlocks(reviewBlock("weird-type", "Title", "Body."), "s.md")
    expect(items).toHaveLength(1)
    expect(items[0].type).toBe("confirm")
  })

  it("normalizes the header type case and whitespace", () => {
    const text = "---REVIEW:   Missing-Page  |  Title here ---\nBody.\n---END REVIEW---"
    const items = parseReviewBlocks(text, "s.md")
    expect(items).toHaveLength(1)
    expect(items[0].type).toBe("missing-page")
    expect(items[0].title).toBe("Title here")
  })
})

describe("parseReviewBlocks — OPTIONS / PAGES / SEARCH parsing", () => {
  it("parses an OPTIONS line into label/action pairs (action = trimmed label)", () => {
    const body = "Some description.\nOPTIONS: Create page | Skip for now"
    const items = parseReviewBlocks(reviewBlock("suggestion", "T", body), "s.md")
    expect(items[0].options).toEqual([
      { label: "Create page", action: "Create page" },
      { label: "Skip for now", action: "Skip for now" },
    ])
  })

  it("defaults to Approve/Skip options when no OPTIONS line is present", () => {
    const items = parseReviewBlocks(reviewBlock("confirm", "T", "Just a description."), "s.md")
    expect(items[0].options).toEqual([
      { label: "Approve", action: "Approve" },
      { label: "Skip", action: "Skip" },
    ])
  })

  it("parses a PAGES line into a comma-split, trimmed affectedPages", () => {
    const body = "Description.\nPAGES: wiki/a.md , wiki/b.md"
    const items = parseReviewBlocks(reviewBlock("contradiction", "T", body), "s.md")
    expect(items[0].affectedPages).toEqual(["wiki/a.md", "wiki/b.md"])
  })

  it("leaves affectedPages undefined without a PAGES line", () => {
    const items = parseReviewBlocks(reviewBlock("confirm", "T", "Desc."), "s.md")
    expect(items[0].affectedPages).toBeUndefined()
  })

  it("parses a SEARCH line into pipe-split, trimmed queries, dropping empties", () => {
    const body = "Description.\nSEARCH: attention mechanism | transformer paper |"
    const items = parseReviewBlocks(reviewBlock("missing-page", "T", body), "s.md")
    expect(items[0].searchQueries).toEqual(["attention mechanism", "transformer paper"])
  })

  it("leaves searchQueries undefined without a SEARCH line", () => {
    const items = parseReviewBlocks(reviewBlock("confirm", "T", "Desc."), "s.md")
    expect(items[0].searchQueries).toBeUndefined()
  })
})

describe("parseReviewBlocks — description cleanup + general shape", () => {
  it("strips OPTIONS, PAGES and SEARCH lines from the description", () => {
    const body = [
      "First line of the description.",
      "OPTIONS: A | B",
      "PAGES: x.md, y.md",
      "SEARCH: q1 | q2",
      "Last line.",
    ].join("\n")
    const items = parseReviewBlocks(reviewBlock("suggestion", "T", body), "s.md")
    // The replace() calls blank the OPTIONS/PAGES/SEARCH lines but leave
    // their newlines behind (client behavior, ported verbatim).
    expect(items[0].description).toBe("First line of the description.\n\n\n\nLast line.")
  })

  it("extracts title and trims the body", () => {
    const items = parseReviewBlocks(reviewBlock("duplicate", "  Dup check  ", "  Body.  "), "s.md")
    expect(items[0].title).toBe("Dup check")
    expect(items[0].description).toBe("Body.")
  })

  it("passes sourcePath through to every item", () => {
    const text = `${reviewBlock("confirm", "A", "x.")}\n${reviewBlock("duplicate", "B", "y.")}`
    const items = parseReviewBlocks(text, "sources/deep/notes.md")
    expect(items).toHaveLength(2)
    expect(items[0].sourcePath).toBe("sources/deep/notes.md")
    expect(items[1].sourcePath).toBe("sources/deep/notes.md")
  })

  it("parses multiple blocks in one text", () => {
    const text = [
      "prose before",
      reviewBlock("contradiction", "Conflict", "C1."),
      "prose between",
      reviewBlock("missing-page", "Gap", "C2."),
      "prose after",
    ].join("\n")
    const items = parseReviewBlocks(text, "s.md")
    expect(items).toHaveLength(2)
    expect(items[0]).toMatchObject({ type: "contradiction", title: "Conflict" })
    expect(items[1]).toMatchObject({ type: "missing-page", title: "Gap" })
  })

  it("returns an empty array when there are no review blocks", () => {
    expect(parseReviewBlocks("just prose, no blocks", "s.md")).toEqual([])
    expect(parseReviewBlocks("", "s.md")).toEqual([])
  })

  it("ignores an unterminated review block", () => {
    const text = "---REVIEW: confirm | Never closed---\nbody without end marker"
    expect(parseReviewBlocks(text, "s.md")).toEqual([])
  })
})

// ── saveIngestReviewItems — file round-trip ─────────────────────────

describe("saveIngestReviewItems — file round-trip", () => {
  let tmp

  beforeAll(() => {
    tmp = mkdtempSync(path.join(tmpdir(), "llmwiki-reviews-test-"))
  })

  afterAll(() => {
    try { rmSync(tmp, { recursive: true, force: true }) } catch { /* noop */ }
  })

  function reviewJsonPath(projectPath) {
    return path.join(projectPath, ".llm-wiki", "review.json")
  }

  function readReviewJson(projectPath) {
    return JSON.parse(readFileSync(reviewJsonPath(projectPath), "utf8"))
  }

  function seedReviewJson(projectPath, items) {
    mkdirSync(path.join(projectPath, ".llm-wiki"), { recursive: true })
    writeFileSync(reviewJsonPath(projectPath), JSON.stringify(items, null, 2), "utf8")
  }

  it("keeps a resolved item resolved and does not duplicate it", async () => {
    const projectPath = path.join(tmp, "proj-resolved")
    const stableId = reviewIdFor({ type: "missing-page", title: "Attention" })
    seedReviewJson(projectPath, [
      {
        id: stableId,
        type: "missing-page",
        title: "Attention",
        description: "old description",
        sourcePath: "sources/first.md",
        affectedPages: ["wiki/a.md"],
        options: [{ label: "Approve", action: "Approve" }, { label: "Skip", action: "Skip" }],
        resolved: true,
        resolvedAction: "Approve",
        createdAt: 1234,
      },
    ])

    // Same logical review re-surfaces during a later ingest.
    const incoming = parseReviewBlocks(
      reviewBlock("missing-page", "Missing page: Attention", "fresh description\nPAGES: wiki/b.md"),
      "sources/second.md",
    )
    const merged = await saveIngestReviewItems(projectPath, incoming)

    expect(merged).toHaveLength(1)
    const onDisk = readReviewJson(projectPath)
    expect(onDisk).toHaveLength(1)
    expect(onDisk[0].id).toBe(stableId)
    expect(onDisk[0].resolved).toBe(true)
    expect(onDisk[0].resolvedAction).toBe("Approve")
    expect(onDisk[0].createdAt).toBe(1234)
    expect(onDisk[0].affectedPages).toEqual(["wiki/a.md", "wiki/b.md"])
    expect(onDisk[0].description).toBe("fresh description")
  })

  it("assigns stable id, resolved=false and createdAt to genuinely-new items", async () => {
    const projectPath = path.join(tmp, "proj-new")
    const before = Date.now()
    const incoming = parseReviewBlocks(
      reviewBlock("contradiction", "Conflict A", "Two sources disagree."),
      "sources/a.md",
    )
    const merged = await saveIngestReviewItems(projectPath, incoming)

    expect(merged).toHaveLength(1)
    const onDisk = readReviewJson(projectPath)
    expect(onDisk[0].id).toBe(reviewIdFor({ type: "contradiction", title: "Conflict A" }))
    expect(onDisk[0].resolved).toBe(false)
    expect(onDisk[0].resolvedAction).toBeUndefined()
    expect(onDisk[0].createdAt).toBeGreaterThanOrEqual(before)
    expect(onDisk[0].createdAt).toBeLessThanOrEqual(Date.now())
  })

  it("creates .llm-wiki/review.json when it does not exist yet", async () => {
    const projectPath = path.join(tmp, "proj-missing")
    await saveIngestReviewItems(projectPath, [makeInput({ title: "Brand new" })])
    const onDisk = readReviewJson(projectPath)
    expect(onDisk).toHaveLength(1)
    expect(onDisk[0].title).toBe("Brand new")
  })

  it("treats a corrupt review.json as an empty queue", async () => {
    const projectPath = path.join(tmp, "proj-corrupt")
    mkdirSync(path.join(projectPath, ".llm-wiki"), { recursive: true })
    writeFileSync(reviewJsonPath(projectPath), "{not valid json", "utf8")
    await saveIngestReviewItems(projectPath, [makeInput({ title: "After corrupt" })])
    const onDisk = readReviewJson(projectPath)
    expect(onDisk).toHaveLength(1)
    expect(onDisk[0].title).toBe("After corrupt")
  })

  it("migrates legacy counter ids on disk (resolved wins across the remap)", async () => {
    const projectPath = path.join(tmp, "proj-legacy")
    seedReviewJson(projectPath, [
      {
        ...makeInput({ title: "Attention", affectedPages: ["a.md"] }),
        id: "review-6",
        resolved: false,
        createdAt: 5,
      },
      {
        ...makeInput({ title: "Missing page: Attention", affectedPages: ["b.md"] }),
        id: "review-99",
        resolved: true,
        resolvedAction: "user-resolved",
        createdAt: 2,
      },
    ])

    const incoming = parseReviewBlocks(
      reviewBlock("missing-page", "缺失页面: Attention", "resurfaced\nPAGES: c.md"),
      "sources/x.md",
    )
    const merged = await saveIngestReviewItems(projectPath, incoming)

    expect(merged).toHaveLength(1)
    const stableId = reviewIdFor({ type: "missing-page", title: "Attention" })
    expect(merged[0].id).toBe(stableId)
    expect(merged[0].resolved).toBe(true)
    expect(merged[0].resolvedAction).toBe("user-resolved")
    expect(merged[0].createdAt).toBe(2)
    expect(merged[0].affectedPages).toEqual(expect.arrayContaining(["a.md", "b.md", "c.md"]))
    // The file on disk carries the same merged, migrated state.
    expect(readReviewJson(projectPath)).toEqual(merged)
  })

  it("persists items in the exact ReviewItemSchema shape the reviews API reads", async () => {
    const projectPath = path.join(tmp, "proj-schema")
    seedReviewJson(projectPath, [
      {
        id: "review-1",
        type: "suggestion",
        title: "Old item",
        description: "kept as-is",
        options: [],
        resolved: false,
        createdAt: 1,
      },
    ])
    const incoming = parseReviewBlocks(
      reviewBlock(
        "missing-page",
        "Missing page: RoPE",
        "Rotary embeddings deserve a page.\nPAGES: wiki/rope.md\nSEARCH: rope embeddings | rotary position encoding\nOPTIONS: Create | Skip",
      ),
      "sources/paper.md",
    )
    await saveIngestReviewItems(projectPath, incoming)

    const onDisk = readReviewJson(projectPath)
    expect(onDisk).toHaveLength(2)
    for (const item of onDisk) {
      // Throws on any shape mismatch with the api-types contract.
      ReviewItemSchema.parse(item)
    }
    // Spot-check the parsed item made it through with all fields intact.
    const rope = onDisk.find((it) => it.title === "Missing page: RoPE")
    expect(rope.affectedPages).toEqual(["wiki/rope.md"])
    expect(rope.searchQueries).toEqual(["rope embeddings", "rotary position encoding"])
    expect(rope.options).toEqual([
      { label: "Create", action: "Create" },
      { label: "Skip", action: "Skip" },
    ])
  })
})

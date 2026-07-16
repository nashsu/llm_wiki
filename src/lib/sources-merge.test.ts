/**
 * Regression suite for the sources-merge helpers used during ingest.
 *
 * Why this exists: the stage-2 prompt tells the LLM to emit
 * `sources: ["<current>"]` on every FILE block, but doesn't feed the
 * existing page's body in. Without this merge step, each re-ingest
 * would clobber the sources array to a single entry, and the
 * source-delete flow would later treat the page as single-sourced →
 * delete it → lose content contributed by the earlier source.
 *
 * Every failure mode below, if it regressed, would surface as
 * silent data loss on the user's next source-delete.
 */
import { describe, it, expect } from "vitest"
import {
  parseSources,
  writeSources,
  mergeSourcesLists,
  mergeSourcesIntoContent,
  mergeArrayFieldsIntoContent,
  parseFrontmatterArray,
} from "./sources-merge"

const WRAP = (fm: string, body = "body\n") => `---\n${fm}\n---\n${body}`

// ── parseSources ────────────────────────────────────────────────────

describe("parseSources — inline `sources: [...]`", () => {
  it("extracts a single-entry array", () => {
    expect(parseSources(WRAP('sources: ["a.md"]'))).toEqual(["a.md"])
  })

  it("extracts a multi-entry array", () => {
    expect(parseSources(WRAP('sources: ["a.md", "b.md"]'))).toEqual(["a.md", "b.md"])
  })

  it("handles single quotes", () => {
    expect(parseSources(WRAP("sources: ['a.md', 'b.md']"))).toEqual(["a.md", "b.md"])
  })

  it("handles bare (unquoted) entries", () => {
    expect(parseSources(WRAP("sources: [a.md, b.md]"))).toEqual(["a.md", "b.md"])
  })

  it("handles no-space-after-comma", () => {
    expect(parseSources(WRAP('sources: ["a.md","b.md"]'))).toEqual(["a.md", "b.md"])
  })

  it("returns empty array for empty brackets", () => {
    expect(parseSources(WRAP("sources: []"))).toEqual([])
  })

  it("returns empty array when frontmatter has no sources field", () => {
    expect(parseSources(WRAP("title: X"))).toEqual([])
  })

  it("returns empty array when no frontmatter at all", () => {
    expect(parseSources("# heading\n\nbody")).toEqual([])
  })

  it("handles CJK-named source files", () => {
    expect(parseSources(WRAP('sources: ["测试.md", "test.md"]'))).toEqual([
      "测试.md",
      "test.md",
    ])
  })

  it("keeps commas inside quoted source filenames", () => {
    expect(parseSources(WRAP('sources: ["reports/Q1, revised.pdf", "测试，最终版.md"]'))).toEqual([
      "reports/Q1, revised.pdf",
      "测试，最终版.md",
    ])
  })

  it("round-trips source filenames with quotes and backslashes", () => {
    const after = writeSources(WRAP("title: X"), ['drafts/"quoted".md', "folder\\note.md"])

    expect(after).toContain('sources: ["drafts/\\"quoted\\".md", "folder\\\\note.md"]')
    expect(parseSources(after)).toEqual(['drafts/"quoted".md', "folder\\note.md"])
  })
})

describe("parseSources — multi-line YAML list form", () => {
  it("extracts a multi-line list", () => {
    const content = WRAP(
      ["sources:", "  - a.md", "  - b.md"].join("\n"),
    )
    expect(parseSources(content)).toEqual(["a.md", "b.md"])
  })

  it("handles quoted multi-line entries", () => {
    const content = WRAP(
      ["sources:", '  - "a.md"', "  - 'b.md'"].join("\n"),
    )
    expect(parseSources(content)).toEqual(["a.md", "b.md"])
  })
})

// ── writeSources ────────────────────────────────────────────────────

describe("writeSources", () => {
  it("replaces an existing inline sources array", () => {
    const before = WRAP('title: X\nsources: ["a.md"]')
    const after = writeSources(before, ["a.md", "b.md"])
    expect(parseSources(after)).toEqual(["a.md", "b.md"])
    // Other frontmatter fields preserved.
    expect(after).toContain("title: X")
  })

  it("preserves field order (sources stays in its original position)", () => {
    const before = WRAP('title: X\nsources: ["a.md"]\ntags: []')
    const after = writeSources(before, ["a.md", "b.md"])
    const fmLines = after
      .match(/^---\n([\s\S]*?)\n---/)![1]
      .split("\n")
      .map((l) => l.split(":")[0].trim())
    expect(fmLines).toEqual(["title", "sources", "tags"])
  })

  it("inserts a sources field when none exists", () => {
    const before = WRAP("title: X\ntags: []")
    const after = writeSources(before, ["a.md"])
    expect(parseSources(after)).toEqual(["a.md"])
    expect(after).toContain("title: X")
    expect(after).toContain("tags: []")
  })

  it("collapses multi-line YAML list form into inline form", () => {
    const before = WRAP(
      ["title: X", "sources:", "  - a.md", "  - b.md"].join("\n"),
    )
    const after = writeSources(before, ["a.md", "b.md", "c.md"])
    expect(parseSources(after)).toEqual(["a.md", "b.md", "c.md"])
    expect(after).toContain('sources: ["a.md", "b.md", "c.md"]')
    // Multi-line artefacts removed.
    expect(after).not.toMatch(/^\s+-\s+a\.md/m)
  })

  it("returns content unchanged when there is no frontmatter", () => {
    const before = "# heading\n\nbody"
    expect(writeSources(before, ["a.md"])).toBe(before)
  })

  it("preserves the body of the document", () => {
    const before = WRAP(
      'title: X\nsources: ["a.md"]',
      "# Title\n\nLots of prose here.\nAnd more prose.",
    )
    const after = writeSources(before, ["a.md", "b.md"])
    expect(after).toContain("# Title")
    expect(after).toContain("Lots of prose here.")
    expect(after).toContain("And more prose.")
  })
})

// ── mergeSourcesLists ───────────────────────────────────────────────

describe("mergeSourcesLists", () => {
  it("unions disjoint lists in order", () => {
    expect(mergeSourcesLists(["a.md"], ["b.md"])).toEqual(["a.md", "b.md"])
  })

  it("dedupes exact duplicates", () => {
    expect(mergeSourcesLists(["a.md"], ["a.md"])).toEqual(["a.md"])
  })

  it("dedupes case-insensitively, keeping the existing casing", () => {
    expect(mergeSourcesLists(["Test.md"], ["test.md"])).toEqual(["Test.md"])
  })

  it("preserves order of existing entries", () => {
    expect(mergeSourcesLists(["b.md", "a.md"], ["c.md"])).toEqual([
      "b.md",
      "a.md",
      "c.md",
    ])
  })

  it("is a no-op for empty+empty", () => {
    expect(mergeSourcesLists([], [])).toEqual([])
  })

  it("preserves existing when incoming is empty", () => {
    expect(mergeSourcesLists(["a.md", "b.md"], [])).toEqual(["a.md", "b.md"])
  })

  it("preserves incoming when existing is empty", () => {
    expect(mergeSourcesLists([], ["a.md", "b.md"])).toEqual(["a.md", "b.md"])
  })
})

// ── mergeSourcesIntoContent — the real ingest entry point ──────────

describe("mergeSourcesIntoContent — happy paths", () => {
  it("returns newContent unchanged when page is new (no existingContent)", () => {
    const newContent = WRAP('sources: ["test2.md"]')
    expect(mergeSourcesIntoContent(newContent, null)).toBe(newContent)
  })

  it("merges sources when the page already exists with a different source", () => {
    const existing = WRAP('sources: ["test1.md"]', "old body")
    const incoming = WRAP('sources: ["test2.md"]', "fresh body from re-ingest")
    const merged = mergeSourcesIntoContent(incoming, existing)
    expect(parseSources(merged)).toEqual(["test1.md", "test2.md"])
    // Body is the NEW body — this function only rewrites the sources
    // field, it doesn't preserve old content.
    expect(merged).toContain("fresh body from re-ingest")
    expect(merged).not.toContain("old body")
  })

  it("idempotent: merging the same current source is a no-op on sources", () => {
    const existing = WRAP('sources: ["test1.md", "test2.md"]')
    const incoming = WRAP('sources: ["test1.md"]')
    const merged = mergeSourcesIntoContent(incoming, existing)
    expect(parseSources(merged)).toEqual(["test1.md", "test2.md"])
  })

  it("short-circuits (returns newContent verbatim) when old is a subset of new", () => {
    // Covers the no-op optimization branch: when the merged list
    // equals newSources element-for-element, the function should hand
    // back the unchanged newContent string (same reference, no
    // rewrite). Exercises the `merged === newSources` fast path.
    const existing = WRAP('sources: ["a.md"]')
    const incoming = WRAP('sources: ["a.md"]', "body content")
    const merged = mergeSourcesIntoContent(incoming, existing)
    // Same reference — no writeSources call happened.
    expect(merged).toBe(incoming)
  })

  it("handles case-insensitive source filenames (keeps original casing)", () => {
    const existing = WRAP('sources: ["Test1.md"]')
    const incoming = WRAP('sources: ["test1.md"]')
    const merged = mergeSourcesIntoContent(incoming, existing)
    // Should be a single entry with the existing (original) casing,
    // not a duplicate.
    expect(parseSources(merged)).toEqual(["Test1.md"])
  })

  it("appends the new source to an already multi-source page", () => {
    const existing = WRAP('sources: ["a.md", "b.md"]')
    const incoming = WRAP('sources: ["c.md"]')
    const merged = mergeSourcesIntoContent(incoming, existing)
    expect(parseSources(merged)).toEqual(["a.md", "b.md", "c.md"])
  })
})

describe("mergeSourcesIntoContent — degenerate inputs", () => {
  it("is a no-op when existingContent has no sources field at all", () => {
    // Pre-0.3.x pages without sources field should not spontaneously
    // acquire phantom sources from the existing file.
    const existing = WRAP("title: X")
    const incoming = WRAP('sources: ["test2.md"]')
    expect(mergeSourcesIntoContent(incoming, existing)).toBe(incoming)
  })

  it("is a no-op when existingContent is empty string", () => {
    const incoming = WRAP('sources: ["test2.md"]')
    expect(mergeSourcesIntoContent(incoming, "")).toBe(incoming)
  })

  it("tolerates newContent missing a sources field (LLM slipup)", () => {
    // If the LLM forgot to emit sources in the new content but the
    // existing page has one, we should NOT drop the existing sources.
    const existing = WRAP('sources: ["test1.md"]')
    const incomingNoSources = WRAP("title: X")
    const merged = mergeSourcesIntoContent(incomingNoSources, existing)
    expect(parseSources(merged)).toEqual(["test1.md"])
  })

  it("tolerates existingContent with no frontmatter at all", () => {
    const existing = "# legacy non-frontmatter page"
    const incoming = WRAP('sources: ["test2.md"]')
    expect(mergeSourcesIntoContent(incoming, existing)).toBe(incoming)
  })
})

// ── The end-to-end scenario that motivated this module ────────────

describe("Regression: the data-loss path in the user's diagnosis", () => {
  it("two ingests against the same page result in union, not last-wins", () => {
    // Step 1 of user's failure scenario: ingest test1.md creates
    // attention.md with sources=[test1.md].
    const afterFirstIngest = mergeSourcesIntoContent(
      WRAP('title: Attention\nsources: ["test1.md"]', "content from test1"),
      null,
    )
    expect(parseSources(afterFirstIngest)).toEqual(["test1.md"])

    // Step 2: ingest test2.md, which also covers attention. LLM emits
    // `sources: ["test2.md"]` per the prompt template, but we merge
    // before writing — so the on-disk sources field becomes BOTH.
    const afterSecondIngest = mergeSourcesIntoContent(
      WRAP('title: Attention\nsources: ["test2.md"]', "content from test2"),
      afterFirstIngest,
    )
    expect(parseSources(afterSecondIngest)).toEqual(["test1.md", "test2.md"])

    // Step 3: user later deletes test2.md. sources-view's deletion
    // flow reads sources = ["test1.md", "test2.md"] (length 2),
    // recognises the page is shared, and keeps it on disk — no data
    // loss. Before this fix, step 2 would have clobbered sources to
    // just ["test2.md"], and step 3 would have deleted the page.
    const remainingSourcesAfterDeletingTest2 = parseSources(afterSecondIngest)
      .filter((s) => s.toLowerCase() !== "test2.md")
    expect(remainingSourcesAfterDeletingTest2).toEqual(["test1.md"])
  })

  it("three-way re-ingest: each ingest contributes its own source to the union", () => {
    let page = mergeSourcesIntoContent(
      WRAP('sources: ["a.md"]', "body v1"),
      null,
    )
    page = mergeSourcesIntoContent(
      WRAP('sources: ["b.md"]', "body v2"),
      page,
    )
    page = mergeSourcesIntoContent(
      WRAP('sources: ["c.md"]', "body v3"),
      page,
    )
    expect(parseSources(page)).toEqual(["a.md", "b.md", "c.md"])
    // Body is always the most recent emission — we don't diff-merge
    // the body, only the sources list.
    expect(page).toContain("body v3")
    expect(page).not.toContain("body v1")
    expect(page).not.toContain("body v2")
  })
})

// ── parseFrontmatterArray (generalized parser) ────────────────────

describe("parseFrontmatterArray", () => {
  it("parses an inline-form array for any field name", () => {
    expect(parseFrontmatterArray(WRAP("tags: [a, b, c]"), "tags")).toEqual([
      "a", "b", "c",
    ])
  })

  it("parses block-form array (key: + - item lines) for any field", () => {
    const fm = `related:\n  - foo\n  - bar`
    expect(parseFrontmatterArray(WRAP(fm), "related")).toEqual(["foo", "bar"])
  })

  it("strips quotes around items", () => {
    expect(
      parseFrontmatterArray(WRAP('tags: ["a", "b"]'), "tags"),
    ).toEqual(["a", "b"])
  })

  it("returns [] when the field doesn't exist", () => {
    expect(parseFrontmatterArray(WRAP("title: X"), "tags")).toEqual([])
  })

  it("returns [] when content has no frontmatter", () => {
    expect(parseFrontmatterArray("# plain markdown", "tags")).toEqual([])
  })

  it("doesn't mistake one field for another with similar prefix", () => {
    // `related:` shouldn't accidentally match when we ask for `relate`.
    const c = WRAP("related: [a, b]")
    expect(parseFrontmatterArray(c, "relate")).toEqual([])
    expect(parseFrontmatterArray(c, "related")).toEqual(["a", "b"])
  })
})

// ── mergeArrayFieldsIntoContent (multi-field union merge) ─────────

describe("mergeArrayFieldsIntoContent", () => {
  it("merges sources / tags / related as a union of old and new", () => {
    const existing = WRAP(
      'sources: ["a.md"]\ntags: [old-tag]\nrelated: [old-rel]',
    )
    const incoming = WRAP(
      'sources: ["b.md"]\ntags: [new-tag]\nrelated: [new-rel]',
      "new body",
    )
    const merged = mergeArrayFieldsIntoContent(incoming, existing, [
      "sources",
      "tags",
      "related",
    ])
    expect(parseFrontmatterArray(merged, "sources")).toEqual(["a.md", "b.md"])
    expect(parseFrontmatterArray(merged, "tags")).toEqual(["old-tag", "new-tag"])
    expect(parseFrontmatterArray(merged, "related")).toEqual([
      "old-rel",
      "new-rel",
    ])
    // Body always comes from incoming (no body merge here — that's
    // page-merge.ts's job).
    expect(merged).toContain("new body")
  })

  it("dedupes case-insensitively across all fields", () => {
    const existing = WRAP("tags: [Foo, BAR]")
    const incoming = WRAP("tags: [foo, bar, baz]")
    const merged = mergeArrayFieldsIntoContent(incoming, existing, ["tags"])
    // First-seen casing wins ("Foo" / "BAR"), but new entry "baz" is added.
    expect(parseFrontmatterArray(merged, "tags")).toEqual(["Foo", "BAR", "baz"])
  })

  it("preserves a field that exists in old but is missing from new", () => {
    // LLM forgot to emit `tags` in this ingest; existing tags must
    // survive — analogous to the existing sources-protection guarantee.
    const existing = WRAP("tags: [persistent]")
    const incoming = WRAP("title: X")
    const merged = mergeArrayFieldsIntoContent(incoming, existing, ["tags"])
    expect(parseFrontmatterArray(merged, "tags")).toEqual(["persistent"])
  })

  it("is a no-op when neither old nor new have any of the requested fields", () => {
    const existing = WRAP("title: X")
    const incoming = WRAP("title: Y")
    expect(
      mergeArrayFieldsIntoContent(incoming, existing, ["sources", "tags"]),
    ).toBe(incoming)
  })

  it("returns newContent unchanged when existingContent is null (new page)", () => {
    const incoming = WRAP("tags: [a]\nrelated: [b]")
    expect(mergeArrayFieldsIntoContent(incoming, null, ["tags", "related"])).toBe(
      incoming,
    )
  })

  it("merges only the fields the caller asked for", () => {
    const existing = WRAP("sources: [a.md]\ntags: [old]")
    const incoming = WRAP("sources: [b.md]\ntags: [new]")
    // Asking only for sources — tags is left as the new content's value.
    const merged = mergeArrayFieldsIntoContent(incoming, existing, ["sources"])
    expect(parseFrontmatterArray(merged, "sources")).toEqual(["a.md", "b.md"])
    expect(parseFrontmatterArray(merged, "tags")).toEqual(["new"])
  })

  it("preserves source-merge backward compatibility when called for `sources` only", () => {
    // Verifies the new function reproduces mergeSourcesIntoContent's
    // exact behavior for a sources-only call. If this drifts, the
    // older callers (sources-view etc.) would silently be affected.
    const existing = WRAP('sources: ["a.md"]')
    const incoming = WRAP('sources: ["b.md"]', "new body")
    const a = mergeSourcesIntoContent(incoming, existing)
    const b = mergeArrayFieldsIntoContent(incoming, existing, ["sources"])
    expect(parseSources(b)).toEqual(parseSources(a))
    expect(b).toContain("new body")
  })
})

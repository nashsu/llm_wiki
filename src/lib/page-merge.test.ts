/**
 * Tests for the page-merge layer that decides what content to write
 * when an ingest produces a wiki page that already exists on disk.
 *
 * The merger function (LLM call) is injected so these tests run
 * deterministically without hitting any model. A separate real-llm
 * test suite exercises the wired-up production path against the
 * actual generation model.
 */
import { describe, it, expect, vi } from "vitest"
import { mergePageContent } from "./page-merge"

const PAGE = (fm: string, body: string) => `---\n${fm}\n---\n\n${body}`

const FIXED_TODAY = () => "2026-04-30"
const baseOpts = {
  sourceFileName: "doc-B.pdf",
  pagePath: "wiki/entities/foo.md",
  today: FIXED_TODAY,
}

// ──────────────────────────────────────────────────────────────────
// Fast paths — no LLM call should happen
// ──────────────────────────────────────────────────────────────────

describe("mergePageContent — fast paths", () => {
  it("returns newContent when existingContent is null (new page)", async () => {
    const merger = vi.fn()
    const out = await mergePageContent(
      PAGE('type: entity\ntitle: Foo\nsources: ["doc.pdf"]', "body"),
      null,
      merger,
      baseOpts,
    )
    expect(out).toContain('sources: ["doc.pdf"]')
    expect(merger).not.toHaveBeenCalled()
  })

  it("returns existingContent when both contents are byte-identical", async () => {
    const merger = vi.fn()
    const c = PAGE("type: entity\ntitle: Foo", "body")
    const out = await mergePageContent(c, c, merger, baseOpts)
    expect(out).toBe(c)
    expect(merger).not.toHaveBeenCalled()
  })

  it("skips LLM when bodies are identical (only sources differ)", async () => {
    // Re-ingest of the same file from a different source just adds
    // its source filename — body is byte-identical. Don't waste an
    // LLM call on this.
    const merger = vi.fn()
    const existing = PAGE(
      'type: entity\ntitle: Foo\nsources: ["a.pdf"]',
      "same body",
    )
    const incoming = PAGE(
      'type: entity\ntitle: Foo\nsources: ["b.pdf"]',
      "same body",
    )
    const out = await mergePageContent(incoming, existing, merger, baseOpts)
    expect(out).toContain('sources: ["a.pdf", "b.pdf"]')
    expect(out).toContain("same body")
    expect(merger).not.toHaveBeenCalled()
  })
})

// ──────────────────────────────────────────────────────────────────
// LLM merge happy path
// ──────────────────────────────────────────────────────────────────

describe("mergePageContent — LLM merge", () => {
  it("calls the merger when bodies differ and uses the merged output", async () => {
    const existing = PAGE(
      'type: entity\ntitle: Accumulibacter\ncreated: 2026-04-09\ntags: [microbiology, ebpr]\nrelated: [dpao, vfa]\nsources: ["doc-A.pdf"]',
      "## Anaerobic Phase\n\nDescription from doc A.\n\n## Denitrification\n\nMore from doc A.",
    )
    const incoming = PAGE(
      'type: entity\ntitle: Accumulibacter\ncreated: 2026-04-30\ntags: [paos, propionate]\nrelated: [pha]\nsources: ["doc-B.pdf"]',
      "## Carbon Source Preferences\n\nDescription from doc B.\n\n## Acetate vs Propionate\n\nMore from doc B.",
    )
    const mergedBody = "## Anaerobic Phase\n\nDescription from doc A.\n\n## Denitrification\n\nMore from doc A.\n\n## Carbon Source Preferences\n\nDescription from doc B.\n\n## Acetate vs Propionate\n\nMore from doc B."
    const merger = vi.fn().mockResolvedValue(
      PAGE(
        // LLM might also output frontmatter — we'll override locked fields.
        'type: entity\ntitle: Accumulibacter\ncreated: 2026-04-09\ntags: [paos, propionate]\nrelated: [pha]\nsources: ["doc-B.pdf"]',
        mergedBody,
      ),
    )
    const out = await mergePageContent(incoming, existing, merger, baseOpts)

    expect(merger).toHaveBeenCalledOnce()

    // Body uses LLM-merged version
    expect(out).toContain("Anaerobic Phase")
    expect(out).toContain("Carbon Source Preferences")

    // Locked fields preserved from existing
    expect(out).toContain("title: Accumulibacter")
    expect(out).toContain("created: 2026-04-09")
    expect(out).toContain("type: entity")

    // updated forced to today
    expect(out).toContain("updated: 2026-04-30")

    // Array fields are unions
    expect(out).toMatch(/sources:\s*\[\s*"doc-A.pdf",\s*"doc-B.pdf"\s*\]/)
    expect(out).toMatch(/tags:\s*\[\s*"microbiology",\s*"ebpr",\s*"paos",\s*"propionate"\s*\]/)
    expect(out).toMatch(/related:\s*\[\s*"dpao",\s*"vfa",\s*"pha"\s*\]/)
  })

  it("preserves locked title even if LLM rewrote it", async () => {
    // Title changes break wikilinks — never accept LLM-rewritten title.
    const existing = PAGE("type: entity\ntitle: Accumulibacter", "old body content here")
    const incoming = PAGE("type: entity\ntitle: Accumulibacter", "very different new body here")
    const merger = vi.fn().mockResolvedValue(
      PAGE("type: entity\ntitle: ACCUMULIBACTER (renamed)", "merged body that is reasonably long enough to pass the threshold check"),
    )
    const out = await mergePageContent(incoming, existing, merger, baseOpts)
    expect(out).toContain("title: Accumulibacter")
    expect(out).not.toContain("ACCUMULIBACTER (renamed)")
  })

  it("preserves locked type even if LLM changed it", async () => {
    const existing = PAGE("type: entity\ntitle: Foo", "original body content")
    const incoming = PAGE("type: entity\ntitle: Foo", "new content from another source")
    const merger = vi.fn().mockResolvedValue(
      PAGE("type: concept\ntitle: Foo", "merged body that is long enough to clear the seventy percent threshold"),
    )
    const out = await mergePageContent(incoming, existing, merger, baseOpts)
    expect(out).toContain("type: entity")
    expect(out).not.toContain("type: concept")
  })
})

// ──────────────────────────────────────────────────────────────────
// LLM failure / sanity rejection — always falls back safely
// ──────────────────────────────────────────────────────────────────

describe("mergePageContent — LLM failure fallback", () => {
  it("falls back to array-merged incoming when LLM throws", async () => {
    const existing = PAGE(
      'type: entity\ntitle: Foo\ntags: [old]\nsources: ["a.pdf"]',
      "old body content",
    )
    const incoming = PAGE(
      'type: entity\ntitle: Foo\ntags: [new]\nsources: ["b.pdf"]',
      "new body content",
    )
    const merger = vi.fn().mockRejectedValue(new Error("LLM rate limited"))
    const out = await mergePageContent(incoming, existing, merger, baseOpts)

    // Array fields are still merged (no LLM needed for that)
    expect(out).toMatch(/tags:\s*\[\s*"old",\s*"new"\s*\]/)
    expect(out).toMatch(/sources:\s*\[\s*"a.pdf",\s*"b.pdf"\s*\]/)
    // Body is the new (incoming) one — old body is lost; this is the
    // pre-LLM-merge behavior, the documented fallback contract.
    expect(out).toContain("new body content")
  })

  it("rejects LLM output that shrinks body below 70% of max(old, new)", async () => {
    const longBody = "long body content ".repeat(200) // ~3600 chars
    const existing = PAGE("type: entity\ntitle: Foo", longBody)
    const incoming = PAGE("type: entity\ntitle: Foo", "incoming body that is also pretty long " + longBody)
    const merger = vi.fn().mockResolvedValue(
      PAGE("type: entity\ntitle: Foo", "tiny merged body"),
    )
    const out = await mergePageContent(incoming, existing, merger, baseOpts)
    // Should fall back to incoming (array-merged) — not the tiny LLM output
    expect(out).not.toContain("tiny merged body")
    expect(out).toContain("incoming body that is also pretty long")
  })

  it("rejects LLM output that has no frontmatter at all", async () => {
    const existing = PAGE("type: entity\ntitle: Foo", "old body content here")
    const incoming = PAGE("type: entity\ntitle: Foo", "new body content here")
    const merger = vi.fn().mockResolvedValue(
      "raw markdown with no frontmatter at all and definitely no opening triple-dash",
    )
    const out = await mergePageContent(incoming, existing, merger, baseOpts)
    // Falls back to incoming — never writes frontmatter-less output to disk
    expect(out.startsWith("---")).toBe(true)
    expect(out).toContain("new body content here")
  })

  it("calls the optional backup callback when falling back", async () => {
    const existing = PAGE("type: entity\ntitle: Foo", "old body")
    const incoming = PAGE("type: entity\ntitle: Foo", "new body")
    const backup = vi.fn().mockResolvedValue(undefined)
    const merger = vi.fn().mockRejectedValue(new Error("network error"))
    await mergePageContent(incoming, existing, merger, {
      ...baseOpts,
      backup,
    })
    expect(backup).toHaveBeenCalledWith(existing)
  })

  it("does not call backup when LLM merge succeeds", async () => {
    const existing = PAGE("type: entity\ntitle: Foo", "old body")
    const incoming = PAGE("type: entity\ntitle: Foo", "new body content")
    const backup = vi.fn().mockResolvedValue(undefined)
    const merger = vi.fn().mockResolvedValue(
      PAGE("type: entity\ntitle: Foo", "merged body that is long enough to clear the threshold check"),
    )
    await mergePageContent(incoming, existing, merger, {
      ...baseOpts,
      backup,
    })
    expect(backup).not.toHaveBeenCalled()
  })

  it("backup failure is swallowed (best-effort, never blocks the write)", async () => {
    const existing = PAGE("type: entity\ntitle: Foo", "old body")
    const incoming = PAGE("type: entity\ntitle: Foo", "new body content")
    const backup = vi.fn().mockRejectedValue(new Error("disk full"))
    const merger = vi.fn().mockRejectedValue(new Error("network error"))

    // Should still resolve — backup error must not propagate
    const out = await mergePageContent(incoming, existing, merger, {
      ...baseOpts,
      backup,
    })
    expect(out).toContain("new body content")
  })
})

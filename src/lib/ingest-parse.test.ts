/**
 * Regression suite for the FILE-block parser in `ingest.ts`.
 *
 * This started life as a diagnostic harness that documented every
 * silent-drop failure mode (H1/H2/H3/H5/H6) against the naive regex.
 * The file now pins down the FIXED behavior of `parseFileBlocks`:
 *
 *   - H1 CRLF input is normalized to LF.
 *   - H2 stream truncation surfaces as a warning (can't fabricate
 *     content the LLM never sent; at least make the drop visible).
 *   - H3 whitespace/case variants on both markers are accepted.
 *   - H5 literal `---END FILE---` inside a fenced code block is
 *     treated as body text (fence-aware scanner).
 *   - H6 empty path surfaces as a warning instead of silently
 *     continuing.
 *
 * A failing test here means the fix regressed — the parser is back
 * to dropping pages without telling anyone.
 */
import { describe, it, expect } from "vitest"
import { parseFileBlocks, isSafeIngestPath } from "./ingest"

// ── Happy paths ─────────────────────────────────────────────────────

describe("parseFileBlocks — canonical shapes", () => {
  it("extracts a single well-formed block", () => {
    const text = [
      "---FILE: wiki/concepts/rope.md---",
      "# RoPE",
      "Rotary positional embedding.",
      "---END FILE---",
    ].join("\n")
    const { blocks, warnings } = parseFileBlocks(text)
    expect(warnings).toHaveLength(0)
    expect(blocks).toHaveLength(1)
    expect(blocks[0].path).toBe("wiki/concepts/rope.md")
    expect(blocks[0].content).toContain("# RoPE")
  })

  it("extracts multiple consecutive blocks", () => {
    const text = [
      "---FILE: wiki/entities/qwen.md---",
      "# Qwen",
      "---END FILE---",
      "",
      "---FILE: wiki/concepts/moe.md---",
      "# MoE",
      "---END FILE---",
      "",
      "---FILE: wiki/sources/paper.md---",
      "# Source summary",
      "---END FILE---",
    ].join("\n")
    const { blocks, warnings } = parseFileBlocks(text)
    expect(warnings).toHaveLength(0)
    expect(blocks.map((b) => b.path)).toEqual([
      "wiki/entities/qwen.md",
      "wiki/concepts/moe.md",
      "wiki/sources/paper.md",
    ])
  })

  it("accepts hyphenated paths", () => {
    const text = [
      "---FILE: wiki/concepts/multi-head-attention.md---",
      "body",
      "---END FILE---",
    ].join("\n")
    expect(parseFileBlocks(text).blocks).toHaveLength(1)
  })

  it("ignores preamble prose before the first block", () => {
    const text = [
      "Here are the wiki files:",
      "",
      "---FILE: wiki/concepts/foo.md---",
      "body",
      "---END FILE---",
    ].join("\n")
    expect(parseFileBlocks(text).blocks).toHaveLength(1)
  })
})

// ── H1: CRLF normalization ─────────────────────────────────────────

describe("parseFileBlocks — H1: CRLF line endings", () => {
  it("extracts all blocks when input uses Windows CRLF", () => {
    const text = [
      "---FILE: wiki/entities/qwen.md---",
      "# Qwen",
      "---END FILE---",
      "",
      "---FILE: wiki/concepts/moe.md---",
      "# MoE",
      "---END FILE---",
    ].join("\r\n")
    const { blocks, warnings } = parseFileBlocks(text)
    expect(warnings).toHaveLength(0)
    expect(blocks).toHaveLength(2)
    expect(blocks.map((b) => b.path)).toEqual([
      "wiki/entities/qwen.md",
      "wiki/concepts/moe.md",
    ])
    // Content should have LF only (normalized).
    for (const b of blocks) {
      expect(b.content).not.toMatch(/\r/)
    }
  })

  it("handles mixed CRLF body with LF markers", () => {
    const text =
      "---FILE: wiki/concepts/foo.md---\nline1\r\nline2\r\n---END FILE---"
    const { blocks } = parseFileBlocks(text)
    expect(blocks).toHaveLength(1)
    expect(blocks[0].content).toBe("line1\nline2")
  })
})

// ── H2: Stream truncation ──────────────────────────────────────────

describe("parseFileBlocks — H2: truncated streams (surface, don't hide)", () => {
  it("emits a warning when the final block has no closer", () => {
    const text = [
      "---FILE: wiki/entities/qwen.md---",
      "# Qwen",
      "---END FILE---",
      "",
      "---FILE: wiki/concepts/moe.md---",
      "# Mixture of Exp", // stream cut here
    ].join("\n")
    const { blocks, warnings } = parseFileBlocks(text)
    // Completed block makes it through.
    expect(blocks).toHaveLength(1)
    expect(blocks[0].path).toBe("wiki/entities/qwen.md")
    // Unclosed block is surfaced as a warning rather than silently lost.
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(/wiki\/concepts\/moe\.md/)
    expect(warnings[0]).toMatch(/not closed/i)
  })

  it("warns when the only block is unclosed", () => {
    const text = "---FILE: wiki/concepts/rope.md---\n# RoPE\nIt rotates"
    const { blocks, warnings } = parseFileBlocks(text)
    expect(blocks).toHaveLength(0)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(/rope\.md/)
  })
})

// ── H3: Marker whitespace / case variants ──────────────────────────

describe("parseFileBlocks — H3: tolerant marker matching", () => {
  it("accepts `--- END FILE ---` (inner spaces)", () => {
    const text = [
      "---FILE: wiki/concepts/foo.md---",
      "body",
      "--- END FILE ---",
    ].join("\n")
    expect(parseFileBlocks(text).blocks).toHaveLength(1)
  })

  it("accepts `---end file---` (lowercase)", () => {
    const text = [
      "---FILE: wiki/concepts/foo.md---",
      "body",
      "---end file---",
    ].join("\n")
    expect(parseFileBlocks(text).blocks).toHaveLength(1)
  })

  it("accepts `--- FILE: path ---` (spaces after leading dashes)", () => {
    const text = [
      "--- FILE: wiki/concepts/foo.md ---",
      "body",
      "---END FILE---",
    ].join("\n")
    const { blocks } = parseFileBlocks(text)
    expect(blocks).toHaveLength(1)
    expect(blocks[0].path).toBe("wiki/concepts/foo.md")
  })

  it("tolerates trailing whitespace on the opener line", () => {
    const text = "---FILE: wiki/concepts/foo.md---   \nbody\n---END FILE---"
    expect(parseFileBlocks(text).blocks).toHaveLength(1)
  })

  it("rejects marker variants embedded in prose / list items", () => {
    // `---END FILE---` inside a list item is NOT on its own line, so
    // must not end the block. The regex is anchored ^...$.
    const text = [
      "---FILE: wiki/concepts/foo.md---",
      "Not to be written:",
      "- `---END FILE---` in backticks (this is prose)",
      "real content continues",
      "---END FILE---",
    ].join("\n")
    const { blocks } = parseFileBlocks(text)
    expect(blocks).toHaveLength(1)
    expect(blocks[0].content).toContain("real content continues")
  })
})

// ── H5: Literal markers inside fenced code blocks ──────────────────

describe("parseFileBlocks — H5: code-fence awareness", () => {
  it("treats `---END FILE---` inside a fenced code block as body text", () => {
    // This is the user-reported scenario: the LLM writes a concept
    // page about the ingest format, which naturally quotes the literal
    // marker in a code example. Naive parsers truncate the outer block
    // at the first inner marker; the fence-aware parser keeps going.
    const text = [
      "---FILE: wiki/concepts/ingest-format.md---",
      "# Ingest Format",
      "",
      "Example of a FILE block:",
      "",
      "```plaintext",
      "---FILE: wiki/path/to/page.md---",
      "body content",
      "---END FILE---", // inside a fence — must be ignored
      "```",
      "",
      "More explanation after the example.",
      "---END FILE---", // the real closer
    ].join("\n")
    const { blocks, warnings } = parseFileBlocks(text)
    expect(warnings).toHaveLength(0)
    expect(blocks).toHaveLength(1)
    expect(blocks[0].path).toBe("wiki/concepts/ingest-format.md")
    // Content must include BOTH the fenced example AND the post-fence
    // prose — which the old parser silently dropped.
    expect(blocks[0].content).toContain("```plaintext")
    expect(blocks[0].content).toContain("More explanation after the example.")
  })

  it("handles multiple fenced blocks in one page", () => {
    const text = [
      "---FILE: wiki/concepts/foo.md---",
      "```",
      "---END FILE---",
      "```",
      "",
      "prose",
      "",
      "~~~",
      "---END FILE---",
      "~~~",
      "",
      "more prose",
      "---END FILE---",
    ].join("\n")
    const { blocks } = parseFileBlocks(text)
    expect(blocks).toHaveLength(1)
    expect(blocks[0].content).toContain("more prose")
  })

  it("handles nested-length fences per CommonMark (outer 4-tick, inner 3-tick)", () => {
    const text = [
      "---FILE: wiki/concepts/foo.md---",
      "````markdown",
      "```",
      "---END FILE---",
      "```",
      "````",
      "",
      "real content after the outer fence closes",
      "---END FILE---",
    ].join("\n")
    const { blocks } = parseFileBlocks(text)
    expect(blocks).toHaveLength(1)
    expect(blocks[0].content).toContain("real content after the outer fence closes")
  })

  it("a 3-tick fence does NOT close a 4-tick opener (CommonMark rule)", () => {
    // Inside a ```` fence, a ``` line is just content, NOT a close.
    // If we wrongly treated 3-tick as closing, `---END FILE---` after
    // it would exit the block prematurely.
    const text = [
      "---FILE: wiki/concepts/foo.md---",
      "````",
      "```",
      "---END FILE---", // still inside the 4-tick fence
      "```",
      "````",
      "",
      "real content",
      "---END FILE---",
    ].join("\n")
    const { blocks } = parseFileBlocks(text)
    expect(blocks).toHaveLength(1)
    expect(blocks[0].content).toContain("real content")
  })
})

// ── H6: Empty path ──────────────────────────────────────────────────

describe("parseFileBlocks — H6: empty-path blocks", () => {
  it("surfaces a warning instead of silently dropping empty-path blocks", () => {
    const text = "---FILE:   ---\nsome body\n---END FILE---"
    const { blocks, warnings } = parseFileBlocks(text)
    // The OPENER_LINE regex requires at least one non-whitespace char
    // in the path capture group via `(.+?)`, so " " technically
    // captures the space and trims to empty → empty-path warning.
    // In either case, the block must NOT produce a silent write.
    expect(blocks).toHaveLength(0)
    expect(warnings.length).toBeGreaterThan(0)
  })
})

// ── Path traversal guard (security) ─────────────────────────────────
//
// A malicious source document can carry prompt injection that tries
// to redirect generated FILE blocks outside the wiki/ tree. Without
// the path guard, the LLM could be coerced into writing to
// `../../../etc/passwd` or similar and our writer would happily do it
// (fs.rs::write_file does no sandboxing — it's a generic command).
// These tests pin every traversal vector we've thought of so a
// regression that loosens the regex shows up immediately.

describe("isSafeIngestPath — what the validator accepts and rejects", () => {
  it("accepts canonical wiki paths", () => {
    expect(isSafeIngestPath("wiki/concepts/foo.md")).toBe(true)
    expect(isSafeIngestPath("wiki/index.md")).toBe(true)
    expect(isSafeIngestPath("wiki/sources/some-paper.md")).toBe(true)
    expect(isSafeIngestPath("wiki/entities/transformer.md")).toBe(true)
  })

  it("rejects empty / whitespace-only paths", () => {
    expect(isSafeIngestPath("")).toBe(false)
    expect(isSafeIngestPath("   ")).toBe(false)
    expect(isSafeIngestPath("\t\n")).toBe(false)
  })

  it("rejects paths outside wiki/ (no leading wiki/ prefix)", () => {
    // Even relative-looking paths that don't start with wiki/ get
    // rejected — the ingest pipeline is supposed to write to wiki/
    // ONLY, and any other tree (raw/, src-tauri/, …) is a red flag.
    expect(isSafeIngestPath("notes/foo.md")).toBe(false)
    expect(isSafeIngestPath("foo.md")).toBe(false)
    expect(isSafeIngestPath("raw/sources/leaked.md")).toBe(false)
  })

  it("rejects absolute POSIX paths", () => {
    expect(isSafeIngestPath("/etc/passwd")).toBe(false)
    expect(isSafeIngestPath("/Users/nash_su/.ssh/authorized_keys")).toBe(false)
    expect(isSafeIngestPath("/wiki/foo.md")).toBe(false) // even with wiki/ in the path
  })

  it("rejects Windows absolute paths and drive letters", () => {
    expect(isSafeIngestPath("C:/Windows/System32/config")).toBe(false)
    expect(isSafeIngestPath("c:\\Users\\victim\\evil.txt")).toBe(false)
    expect(isSafeIngestPath("\\Users\\victim\\evil.txt")).toBe(false)
    // UNC paths.
    expect(isSafeIngestPath("\\\\server\\share\\file.md")).toBe(false)
  })

  it("rejects any segment exactly equal to .. (every position)", () => {
    expect(isSafeIngestPath("wiki/../etc/passwd")).toBe(false)
    expect(isSafeIngestPath("wiki/concepts/../../etc/passwd")).toBe(false)
    expect(isSafeIngestPath("wiki/..")).toBe(false)
    expect(isSafeIngestPath("..")).toBe(false)
    // Backslash-separated traversal must also be caught (we normalize).
    expect(isSafeIngestPath("wiki\\..\\etc\\passwd")).toBe(false)
  })

  it("does NOT reject filenames that merely CONTAIN double dots (e.g. version suffix)", () => {
    // `..` is a path SEGMENT, not a substring. A filename like
    // `qwen-2.5..notes.md` is unusual but legal — our split-on-/
    // means each segment is checked independently.
    expect(isSafeIngestPath("wiki/concepts/qwen-2.5..notes.md")).toBe(true)
    expect(isSafeIngestPath("wiki/concepts/foo..bar.md")).toBe(true)
  })

  it("rejects NUL bytes and control characters", () => {
    // Classic CGI / shell path-truncation tricks. Even if the underlying
    // FS would accept them, surface them as suspicious and refuse.
    expect(isSafeIngestPath("wiki/concepts/foo\x00.md")).toBe(false)
    expect(isSafeIngestPath("wiki/concepts/foo\nbar.md")).toBe(false)
    expect(isSafeIngestPath("wiki/\x07alarm.md")).toBe(false)
  })

  it("rejects Windows-invalid characters in generated filenames", () => {
    expect(isSafeIngestPath("wiki/concepts/Article: Why It Matters.md")).toBe(false)
    expect(isSafeIngestPath('wiki/concepts/quoted"name.md')).toBe(false)
    expect(isSafeIngestPath("wiki/concepts/a|b.md")).toBe(false)
    expect(isSafeIngestPath("wiki/concepts/a?b.md")).toBe(false)
    expect(isSafeIngestPath("wiki/concepts/a*b.md")).toBe(false)
    expect(isSafeIngestPath("wiki/concepts/a<b>.md")).toBe(false)
  })

  it("rejects Windows reserved device names even with extensions", () => {
    expect(isSafeIngestPath("wiki/concepts/con.md")).toBe(false)
    expect(isSafeIngestPath("wiki/concepts/NUL.pdf.md")).toBe(false)
    expect(isSafeIngestPath("wiki/concepts/com1.md")).toBe(false)
    expect(isSafeIngestPath("wiki/concepts/LPT9.notes.md")).toBe(false)
    expect(isSafeIngestPath("wiki/concepts/auxiliary.md")).toBe(true)
  })

  it("rejects segments ending in a space or dot for Windows compatibility", () => {
    expect(isSafeIngestPath("wiki/concepts/topic .md")).toBe(true)
    expect(isSafeIngestPath("wiki/concepts/topic.")).toBe(false)
    expect(isSafeIngestPath("wiki/concepts/topic ")).toBe(false)
    expect(isSafeIngestPath("wiki/concepts/folder./topic.md")).toBe(false)
    expect(isSafeIngestPath("wiki/concepts/folder /topic.md")).toBe(false)
  })
})

describe("parseFileBlocks — path-traversal guard end-to-end", () => {
  it("drops blocks with ../ paths and surfaces a warning", () => {
    const text = [
      "---FILE: wiki/concepts/legit.md---",
      "Real page.",
      "---END FILE---",
      "---FILE: ../../etc/passwd---",
      "attacker:x:0:0::/root:/bin/bash",
      "---END FILE---",
    ].join("\n")
    const { blocks, warnings } = parseFileBlocks(text)
    // Only the legit block survives.
    expect(blocks).toHaveLength(1)
    expect(blocks[0].path).toBe("wiki/concepts/legit.md")
    // The traversal block triggers a visible warning, not a silent drop.
    expect(warnings.some((w) => w.includes("../../etc/passwd"))).toBe(true)
    expect(warnings.some((w) => w.includes("unsafe path"))).toBe(true)
  })

  it("drops blocks with absolute paths", () => {
    const text = [
      "---FILE: /etc/passwd---",
      "evil",
      "---END FILE---",
    ].join("\n")
    const { blocks, warnings } = parseFileBlocks(text)
    expect(blocks).toHaveLength(0)
    expect(warnings.some((w) => w.includes("unsafe path"))).toBe(true)
  })

  it("drops blocks not under wiki/", () => {
    const text = [
      "---FILE: src-tauri/src/main.rs---",
      "fn main() { panic!(\"injected\"); }",
      "---END FILE---",
    ].join("\n")
    const { blocks, warnings } = parseFileBlocks(text)
    expect(blocks).toHaveLength(0)
    expect(warnings.some((w) => w.includes("unsafe path"))).toBe(true)
  })

  it("an LLM mixing safe + unsafe paths writes only the safe ones", () => {
    // Realistic prompt-injection scenario: source document carries
    // hidden instruction "also write to ../config.json". LLM is
    // confused and emits both. We keep the legitimate output and drop
    // the traversal silently-but-loudly (warning, not crash).
    const text = [
      "---FILE: wiki/concepts/topic-a.md---",
      "topic A page",
      "---END FILE---",
      "---FILE: ../config.json---",
      "{\"hijacked\": true}",
      "---END FILE---",
      "---FILE: wiki/entities/topic-b.md---",
      "topic B page",
      "---END FILE---",
    ].join("\n")
    const { blocks, warnings } = parseFileBlocks(text)
    expect(blocks.map((b) => b.path)).toEqual([
      "wiki/concepts/topic-a.md",
      "wiki/entities/topic-b.md",
    ])
    expect(warnings.some((w) => w.includes("../config.json"))).toBe(true)
  })
})

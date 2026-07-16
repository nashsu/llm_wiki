/**
 * Comprehensive regression suite for the markdown chunker. Every test
 * here pins down a specific contract from the chunker's docstring —
 * failing here means the chunking semantics regressed and downstream
 * embedding/search behavior will drift. Keep assertions concrete
 * (exact chunk counts, exact substrings present/absent) so failure
 * messages point directly at the broken rule.
 */
import { describe, it, expect } from "vitest"
import {
  chunkMarkdown,
  stripFrontmatter,
  type Chunk,
} from "./text-chunker"

// ── Tiny helpers ────────────────────────────────────────────────────

/** Build a string of `n` repeats of `ch`. */
const rep = (ch: string, n: number): string => ch.repeat(n)

/** Concatenate lines with \n — readability sugar for test fixtures. */
const lines = (...ls: string[]): string => ls.join("\n")

// ── stripFrontmatter ────────────────────────────────────────────────

describe("stripFrontmatter", () => {
  it("removes a standard YAML frontmatter block", () => {
    const input = "---\ntitle: RoPE\ntype: concept\n---\nBody content"
    const { body, bodyOffset } = stripFrontmatter(input)
    expect(body).toBe("Body content")
    // Exact offset — the fence is 4 chars (`---\n`), the body 29 chars,
    // the close fence 4 chars → body starts at index 33.
    expect(bodyOffset).toBe("---\ntitle: RoPE\ntype: concept\n---\n".length)
    expect(input.slice(bodyOffset)).toBe("Body content")
  })

  it("is a no-op when there is no frontmatter", () => {
    const input = "# Just Body\n\nHello"
    expect(stripFrontmatter(input).body).toBe(input)
    expect(stripFrontmatter(input).bodyOffset).toBe(0)
  })

  it("leaves content alone when closing fence is missing", () => {
    // Malformed — treat the whole thing as body rather than eating it all.
    const input = "---\ntitle: Broken\nbody continues forever"
    expect(stripFrontmatter(input).body).toBe(input)
  })

  it("tolerates CRLF line endings in the fence", () => {
    const input = "---\r\ntitle: X\r\n---\r\nbody"
    const out = stripFrontmatter(input)
    expect(out.body.trim()).toBe("body")
  })
})

// ── Empty / trivial inputs ─────────────────────────────────────────

describe("chunkMarkdown — trivial inputs", () => {
  it("returns [] for empty string", () => {
    expect(chunkMarkdown("")).toEqual([])
  })

  it("returns [] for whitespace-only input", () => {
    expect(chunkMarkdown("   \n\n\t\n")).toEqual([])
  })

  it("returns [] when only frontmatter (no body)", () => {
    expect(chunkMarkdown("---\ntitle: X\n---\n")).toEqual([])
  })

  it("emits a single chunk when content fits under targetChars", () => {
    const result = chunkMarkdown("Hello world.", { targetChars: 1000 })
    expect(result).toHaveLength(1)
    expect(result[0].text).toBe("Hello world.")
    expect(result[0].index).toBe(0)
    expect(result[0].oversized).toBe(false)
  })
})

// ── Heading breadcrumb tracking ────────────────────────────────────

describe("chunkMarkdown — heading breadcrumbs", () => {
  it("emits empty headingPath for content before any heading", () => {
    const result = chunkMarkdown("preamble text without a heading")
    expect(result[0].headingPath).toBe("")
  })

  it("captures a single-level heading", () => {
    const input = "# Top\n\nBody"
    const result = chunkMarkdown(input)
    expect(result[0].headingPath).toBe("# Top")
  })

  it("builds a multi-level breadcrumb", () => {
    const input = lines(
      "## Section A",
      "",
      "### Subsection",
      "",
      "text under subsection",
    )
    const result = chunkMarkdown(input)
    // Last chunk (the text) should show the full breadcrumb.
    const last = result[result.length - 1]
    expect(last.headingPath).toBe("## Section A > ### Subsection")
  })

  it("resets deeper headings when a shallower heading appears", () => {
    // After ### Sub, a new ## Section should clear the ### breadcrumb.
    const input = lines(
      "## First",
      "### Sub",
      "text1",
      "## Second",
      "text2",
    )
    const result = chunkMarkdown(input)
    const second = result.find((c) => c.text.includes("text2"))
    expect(second?.headingPath).toBe("## Second")
    expect(second?.headingPath).not.toContain("Sub")
  })

  it("does NOT treat # inside fenced code as a heading", () => {
    const input = lines(
      "## Real",
      "",
      "```",
      "# fake-heading-inside-code",
      "some code",
      "```",
      "",
      "After the code block",
    )
    const result = chunkMarkdown(input)
    // Every chunk should still live under "## Real".
    for (const c of result) {
      expect(c.headingPath).toBe("## Real")
    }
  })
})

// ── Code block preservation ────────────────────────────────────────

describe("chunkMarkdown — fenced code blocks", () => {
  it("keeps a small code block intact", () => {
    const input = lines(
      "Intro paragraph.",
      "",
      "```python",
      "def hello():",
      "    print('hi')",
      "```",
      "",
      "Outro.",
    )
    const result = chunkMarkdown(input, { targetChars: 2000 })
    expect(result).toHaveLength(1)
    expect(result[0].text).toContain("def hello():")
  })

  it("does NOT tear a large code block", () => {
    const code = Array.from({ length: 100 }, (_, i) => `console.log(${i});`).join("\n")
    const input = `intro\n\n\`\`\`js\n${code}\n\`\`\`\n\noutro`
    const result = chunkMarkdown(input, { targetChars: 300, maxChars: 500, minChars: 50 })
    // Locate the chunk that contains the start of the code block.
    const codeChunk = result.find((c) => c.text.includes("```js"))
    expect(codeChunk).toBeDefined()
    // The closing fence must be in the SAME chunk as the opener.
    expect(codeChunk!.text).toContain("```js")
    expect(codeChunk!.text.match(/```/g)?.length).toBeGreaterThanOrEqual(2)
    expect(codeChunk!.oversized).toBe(true)
  })

  it("handles tilde-fence variant `~~~` too", () => {
    const input = lines(
      "Intro.",
      "",
      "~~~",
      "code here",
      "~~~",
      "",
      "Outro.",
    )
    const result = chunkMarkdown(input, { targetChars: 2000 })
    expect(result[0].text).toContain("code here")
  })
})

// ── Table preservation ─────────────────────────────────────────────

describe("chunkMarkdown — markdown tables", () => {
  it("keeps a small table intact", () => {
    const input = lines(
      "Intro.",
      "",
      "| A | B |",
      "|---|---|",
      "| 1 | 2 |",
      "| 3 | 4 |",
      "",
      "Outro.",
    )
    const result = chunkMarkdown(input, { targetChars: 2000 })
    expect(result[0].text).toContain("| A | B |")
    expect(result[0].text).toContain("| 3 | 4 |")
  })

  it("does NOT tear a large table", () => {
    const rows = Array.from({ length: 50 }, (_, i) => `| row ${i} | value ${i} |`)
    const input = lines("| A | B |", "|---|---|", ...rows)
    const result = chunkMarkdown(input, { targetChars: 200, maxChars: 400 })
    const tableChunks = result.filter((c) => c.text.includes("| row"))
    // Whole table should be in one chunk, even if oversized.
    expect(tableChunks).toHaveLength(1)
    expect(tableChunks[0].oversized).toBe(true)
  })

  it("treats a single leading-pipe line as a normal paragraph", () => {
    // One line starting with `|` isn't a real table — don't special-case it.
    const input = "|single pipe line\n\nsecond paragraph"
    const result = chunkMarkdown(input)
    expect(result.map((c) => c.text).join("\n")).toContain("|single pipe line")
    expect(result.map((c) => c.text).join("\n")).toContain("second paragraph")
  })
})

// ── Recursive split levels ─────────────────────────────────────────

describe("chunkMarkdown — recursive split priority", () => {
  it("splits on paragraph boundaries (\\n\\n) before lines", () => {
    const p1 = rep("a", 400)
    const p2 = rep("b", 400)
    const input = `${p1}\n\n${p2}`
    const result = chunkMarkdown(input, { targetChars: 500, maxChars: 800, minChars: 50, overlapChars: 0 })
    expect(result).toHaveLength(2)
    expect(result[0].text.startsWith("a")).toBe(true)
    expect(result[1].text.startsWith("b")).toBe(true)
  })

  it("descends to sentence boundaries when a single paragraph exceeds target (CJK)", () => {
    // One huge paragraph of Chinese sentences joined by 。
    const sentence = rep("中", 200) + "。"
    const input = sentence.repeat(3) // 603 chars, one paragraph
    const result = chunkMarkdown(input, { targetChars: 220, maxChars: 500, minChars: 20, overlapChars: 0 })
    expect(result.length).toBeGreaterThanOrEqual(3)
    for (const c of result) {
      expect(c.text.length).toBeLessThanOrEqual(500)
    }
  })

  it("descends to sentence boundaries for English paragraphs too", () => {
    const sentence = rep("a", 200) + ". "
    const input = sentence.repeat(4).trim()
    const result = chunkMarkdown(input, { targetChars: 250, maxChars: 500, minChars: 20, overlapChars: 0 })
    expect(result.length).toBeGreaterThanOrEqual(2)
  })

  it("hard-slices an unbreakable blob (no separators) as a last resort", () => {
    const blob = rep("x", 3000) // no spaces, no newlines, no sentence ends
    const result = chunkMarkdown(blob, { targetChars: 500, maxChars: 800, minChars: 50, overlapChars: 0 })
    expect(result.length).toBeGreaterThanOrEqual(4)
    for (const c of result) {
      // Hard-sliced pieces are exactly targetChars (except possibly the
      // last). Should stay ≤ maxChars.
      expect(c.text.length).toBeLessThanOrEqual(800)
    }
  })
})

// ── Overlap semantics ──────────────────────────────────────────────

describe("chunkMarkdown — overlap between adjacent chunks", () => {
  it("zero overlap => disjoint text coverage", () => {
    const input = rep("a", 400) + "\n\n" + rep("b", 400)
    const result = chunkMarkdown(input, { targetChars: 500, maxChars: 800, minChars: 50, overlapChars: 0 })
    expect(result).toHaveLength(2)
    // No shared characters at the boundary.
    expect(result[1].text.startsWith("a")).toBe(false)
  })

  it("non-zero overlap injects some preceding content into the next chunk", () => {
    const sentence = rep("a", 150) + ". "
    const input = sentence.repeat(6).trim()
    const result = chunkMarkdown(input, { targetChars: 300, maxChars: 800, minChars: 50, overlapChars: 100 })
    expect(result.length).toBeGreaterThanOrEqual(2)
    // A chunk after the first should start with content from the
    // previous chunk's tail — prove it by checking the first several
    // chars appear in the previous chunk somewhere.
    const second = result[1]
    const prevTail = result[0].text.slice(-200)
    const overlapSample = second.text.slice(0, 30)
    expect(prevTail).toContain(overlapSample)
  })

  it("clamps overlap to half the target when misconfigured", () => {
    // overlapChars >= targetChars would infinite-loop the packer; the
    // chunker must silently clamp to floor(targetChars/2) and still
    // terminate. A plain `rep("a", N)` input has no sentence/whitespace
    // separators, so snapOverlapHead returns the tail unchanged → we
    // can measure the exact overlap by comparing chunk[1] length to
    // chunk[1]'s original size (= targetChars from the hard-slice).
    const input = rep("a", 2000)
    const result = chunkMarkdown(input, { targetChars: 200, maxChars: 500, minChars: 20, overlapChars: 500 })
    // Hard-slice at 200 chars → 10 pieces.
    expect(result).toHaveLength(10)
    // chunk[0] is the first slice, untouched.
    expect(result[0].text).toHaveLength(200)
    // chunk[1..] = clamp(500 → 100) chars of prev + 200 chars of own →
    // 300 chars. If the clamp silently regressed to e.g. `overlapChars`
    // unclamped, `slice(-500)` on a 200-char prev yields 200 chars of
    // overlap and the second chunk would be 400 chars, not 300.
    for (let i = 1; i < result.length; i++) {
      expect(result[i].text).toHaveLength(300)
    }
  })
})

// ── Small-chunk merging ────────────────────────────────────────────

describe("chunkMarkdown — minChars merging", () => {
  it("merges a small fragment with its next neighbor", () => {
    // Two paragraphs: first is tiny, second is normal.
    const input = "tiny.\n\n" + rep("b", 600)
    const result = chunkMarkdown(input, { targetChars: 800, maxChars: 1200, minChars: 100, overlapChars: 0 })
    expect(result).toHaveLength(1)
    expect(result[0].text).toContain("tiny.")
    expect(result[0].text).toContain("b".repeat(100))
  })

  it("doesn't merge when the combined size would exceed maxChars", () => {
    // A tiny fragment followed by a chunk that's already near maxChars
    // must stay separate.
    const tiny = "short"
    const big = rep("a", 1000) + "。" + rep("b", 400)
    const input = tiny + "\n\n" + big
    const result = chunkMarkdown(input, {
      targetChars: 1000,
      maxChars: 1100,
      minChars: 50,
      overlapChars: 0,
    })
    expect(result.length).toBeGreaterThanOrEqual(2)
  })
})

// ── Section-aware chunking (headings cut chunks) ───────────────────

describe("chunkMarkdown — sections cut chunks even when small", () => {
  it("emits separate chunks for separate sections", () => {
    const input = lines(
      "## One",
      "",
      "first body.",
      "",
      "## Two",
      "",
      "second body.",
    )
    const result = chunkMarkdown(input, { targetChars: 1000 })
    expect(result.length).toBeGreaterThanOrEqual(2)
    const one = result.find((c) => c.text.includes("first body"))
    const two = result.find((c) => c.text.includes("second body"))
    expect(one?.headingPath).toBe("## One")
    expect(two?.headingPath).toBe("## Two")
  })
})

// ── Character offsets ──────────────────────────────────────────────

describe("chunkMarkdown — charStart / charEnd offsets", () => {
  it("offsets point back into the original document", () => {
    const input = "# Title\n\nBody text here."
    const result = chunkMarkdown(input)
    const chunk = result[0]
    const slice = input.slice(chunk.charStart, chunk.charEnd)
    expect(slice).toContain("Body text here")
  })

  it("accounts for frontmatter offset in the original document", () => {
    const fm = "---\ntitle: X\n---\n"
    const body = "Body after frontmatter"
    const input = fm + body
    const result = chunkMarkdown(input)
    const chunk = result[0]
    // charStart should be inside the body, after the frontmatter.
    expect(chunk.charStart).toBeGreaterThanOrEqual(fm.length)
    expect(input.slice(chunk.charStart)).toContain("Body after frontmatter")
  })
})

// ── Indices and determinism ────────────────────────────────────────

describe("chunkMarkdown — bookkeeping", () => {
  it("index values are 0-based and sequential", () => {
    const input = rep("a", 800) + "\n\n" + rep("b", 800) + "\n\n" + rep("c", 800)
    const result = chunkMarkdown(input, { targetChars: 500, maxChars: 900, minChars: 50, overlapChars: 0 })
    for (let i = 0; i < result.length; i++) {
      expect(result[i].index).toBe(i)
    }
  })

  it("is deterministic: same input ⇒ byte-identical output", () => {
    const input = lines(
      "## Concepts",
      "Some text about attention.",
      "",
      "### RoPE",
      "Rotary positional embeddings are...",
      "",
      "```python",
      "theta_i = 10000 ** (-2 * i / d)",
      "```",
    )
    const a = chunkMarkdown(input)
    const b = chunkMarkdown(input)
    expect(a).toEqual(b)
  })
})

// ── End-to-end: realistic wiki page ────────────────────────────────

describe("chunkMarkdown — realistic wiki fixture", () => {
  const wikiPage = lines(
    "---",
    'title: "RoPE 旋转位置编码"',
    "type: concept",
    "---",
    "",
    "# RoPE 旋转位置编码",
    "",
    "Rotary positional embeddings(RoPE)是 Transformer 架构里替代绝对位置编码的主流方案。",
    "",
    "## 数学原理",
    "",
    "给定维度 d 的 query/key 向量,RoPE 通过在复数域上的旋转来注入位置信息:",
    "",
    "```",
    "theta_i = base^(-2i/d)",
    "q' = q * e^(j * m * theta)",
    "```",
    "",
    "其中 m 是 token 在序列中的位置。",
    "",
    "## 与其他技术的协同",
    "",
    "### KV Cache",
    "",
    "RoPE 的一个重要性质是旋转后的 key 可以直接缓存,配合 [[KV Cache]] 实现长文推理加速。",
    "",
    "### Flash Attention",
    "",
    "[[Flash Attention]] 对 RoPE 友好,因为位置编码在 Q/K 投影时就已注入,不需要额外的显存读写。",
    "",
    "## 常见变种",
    "",
    "- xPos:加入衰减因子防止远距离相关性爆炸。",
    "- LongRoPE:针对超长上下文(> 128k)的 theta 重标定方案。",
    "- YaRN:插值 + NTK 感知缩放的混合方法。",
    "",
    "详细比较参见 [[Long Context]] 页面。",
  )

  it("produces the expected number of chunks under default options", () => {
    const result = chunkMarkdown(wikiPage)
    // Pin the exact count — regressions in chunking semantics (heading
    // cuts, atom merging, overlap) all show up here. If the chunker is
    // retuned intentionally, update this constant deliberately.
    expect(result).toHaveLength(6)
  })

  it("each chunk is ≤ maxChars (or flagged oversized)", () => {
    const result = chunkMarkdown(wikiPage)
    for (const c of result) {
      if (!c.oversized) expect(c.text.length).toBeLessThanOrEqual(1500)
    }
  })

  it("only the preamble chunk has empty headingPath; every heading-scoped chunk has one", () => {
    const result = chunkMarkdown(wikiPage)
    // Find the preamble chunk structurally (the one containing the
    // first body paragraph that sits under the H1) — NOT by text
    // prefix, so this test doesn't silently skip when chunks reorder.
    const preamble = result.find((c) => c.text.includes("Rotary positional embeddings(RoPE)"))
    expect(preamble).toBeDefined()
    expect(preamble!.headingPath).toBe("# RoPE 旋转位置编码")

    // Every OTHER chunk must have a heading path. Without the explicit
    // split we used to silently skip the assertion when chunk ordering
    // drifted.
    const nonPreamble = result.filter((c) => c !== preamble)
    expect(nonPreamble.length).toBeGreaterThanOrEqual(1)
    for (const c of nonPreamble) {
      expect(c.headingPath.length).toBeGreaterThan(0)
    }
  })

  it("code block and its closing fence stay in the same chunk", () => {
    const result = chunkMarkdown(wikiPage)
    const codeChunk = result.find((c) => c.text.includes("theta_i = base"))
    expect(codeChunk).toBeDefined()
    // Must contain BOTH an opener and a closer (exactly 2 ``` markers),
    // not just an even count — `0 % 2 === 0` passes trivially and would
    // green an "opener escaped, closer stayed behind" regression.
    const fenceMarkers = codeChunk!.text.match(/```/g) ?? []
    expect(fenceMarkers).toHaveLength(2)
    expect(codeChunk!.text).toContain("q' = q * e^(j * m * theta)")
  })

  it("list items about variants are captured", () => {
    const result = chunkMarkdown(wikiPage)
    const joined = result.map((c) => c.text).join("\n")
    expect(joined).toContain("xPos")
    expect(joined).toContain("LongRoPE")
    expect(joined).toContain("YaRN")
  })
})

// ── CRLF content body (Windows line endings) ───────────────────────

describe("chunkMarkdown — CRLF in body", () => {
  it("handles CRLF-delimited headings and fences correctly", () => {
    // A Windows-authored markdown file uses \r\n, not \n. The chunker
    // splits on \n and leaves \r attached to each line; the fence
    // regex uses startsWith + trim() so \r shouldn't break fence
    // detection. Headings use `\s+` which eats \r. If either regex
    // regressed, the fence wouldn't close (everything becomes one
    // oversized chunk) OR the heading wouldn't register (headingPath
    // empty).
    const input = "# Head\r\n\r\n```py\r\ncode line 1\r\ncode line 2\r\n```\r\n\r\nafter\r\n"
    const result = chunkMarkdown(input, { targetChars: 2000 })
    expect(result).toHaveLength(1)
    expect(result[0].headingPath).toBe("# Head")
    expect(result[0].text).toContain("code line 1")
    expect(result[0].text).toContain("after")
    expect(result[0].oversized).toBe(false)
  })
})

// ── Nested fences (4-tick wrapping 3-tick) ─────────────────────────

describe("chunkMarkdown — nested fences", () => {
  it("a 4-backtick fence keeps a 3-backtick inner block intact", () => {
    // CommonMark says a fence can only be closed by a run of the same
    // character with length ≥ the opening run. So ```` should NOT be
    // closed by ``` inside. The chunker records the opening marker's
    // full length and must require the closer to match it exactly.
    const input = [
      "Intro.",
      "",
      "````markdown",
      "Here is some embedded markdown with its own fence:",
      "```python",
      "print('inner')",
      "```",
      "End of embedded markdown.",
      "````",
      "",
      "Outro.",
    ].join("\n")
    const result = chunkMarkdown(input, { targetChars: 2000 })
    expect(result).toHaveLength(1)
    // Inner ``` fence must remain captured inside the chunk — not
    // treated as a closer that terminated the outer fence early.
    expect(result[0].text).toContain("print('inner')")
    expect(result[0].text).toContain("End of embedded markdown.")
    expect(result[0].text).toContain("Outro.")
  })
})

// ── Tables without a separator row ─────────────────────────────────

describe("chunkMarkdown — table with no |---|---| separator", () => {
  it("treats 2+ consecutive leading-pipe lines as a single indivisible table atom", () => {
    // Some wikis omit the separator row (rendered as a two-row data
    // table by many markdown engines). The chunker's rule is purely
    // structural: ≥2 consecutive `|`-prefixed lines = one table atom.
    const input = [
      "Intro.",
      "",
      "| key1 | val1 |",
      "| key2 | val2 |",
      "",
      "Outro.",
    ].join("\n")
    // Use targetChars small enough that a torn table WOULD produce
    // multiple chunks — so we can assert "stayed intact" meaningfully.
    const result = chunkMarkdown(input, { targetChars: 20, maxChars: 200, minChars: 5, overlapChars: 0 })
    const tableChunks = result.filter((c) => c.text.includes("| key1"))
    expect(tableChunks).toHaveLength(1)
    expect(tableChunks[0].text).toContain("| key1 | val1 |")
    expect(tableChunks[0].text).toContain("| key2 | val2 |")
  })
})

// ── Contract checks on the output shape ────────────────────────────

describe("Chunk shape contract", () => {
  it("every chunk has all required fields", () => {
    const input = "Short body"
    const result: Chunk[] = chunkMarkdown(input)
    for (const c of result) {
      expect(typeof c.index).toBe("number")
      expect(typeof c.text).toBe("string")
      expect(typeof c.headingPath).toBe("string")
      expect(typeof c.charStart).toBe("number")
      expect(typeof c.charEnd).toBe("number")
      expect(typeof c.oversized).toBe("boolean")
      expect(c.charEnd).toBeGreaterThanOrEqual(c.charStart)
    }
  })
})

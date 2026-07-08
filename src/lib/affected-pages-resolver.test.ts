import { describe, expect, it } from "vitest"
import {
  buildPageResolutionIndex,
  resolveAffectedPages,
} from "./affected-pages-resolver"

const index = buildPageResolutionIndex([
  { relativePath: "wiki/concepts/非晶纳米晶材料.md", title: "非晶/纳米晶材料" },
  { relativePath: "wiki/findings/悦安新材非晶粉体即将进入小批量量产.md", title: "悦安新材非晶粉体即将进入小批量量产，AI场景方案成头部客户主流选择" },
  { relativePath: "wiki/entities/openai.md", title: "OpenAI" },
  { relativePath: "wiki/sources/wei-2022-cot.md", title: "Source: wei-2022-cot.pdf" },
])

describe("resolveAffectedPages", () => {
  it("keeps exact relative paths verbatim", () => {
    const { resolved, dropped } = resolveAffectedPages(
      ["wiki/concepts/非晶纳米晶材料.md"],
      index,
    )
    expect(resolved).toEqual(["wiki/concepts/非晶纳米晶材料.md"])
    expect(dropped).toEqual([])
  })

  it("resolves bare stems and missing wiki/ prefix to the canonical path", () => {
    const { resolved } = resolveAffectedPages(
      ["openai", "concepts/非晶纳米晶材料.md"],
      index,
    )
    expect(resolved).toEqual([
      "wiki/entities/openai.md",
      "wiki/concepts/非晶纳米晶材料.md",
    ])
  })

  it("resolves frontmatter titles (case/width-insensitive) to the canonical path", () => {
    const { resolved } = resolveAffectedPages(
      ["非晶/纳米晶材料", "OPENAI"],
      index,
    )
    expect(resolved).toEqual([
      "wiki/concepts/非晶纳米晶材料.md",
      "wiki/entities/openai.md",
    ])
  })

  it("unwraps wikilink-shaped references before resolving", () => {
    const { resolved } = resolveAffectedPages(["[[openai|OpenAI 公司]]"], index)
    expect(resolved).toEqual(["wiki/entities/openai.md"])
  })

  it("matches across NFC/NFD unicode normal forms", () => {
    const nfdIndex = buildPageResolutionIndex([
      { relativePath: `wiki/entities/café.md`.normalize("NFD"), title: "café" },
    ])
    const { resolved } = resolveAffectedPages(["wiki/entities/café.md".normalize("NFC")], nfdIndex)
    expect(resolved.length).toBe(1)
  })

  it("drops unresolvable references and reports them", () => {
    const { resolved, dropped } = resolveAffectedPages(
      ["wiki/concepts/amorphous-nanocrystalline-material.md", "openai"],
      index,
    )
    expect(resolved).toEqual(["wiki/entities/openai.md"])
    expect(dropped).toEqual(["wiki/concepts/amorphous-nanocrystalline-material.md"])
  })

  it("dedupes references that resolve to the same page", () => {
    const { resolved } = resolveAffectedPages(
      ["openai", "wiki/entities/openai.md", "OpenAI"],
      index,
    )
    expect(resolved).toEqual(["wiki/entities/openai.md"])
  })
})

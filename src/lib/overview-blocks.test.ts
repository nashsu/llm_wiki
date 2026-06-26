import { describe, it, expect } from "vitest"
import { chunkOverviewBySections } from "./overview-blocks"

describe("chunkOverviewBySections", () => {
  it("returns empty array for empty overview", () => {
    expect(chunkOverviewBySections("", 2000)).toEqual([])
  })

  it("returns single chunk when overview is small", () => {
    const overview = [
      "# Overview",
      "",
      "## 操作系统",
      "操作系统是管理硬件资源的软件。",
      "",
      "## 网络",
      "计算机网络是互联互通的系统。",
    ].join("\n")
    const chunks = chunkOverviewBySections(overview, 2000)
    expect(chunks).toHaveLength(1)
    expect(chunks[0]).toContain("## 操作系统")
    expect(chunks[0]).toContain("## 网络")
  })

  it("splits into multiple chunks when overview exceeds maxChunkChars", () => {
    const sections: string[] = ["# Overview", ""]
    for (let i = 0; i < 5; i++) {
      sections.push(`## Section ${i}`)
      sections.push("x".repeat(600))
      sections.push("")
    }
    const overview = sections.join("\n")
    const chunks = chunkOverviewBySections(overview, 1000)
    expect(chunks.length).toBeGreaterThan(1)
  })

  it("preserves section headings in each chunk", () => {
    const overview = [
      "# Overview",
      "",
      "## 操作系统",
      "内容A",
      "",
      "## 网络",
      "内容B",
    ].join("\n")
    const chunks = chunkOverviewBySections(overview, 50)
    expect(chunks.length).toBeGreaterThanOrEqual(2)
    expect(chunks.some((c) => c.includes("## 操作系统"))).toBe(true)
    expect(chunks.some((c) => c.includes("## 网络"))).toBe(true)
  })

  it("handles overview with no ## headings (single chunk)", () => {
    const overview = "Just some prose without headings."
    const chunks = chunkOverviewBySections(overview, 2000)
    expect(chunks).toHaveLength(1)
    expect(chunks[0]).toBe(overview)
  })
})

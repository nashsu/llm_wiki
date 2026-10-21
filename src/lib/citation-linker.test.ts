import { describe, expect, it } from "vitest"
import { linkifyCitedPaths } from "./citation-linker"

const CITED = ["entities/usb", "concepts/usb-full-speed-12mbps"]

describe("linkifyCitedPaths", () => {
  it("links a plain source path mention", () => {
    const out = linkifyCitedPaths("来源：entities/usb", CITED)
    expect(out).toBe("来源：[entities/usb](wikilink:entities/usb)")
  })

  it("links multiple sources separated by 和 comma", () => {
    const out = linkifyCitedPaths("来源：entities/usb、concepts/usb-full-speed-12mbps", CITED)
    expect(out).toBe(
      "来源：[entities/usb](wikilink:entities/usb)、[concepts/usb-full-speed-12mbps](wikilink:concepts/usb-full-speed-12mbps)",
    )
  })

  it("normalizes a wiki/-prefixed .md path to its page link", () => {
    const out = linkifyCitedPaths("see wiki/entities/usb.md", CITED)
    expect(out).toBe("see [entities/usb](wikilink:entities/usb)")
  })

  it("drops the trailing .md extension", () => {
    const out = linkifyCitedPaths("来源：entities/usb.md", CITED)
    expect(out).toBe("来源：[entities/usb](wikilink:entities/usb)")
  })

  it("does not link a bare slug", () => {
    const out = linkifyCitedPaths("echo USB here", CITED)
    expect(out).toBe("echo USB here")
  })

  it("does not link a path that was not cited", () => {
    const out = linkifyCitedPaths("来源：other/thing", CITED)
    expect(out).toBe("来源：other/thing")
  })

  it("does not re-wrap an already-linked [x](wikilink:...) URL", () => {
    const out = linkifyCitedPaths("a [entities/usb](wikilink:entities/usb) mention", CITED)
    expect(out).toBe("a [entities/usb](wikilink:entities/usb) mention")
  })

  it("leaves a [[wikilink]] untouched for the wikilink pass", () => {
    const out = linkifyCitedPaths("源 [[wiki/entities/usb.md]] end", CITED)
    expect(out).toBe("源 [[wiki/entities/usb.md]] end")
  })

  it("returns input unchanged when no cited paths", () => {
    const out = linkifyCitedPaths("来源：entities/usb", [])
    expect(out).toBe("来源：entities/usb")
  })

  it("handles CJK path segments", () => {
    const out = linkifyCitedPaths("来源：实体/usb", ["实体/usb"])
    expect(out).toBe("来源：[实体/usb](wikilink:实体/usb)")
  })
})

import { describe, expect, it } from "vitest"
import { clampPdfPage, decodeBase64, parseDelimitedContent } from "./file-preview"

describe("PDF preview helpers", () => {
  it("decodes PDF bytes without depending on asset URLs or platform paths", () => {
    expect([...decodeBase64("JVBERi0=")]).toEqual([37, 80, 68, 70, 45])
  })

  it("keeps requested pages inside the loaded document", () => {
    expect(clampPdfPage(-2, 10)).toBe(1)
    expect(clampPdfPage(6, 10)).toBe(6)
    expect(clampPdfPage(99, 10)).toBe(10)
    expect(clampPdfPage(2, 0)).toBe(1)
  })
})

describe("parseDelimitedContent", () => {
  it("preserves delimiters, escaped quotes, and newlines inside quoted cells", () => {
    expect(parseDelimitedContent('name,detail\nA,"one,two"\nB,"line 1\nline 2"\nC,"a""b"', ",")).toEqual([
      ["name", "detail"],
      ["A", "one,two"],
      ["B", "line 1\nline 2"],
      ["C", 'a"b'],
    ])
  })
})

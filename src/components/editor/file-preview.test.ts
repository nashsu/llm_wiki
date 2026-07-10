import { describe, expect, it } from "vitest"
import { parseDelimitedContent } from "./file-preview"

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

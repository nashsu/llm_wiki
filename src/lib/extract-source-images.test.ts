import { describe, expect, it } from "vitest"
import { findLocalMarkdownImageRefs, markdownImageDestination } from "./extract-source-images"

describe("findLocalMarkdownImageRefs", () => {
  it("extracts Obsidian and markdown local image references", () => {
    const refs = findLocalMarkdownImageRefs(`
![[attachments/chart.png]]
![Figure](images/plot%201.jpg "title")
![Remote](https://example.com/a.png)
![[attachments/chart.png|400]]
`)
    expect(refs).toEqual(["attachments/chart.png", "images/plot 1.jpg"])
  })

  it("ignores non-image links and remote/data references", () => {
    const refs = findLocalMarkdownImageRefs(`
![Doc](notes/page.md)
![Data](data:image/png;base64,abc)
![[draft.txt]]
`)
    expect(refs).toEqual([])
  })
})

describe("markdownImageDestination", () => {
  it("wraps paths with spaces or parentheses in angle brackets (#768)", () => {
    expect(markdownImageDestination("media/My PDF/img-1.png")).toBe("<media/My PDF/img-1.png>")
    expect(markdownImageDestination("media/report(1)/img-1.png")).toBe("<media/report(1)/img-1.png>")
    expect(markdownImageDestination("media/my-pdf/img-1.png")).toBe("media/my-pdf/img-1.png")
  })
})

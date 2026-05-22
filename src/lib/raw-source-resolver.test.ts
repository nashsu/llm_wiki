import { describe, expect, it } from "vitest"
import { imageUrlToAbsolute } from "./raw-source-resolver"

describe("imageUrlToAbsolute", () => {
  it("promotes wiki-root media paths to absolute paths", () => {
    expect(
      imageUrlToAbsolute("media/paper/img-1.png", "/project"),
    ).toBe("/project/wiki/media/paper/img-1.png")
  })

  it("promotes source-summary relative media paths to absolute paths", () => {
    expect(
      imageUrlToAbsolute("../media/paper/img-1.png", "/project"),
    ).toBe("/project/wiki/media/paper/img-1.png")
  })

  it("keeps absolute paths unchanged", () => {
    expect(
      imageUrlToAbsolute("/project/wiki/media/paper/img-1.png", "/project"),
    ).toBe("/project/wiki/media/paper/img-1.png")
  })
})

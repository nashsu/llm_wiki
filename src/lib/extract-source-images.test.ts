import { describe, expect, it, vi } from "vitest"

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}))

import { buildImageMarkdownSection, type SavedImage } from "./extract-source-images"

function savedImage(relPath: string, index = 1): SavedImage {
  return {
    index,
    mimeType: "image/png",
    page: 1,
    width: 640,
    height: 480,
    relPath,
    absPath: `/project/wiki/${relPath}`,
    sha256: `sha-${index}`,
  }
}

describe("buildImageMarkdownSection", () => {
  it("writes source-summary image links relative to wiki/sources", () => {
    const section = buildImageMarkdownSection([
      savedImage("media/paper/img-1.png"),
    ])

    expect(section).toContain("![](../media/paper/img-1.png)")
    expect(section).not.toContain("![](media/paper/img-1.png)")
  })

  it("keeps captions while rewriting media links", () => {
    const captions = new Map([["sha-1", "Revenue chart by quarter"]])

    const section = buildImageMarkdownSection([
      savedImage("media/report/img-1.png"),
    ], captions)

    expect(section).toContain("![Revenue chart by quarter](../media/report/img-1.png)")
  })
})

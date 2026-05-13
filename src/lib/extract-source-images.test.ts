import { describe, it, expect, vi, beforeEach } from "vitest"

const mockInvoke = vi.fn()

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}))

import { extractAndSaveSourceImages } from "./extract-source-images"

beforeEach(() => {
  mockInvoke.mockReset()
})

describe("extractAndSaveSourceImages", () => {
  it("stores extracted document images under raw/assets and returns project-rooted relPaths", async () => {
    mockInvoke.mockResolvedValueOnce([
      {
        index: 1,
        mimeType: "image/png",
        page: 1,
        width: 640,
        height: 480,
        relPath: "raw/assets/rope-paper/img-1.png",
        absPath: "/proj/raw/assets/rope-paper/img-1.png",
        sha256: "abc",
      },
    ])

    const images = await extractAndSaveSourceImages("/proj", "/proj/raw/sources/rope-paper.pdf")

    expect(mockInvoke).toHaveBeenCalledWith("extract_and_save_pdf_images_cmd", {
      sourcePath: "/proj/raw/sources/rope-paper.pdf",
      destDir: "/proj/raw/assets/rope-paper",
      relTo: "/proj",
    })
    expect(images[0].relPath).toBe("raw/assets/rope-paper/img-1.png")
  })

  it("does not call the extractor for unsupported file types", async () => {
    const images = await extractAndSaveSourceImages("/proj", "/proj/raw/sources/note.md")

    expect(images).toEqual([])
    expect(mockInvoke).not.toHaveBeenCalled()
  })
})

import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  copyFile: vi.fn(),
  createDirectory: vi.fn(),
  readFileAsBase64: vi.fn(),
  invoke: vi.fn(),
}))

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }))
vi.mock("@/commands/fs", () => ({
  copyFile: mocks.copyFile,
  createDirectory: mocks.createDirectory,
  fileExists: vi.fn(),
  readFileAsBase64: mocks.readFileAsBase64,
}))

import { extractAndSaveSourceImages, findLocalMarkdownImageRefs } from "./extract-source-images"

beforeEach(() => {
  vi.clearAllMocks()
  mocks.copyFile.mockResolvedValue(undefined)
  mocks.createDirectory.mockResolvedValue(undefined)
  mocks.readFileAsBase64.mockResolvedValue({ base64: "aW1hZ2U=", mimeType: "image/png" })
})

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

describe("extractAndSaveSourceImages", () => {
  it("imports a standalone image as the source's only saved image", async () => {
    const images = await extractAndSaveSourceImages(
      "/project",
      "/project/raw/sources/process flow.JPG",
      "process-flow",
    )

    expect(mocks.createDirectory).toHaveBeenCalledWith("/project/wiki/media/process-flow")
    expect(mocks.copyFile).toHaveBeenCalledWith(
      "/project/raw/sources/process flow.JPG",
      "/project/wiki/media/process-flow/001-process flow.JPG",
    )
    expect(mocks.invoke).not.toHaveBeenCalled()
    expect(images).toHaveLength(1)
    expect(images[0]).toMatchObject({
      index: 1,
      mimeType: "image/jpeg",
      page: null,
      relPath: "media/process-flow/001-process flow.JPG",
      absPath: "/project/wiki/media/process-flow/001-process flow.JPG",
    })
    expect(images[0].sha256).toMatch(/^[a-f0-9]{64}$/)
  })
})

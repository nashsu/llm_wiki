import { beforeEach, describe, expect, it, vi } from "vitest"

const fsMocks = vi.hoisted(() => ({
  copyMarkdownImageWithinProject: vi.fn<
    (projectPath: string, source: string, destination: string) => Promise<number>
  >(),
  readFileAsBase64: vi.fn<
    (path: string) => Promise<{ base64: string; mimeType: string }>
  >(),
}))

vi.mock("@/commands/fs", () => fsMocks)

import {
  extractAndSaveMarkdownImages,
  findLocalMarkdownImageRefs,
  resolveProjectLocalMarkdownImagePath,
} from "./extract-source-images"

beforeEach(() => {
  fsMocks.copyMarkdownImageWithinProject.mockReset()
  fsMocks.readFileAsBase64.mockReset()
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

describe("resolveProjectLocalMarkdownImagePath", () => {
  const projectPath = "/project"
  const sourcePath = "/project/raw/sources/guide.md"

  it.each([
    "//server/share/image.png",
    String.raw`\\server\share\image.png`,
    String.raw`/\server\share\image.png`,
    "%2F%2Fserver/share/image.png",
  ])("rejects protocol-relative and UNC references: %s", (ref) => {
    expect(resolveProjectLocalMarkdownImagePath(projectPath, sourcePath, ref)).toBeNull()
  })

  it("rejects absolute references outside the project", () => {
    expect(
      resolveProjectLocalMarkdownImagePath(projectPath, sourcePath, "/private/image.png"),
    ).toBeNull()
  })

  it("rejects relative traversal outside the project", () => {
    expect(
      resolveProjectLocalMarkdownImagePath(projectPath, sourcePath, "../../../image.png"),
    ).toBeNull()
  })

  it("rejects a source file outside the project", () => {
    expect(
      resolveProjectLocalMarkdownImagePath(projectPath, "/outside/guide.md", "image.png"),
    ).toBeNull()
  })

  it("resolves relative and absolute references that stay inside the project", () => {
    expect(
      resolveProjectLocalMarkdownImagePath(projectPath, sourcePath, "../assets/chart.png"),
    ).toBe("/project/raw/assets/chart.png")
    expect(
      resolveProjectLocalMarkdownImagePath(
        projectPath,
        sourcePath,
        "/project/shared/chart.png",
      ),
    ).toBe("/project/shared/chart.png")
  })
})

describe("extractAndSaveMarkdownImages", () => {
  it.each([
    ["protocol-relative", "![image](//server/share/image.png)"],
    ["UNC", String.raw`![[\\server\share\image.png]]`],
    ["outside absolute", "![image](/private/image.png)"],
    ["outside traversal", "![image](../../../image.png)"],
  ])("does not touch the filesystem for a rejected %s reference", async (_label, markdown) => {
    await expect(
      extractAndSaveMarkdownImages(
        "/project",
        "/project/raw/sources/guide.md",
        markdown,
      ),
    ).resolves.toEqual([])

    expect(fsMocks.copyMarkdownImageWithinProject).not.toHaveBeenCalled()
    expect(fsMocks.readFileAsBase64).not.toHaveBeenCalled()
  })

  it("copies a resolved in-project reference through the confined command", async () => {
    fsMocks.copyMarkdownImageWithinProject.mockResolvedValue(5)
    fsMocks.readFileAsBase64.mockResolvedValue({
      base64: "aW1hZ2U=",
      mimeType: "image/png",
    })

    const images = await extractAndSaveMarkdownImages(
      "/project",
      "/project/raw/sources/guide.md",
      "![chart](../assets/chart.png)",
    )

    expect(fsMocks.copyMarkdownImageWithinProject).toHaveBeenCalledWith(
      "/project",
      "/project/raw/assets/chart.png",
      "/project/wiki/media/guide/001-chart.png",
    )
    expect(images).toHaveLength(1)
    expect(images[0]?.absPath).toBe("/project/wiki/media/guide/001-chart.png")
  })
})

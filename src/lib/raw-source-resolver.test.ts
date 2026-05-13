import { describe, it, expect, vi, beforeEach } from "vitest"

const mockListDirectory = vi.fn()

vi.mock("@/commands/fs", () => ({
  listDirectory: (path: string) => mockListDirectory(path),
}))

import { findRawSourceForImage, imageUrlToAbsolute } from "./raw-source-resolver"

beforeEach(() => {
  mockListDirectory.mockReset()
})

describe("raw-source-resolver", () => {
  it("maps raw/assets image URLs back to the matching raw source", async () => {
    mockListDirectory.mockResolvedValueOnce([
      {
        name: "paper.pdf",
        path: "/proj/raw/sources/paper.pdf",
        is_dir: false,
      },
    ])

    await expect(
      findRawSourceForImage("raw/assets/paper/img-1.png", "/proj"),
    ).resolves.toBe("/proj/raw/sources/paper.pdf")
  })

  it("keeps legacy media URLs resolvable", async () => {
    mockListDirectory.mockResolvedValueOnce([
      {
        name: "paper.pdf",
        path: "/proj/raw/sources/paper.pdf",
        is_dir: false,
      },
    ])

    await expect(
      findRawSourceForImage("media/paper/img-1.png", "/proj"),
    ).resolves.toBe("/proj/raw/sources/paper.pdf")
  })

  it("normalizes project-relative asset URLs to absolute paths", () => {
    expect(imageUrlToAbsolute("raw/assets/paper/img-1.png", "/proj")).toBe(
      "/proj/raw/assets/paper/img-1.png",
    )
    expect(imageUrlToAbsolute("media/paper/img-1.png", "/proj")).toBe(
      "/proj/wiki/media/paper/img-1.png",
    )
  })
})

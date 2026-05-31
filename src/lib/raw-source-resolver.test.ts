import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createTempProject, realFs, writeFileRaw } from "@/test-helpers/fs-temp"
import { findRawSourceForImage, imageUrlToAbsolute } from "./raw-source-resolver"
import { sourceSummarySlugFromIdentity } from "./source-identity"

vi.mock("@/commands/fs", () => realFs)

describe("raw source image resolver", () => {
  let tmp: { path: string; cleanup: () => Promise<void> } | undefined

  beforeEach(async () => {
    tmp = await createTempProject("raw-source-resolver")
    await writeFileRaw(`${tmp.path}/raw/sources/report.pdf`, "root source\n")
    await writeFileRaw(`${tmp.path}/raw/sources/project-a/config.pdf`, "nested source\n")
  })

  afterEach(async () => {
    await tmp?.cleanup()
    tmp = undefined
  })

  it("resolves legacy root-level media slugs by raw source stem", async () => {
    if (!tmp) throw new Error("missing temp project")

    await expect(
      findRawSourceForImage(`${tmp.path}/wiki/media/report/img-1.png`, tmp.path),
    ).resolves.toBe(`${tmp.path}/raw/sources/report.pdf`)
  })

  it("resolves nested source media slugs by source-summary slug", async () => {
    if (!tmp) throw new Error("missing temp project")

    const slug = sourceSummarySlugFromIdentity("project-a/config.pdf")

    await expect(
      findRawSourceForImage(`media/${slug}/img-1.png`, tmp.path),
    ).resolves.toBe(`${tmp.path}/raw/sources/project-a/config.pdf`)
  })

  it("normalizes wiki-relative image URLs to absolute wiki media paths", () => {
    expect(imageUrlToAbsolute("media/report/img-1.png", "/project")).toBe(
      "/project/wiki/media/report/img-1.png",
    )
  })

  it("normalizes source-summary relative image URLs to absolute wiki media paths", () => {
    expect(imageUrlToAbsolute("../media/paper/img-1.png", "/project")).toBe(
      "/project/wiki/media/paper/img-1.png",
    )
  })

  it("keeps absolute paths unchanged", () => {
    expect(
      imageUrlToAbsolute("/project/wiki/media/paper/img-1.png", "/project"),
    ).toBe("/project/wiki/media/paper/img-1.png")
  })
})

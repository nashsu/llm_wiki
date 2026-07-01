import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createTempProject, realFs, writeFileRaw } from "@/test-helpers/fs-temp"
import { findRawSourceForImage, imageUrlToAbsolute } from "./raw-source-resolver"
import {
  legacySourceSummarySlugFromIdentity,
  sourceSummarySlugFromIdentity,
} from "./source-identity"

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

  it("resolves media slugs for sources inside raw dotfolders", async () => {
    if (!tmp) throw new Error("missing temp project")

    await writeFileRaw(`${tmp.path}/raw/sources/.claude/research.md`, "dotfolder source\n")
    const slug = sourceSummarySlugFromIdentity(".claude/research.md")

    await expect(
      findRawSourceForImage(`media/${slug}/img-1.png`, tmp.path),
    ).resolves.toBe(`${tmp.path}/raw/sources/.claude/research.md`)
  })

  it("resolves nested source media slugs created with legacy percent-encoded source slugs", async () => {
    if (!tmp) throw new Error("missing temp project")

    await writeFileRaw(`${tmp.path}/raw/sources/2024年/污水处理.pdf`, "nested CJK source\n")
    const slug = legacySourceSummarySlugFromIdentity("2024年/污水处理.pdf")

    expect(slug).toContain("%")
    await expect(
      findRawSourceForImage(`media/${slug}/img-1.png`, tmp.path),
    ).resolves.toBe(`${tmp.path}/raw/sources/2024年/污水处理.pdf`)
  })

  it("normalizes wiki-relative image URLs to absolute wiki media paths", () => {
    expect(imageUrlToAbsolute("media/report/img-1.png", "/project")).toBe(
      "/project/wiki/media/report/img-1.png",
    )
  })
})

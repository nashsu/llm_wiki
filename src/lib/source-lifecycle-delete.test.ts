import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createTempProject, readFileRaw, realFs, writeFileRaw } from "@/test-helpers/fs-temp"

vi.mock("@/commands/fs", () => realFs)

import { deleteSourceFiles } from "./source-lifecycle"

describe("source lifecycle source deletion", () => {
  let tmp: { path: string; cleanup: () => Promise<void> } | undefined

  beforeEach(async () => {
    tmp = await createTempProject("source-lifecycle-delete")
    await writeFileRaw(`${tmp.path}/raw/sources/project-a/config.yaml`, "name: alpha\n")
    await writeFileRaw(`${tmp.path}/raw/sources/project-b/config.yaml`, "name: beta\n")
    await writeFileRaw(`${tmp.path}/wiki/log.md`, "# Wiki Log\n")
    await writeFileRaw(
      `${tmp.path}/wiki/concepts/shared.md`,
      [
        "---",
        'sources: ["project-a/config.yaml", "project-b/config.yaml"]',
        "---",
        "# Shared",
      ].join("\n"),
    )
    await writeFileRaw(
      `${tmp.path}/wiki/concepts/project-b-only.md`,
      [
        "---",
        'sources: ["project-b/config.yaml"]',
        "---",
        "# Project B",
      ].join("\n"),
    )
  })

  afterEach(async () => {
    await tmp?.cleanup()
    tmp = undefined
  })

  it("does not remove path-aware source references that only share a basename", async () => {
    if (!tmp) throw new Error("missing temp project")

    const result = await deleteSourceFiles(
      tmp.path,
      [`${tmp.path}/raw/sources/project-a/config.yaml`],
      { fileAlreadyDeleted: true },
    )

    await expect(readFileRaw(`${tmp.path}/wiki/concepts/shared.md`)).resolves.toContain(
      'sources: ["project-b/config.yaml"]',
    )
    await expect(readFileRaw(`${tmp.path}/wiki/concepts/project-b-only.md`)).resolves.toContain(
      'sources: ["project-b/config.yaml"]',
    )
    expect(result.deletedWikiPaths).toEqual([])
    expect(result.rewrittenSourcePages).toBe(1)
  })
})

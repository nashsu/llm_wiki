/**
 * Regression test for buildWikiIndex's title extraction.
 *
 * buildWikiIndex previously matched `title:` with a regex anchored only at
 * the opening `---`, never required to stop at the closing `---`. A page
 * whose frontmatter has no title — but whose body happens to contain a
 * later line starting with `title:` (plain prose, not YAML) — got that
 * body line misread as the page's title and added to `byTitle`. Since
 * `pageExists()` checks `byTitle` to decide whether a "missing page" review
 * should auto-resolve, this could falsely mark a still-missing page as
 * resolved.
 */
import { describe, it, expect, vi } from "vitest"
import type { FileNode } from "@/types/wiki"

const mockListDirectory = vi.fn()
const mockReadFile = vi.fn()

vi.mock("@/commands/fs", () => ({
  listDirectory: (...args: unknown[]) => mockListDirectory(...args),
  readFile: (...args: unknown[]) => mockReadFile(...args),
}))

async function loadBuildWikiIndex() {
  const mod = await import("./sweep-reviews")
  return mod.buildWikiIndex
}

async function loadSweepModule() {
  return import("./sweep-reviews")
}

function mdFile(name: string): FileNode {
  return { name, path: `/project/wiki/${name}`, is_dir: false }
}

describe("buildWikiIndex", () => {
  it("does not add a body prose line starting with title: to byTitle", async () => {
    const buildWikiIndex = await loadBuildWikiIndex()
    mockListDirectory.mockResolvedValue([mdFile("other.md")])
    mockReadFile.mockResolvedValue(
      "---\ntype: entity\n---\n# Real Heading\n\nSome text.\ntitle: Attention Mechanism\n",
    )

    const index = await buildWikiIndex("/project")

    expect(index.byTitle.has("attention mechanism")).toBe(false)
    expect(index.byTitleSlug.has("attention-mechanism")).toBe(false)
    expect(index.pages[0].title).toBeNull()
  })

  it("still indexes a genuine frontmatter title", async () => {
    const buildWikiIndex = await loadBuildWikiIndex()
    mockListDirectory.mockResolvedValue([mdFile("real.md")])
    mockReadFile.mockResolvedValue("---\ntitle: Real Title\n---\n# Real Title\n")

    const index = await buildWikiIndex("/project")

    expect(index.byTitle.has("real title")).toBe(true)
  })

  it("indexes the frontmatter title's slug for timestamped filenames", async () => {
    const buildWikiIndex = await loadBuildWikiIndex()
    mockListDirectory.mockResolvedValue([mdFile("clash-detection-2026-09-06-143052.md")])
    mockReadFile.mockResolvedValue("---\ntitle: Clash Detection\n---\n# Clash Detection\n")

    const index = await buildWikiIndex("/project")

    expect(index.byTitleSlug.has("clash-detection")).toBe(true)
  })
})

describe("pageExists", () => {
  it("resolves a candidate name against a timestamped page via its title slug", async () => {
    const { buildWikiIndex, pageExists } = await loadSweepModule()
    mockListDirectory.mockResolvedValue([mdFile("clash-detection-2026-09-06-143052.md")])
    mockReadFile.mockResolvedValue("---\ntitle: Clash Detection\n---\n# Clash Detection\n")

    const index = await buildWikiIndex("/project")

    expect(pageExists("clash-detection", index)).toBe(true)
  })

  it("does not match unrelated candidate names via the slug index", async () => {
    const { buildWikiIndex, pageExists } = await loadSweepModule()
    mockListDirectory.mockResolvedValue([mdFile("clash-detection-2026-09-06-143052.md")])
    mockReadFile.mockResolvedValue("---\ntitle: Clash Detection\n---\n# Clash Detection\n")

    const index = await buildWikiIndex("/project")

    expect(pageExists("completely-unrelated", index)).toBe(false)
  })
})

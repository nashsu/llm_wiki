import { describe, expect, it, vi, beforeEach } from "vitest"
import {
  dedupeManifestBySlug,
  findCatchupManifestEntities,
  materializeManifestPages,
} from "./post-ingest-materialize"
import type { ManifestEntity } from "./post-ingest-materialize"

vi.mock("@/commands/fs", () => ({
  listDirectory: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
}))

import { listDirectory, readFile, writeFile } from "@/commands/fs"

const mockListDirectory = vi.mocked(listDirectory)
const mockReadFile = vi.mocked(readFile)
const mockWriteFile = vi.mocked(writeFile)

const MANIFEST: ManifestEntity[] = [
  { name: "Ion Stoica", type: "entity" },
  { name: "Matei Zaharia", type: "entity" },
  { name: "Apache Spark", type: "concept" },
]

/** Mock the entities/concepts folders to contain exactly `names`. */
function diskHas(...names: string[]) {
  mockListDirectory.mockImplementation(async (path: string) => {
    const pick = (folder: string) =>
      names
        .filter((n) => n.startsWith(folder + "/"))
        .map((n) => {
          const file = n.slice(folder.length + 1)
          return { name: file, path: `/p/wiki/${folder}/${file}`, is_dir: false }
        })
    if (path.endsWith("/wiki/entities")) return pick("entities") as never
    if (path.endsWith("/wiki/concepts")) return pick("concepts") as never
    throw new Error(`unexpected list: ${path}`)
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  diskHas("entities/matei-zaharia.md")
})

describe("findCatchupManifestEntities", () => {
  it("returns manifest entries with no page on disk", async () => {
    const targets = await findCatchupManifestEntities("/p", [
      { name: "Ion Stoica", type: "entity" },
      { name: "Matei Zaharia", type: "entity" },
    ])
    // matei-zaharia exists on disk; ion-stoica does not.
    expect(targets.map((t) => t.name)).toEqual(["Ion Stoica"])
  })

  it("excludes entries whose page exists on disk", async () => {
    diskHas("entities/ion-stoica.md")
    const targets = await findCatchupManifestEntities("/p", [
      { name: "Ion Stoica", type: "entity" },
    ])
    expect(targets).toEqual([])
  })
})

describe("dedupeManifestBySlug", () => {
  it("keeps one entry when names collapse to the same slug", () => {
    const deduped = dedupeManifestBySlug([
      { name: "Ion Stoica", type: "entity" },
      { name: "ion stoica", type: "entity" },
      { name: "Apache Spark", type: "concept" },
    ])
    expect(deduped).toHaveLength(2)
    expect(deduped[0].name).toBe("Ion Stoica")
  })
})

describe("materializeManifestPages", () => {
  it("does NOT create pages for missing manifest entries (ADR 0004)", async () => {
    // Ion Stoica / Apache Spark are not on disk — no stub is written.
    mockReadFile.mockResolvedValue("---\nrelated: []\n---\n")

    await materializeManifestPages("/p", MANIFEST, "paper.pdf", [])

    // Only the existing matei-zaharia page is touched (source union).
    expect(mockWriteFile).toHaveBeenCalledTimes(1)
    expect(mockWriteFile).toHaveBeenCalledWith(
      "/p/wiki/entities/matei-zaharia.md",
      expect.any(String),
    )
  })

  it("leaves missing manifest entries for Catch-up, not a review", async () => {
    mockReadFile.mockResolvedValue(
      ["---", "title: Matei Zaharia", "related: [ion-stoica, databricks]", "---", "", "Body"].join("\n"),
    )

    const result = await materializeManifestPages(
      "/p",
      MANIFEST,
      "paper.pdf",
      ["wiki/entities/matei-zaharia.md"],
      "raw/sources/paper.pdf",
    )

    // ion-stoica is a manifest entry → owned by Catch-up, never reviewed.
    expect(result.reviewItems.some((r) => r.title.includes("ion-stoica"))).toBe(false)
    // A non-manifest dangling ref still becomes a review.
    expect(result.reviewItems).toHaveLength(1)
    expect(result.reviewItems[0]).toMatchObject({
      type: "missing-page",
      title: "Missing page: databricks",
      affectedPages: ["wiki/entities/matei-zaharia.md"],
    })
  })

  it("treats unique-suffix shorthand as resolved and does not queue a review", async () => {
    // Per ADR 0002, the missing-page check uses the same resolution
    // policy as graph/post-link: `spark` resolves uniquely to
    // `apache-spark` (manifest entry), so no review should fire.
    mockReadFile.mockResolvedValue(
      ["---", "title: Matei Zaharia", "related: [spark, totally-unknown-thing]", "---", "", "Body"].join("\n"),
    )

    const result = await materializeManifestPages(
      "/p",
      MANIFEST,
      "paper.pdf",
      ["wiki/entities/matei-zaharia.md"],
      "raw/sources/paper.pdf",
    )

    expect(result.reviewItems.some((r) => r.title.includes("spark"))).toBe(false)
    expect(result.reviewItems).toHaveLength(1)
    expect(result.reviewItems[0]).toMatchObject({
      type: "missing-page",
      title: "Missing page: totally-unknown-thing",
    })
  })

  it("unions the current source into an existing manifest page", async () => {
    diskHas("entities/ion-stoica.md")
    mockReadFile.mockResolvedValue(
      [
        "---",
        "type: entity",
        'title: "Ion Stoica"',
        'sources: ["old-paper.pdf"]',
        "tags: []",
        "related: []",
        "---",
        "",
        "# Ion Stoica",
        "",
        "Existing body.",
      ].join("\n"),
    )

    await materializeManifestPages("/p", [{ name: "Ion Stoica", type: "entity" }], "new-paper.pdf", [])

    expect(mockWriteFile).toHaveBeenCalledTimes(1)
    expect(mockWriteFile).toHaveBeenCalledWith(
      "/p/wiki/entities/ion-stoica.md",
      expect.stringContaining('sources: ["old-paper.pdf", "new-paper.pdf"]'),
    )
  })

  it("unions source onto every existing manifest page", async () => {
    diskHas(
      "entities/ion-stoica.md",
      "entities/matei-zaharia.md",
      "concepts/apache-spark.md",
    )
    mockReadFile.mockResolvedValue("---\nrelated: []\n---\n")

    const result = await materializeManifestPages("/p", MANIFEST, "paper.pdf", [])

    expect(mockWriteFile).toHaveBeenCalledTimes(3)
    for (const path of [
      "/p/wiki/entities/ion-stoica.md",
      "/p/wiki/entities/matei-zaharia.md",
      "/p/wiki/concepts/apache-spark.md",
    ]) {
      expect(mockWriteFile).toHaveBeenCalledWith(
        path,
        expect.stringContaining('sources: ["paper.pdf"]'),
      )
    }
    expect(result.reviewItems).toEqual([])
  })
})

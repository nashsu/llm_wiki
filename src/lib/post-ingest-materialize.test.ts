import { describe, expect, it, vi, beforeEach } from "vitest"
import {
  buildManifestStub,
  dedupeManifestBySlug,
  findCatchupManifestEntities,
  isManifestStubContent,
  MANIFEST_STUB_MARKER,
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

beforeEach(() => {
  vi.clearAllMocks()
  mockListDirectory.mockImplementation(async (path: string) => {
    if (path.endsWith("/wiki/entities")) {
      return [
        {
          name: "matei-zaharia.md",
          path: "/p/wiki/entities/matei-zaharia.md",
          is_dir: false,
        },
      ] as never
    }
    if (path.endsWith("/wiki/concepts")) {
      return [] as never
    }
    throw new Error(`unexpected list: ${path}`)
  })
})

describe("isManifestStubContent", () => {
  it("detects auto-generated stub marker", () => {
    expect(isManifestStubContent(buildManifestStub({ name: "X", type: "entity" }, "a.pdf", "2026-01-01"))).toBe(true)
    expect(isManifestStubContent(`---\ntitle: X\n---\n\n# X\n\nReal content.`)).toBe(false)
    expect(isManifestStubContent(MANIFEST_STUB_MARKER)).toBe(true)
  })
})

describe("findCatchupManifestEntities", () => {
  it("includes missing pages and existing stubs", async () => {
    mockReadFile.mockImplementation(async (path: string) => {
      if (path.endsWith("/ion-stoica.md")) {
        return buildManifestStub({ name: "Ion Stoica", type: "entity" }, "p.pdf", "2026-01-01")
      }
      throw new Error("missing")
    })

    const targets = await findCatchupManifestEntities("/p", [
      { name: "Ion Stoica", type: "entity" },
      { name: "Matei Zaharia", type: "entity" },
    ])

    expect(targets.map((t) => t.name).sort()).toEqual(["Ion Stoica", "Matei Zaharia"])
  })

  it("excludes pages with real content", async () => {
    mockReadFile.mockResolvedValue("---\ntitle: Ion Stoica\n---\n\n# Ion Stoica\n\nFull biography here.")

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

describe("buildManifestStub", () => {
  it("writes entity stub with source attribution", () => {
    const stub = buildManifestStub(
      { name: "Ion Stoica", type: "entity" },
      "paper.pdf",
      "2026-05-19",
    )
    expect(stub).toContain('type: entity')
    expect(stub).toContain('title: "Ion Stoica"')
    expect(stub).toContain('sources: ["paper.pdf"]')
    expect(stub).toContain("# Ion Stoica")
  })
})

describe("materializeManifestPages", () => {
  it("writes at most one stub per slug when manifest has duplicate slugs", async () => {
    mockReadFile.mockResolvedValue("---\nrelated: []\n---\n")

    await materializeManifestPages(
      "/p",
      [
        { name: "Ion Stoica", type: "entity" },
        { name: "ion stoica", type: "entity" },
      ],
      "paper.pdf",
      [],
    )

    expect(mockWriteFile).toHaveBeenCalledTimes(1)
    expect(mockWriteFile).toHaveBeenCalledWith(
      "/p/wiki/entities/ion-stoica.md",
      expect.any(String),
    )
  })

  it("stubs manifest pages missing from disk", async () => {
    mockReadFile.mockResolvedValue(
      [
        "---",
        "title: Matei Zaharia",
        "related: [ion-stoica, databricks]",
        "---",
        "",
        "Body",
      ].join("\n"),
    )

    const result = await materializeManifestPages(
      "/p",
      MANIFEST,
      "paper.pdf",
      ["wiki/entities/matei-zaharia.md"],
      "raw/sources/paper.pdf",
    )

    expect(result.stubPaths).toEqual([
      "wiki/entities/ion-stoica.md",
      "wiki/concepts/apache-spark.md",
    ])
    // ion-stoica + apache-spark stubs, plus source union on existing matei-zaharia
    expect(mockWriteFile).toHaveBeenCalledTimes(3)
    expect(mockWriteFile).toHaveBeenCalledWith(
      "/p/wiki/entities/ion-stoica.md",
      expect.stringContaining('title: "Ion Stoica"'),
    )

    // manifest-backed slug is stubbed, not reviewed
    expect(result.reviewItems.some((r) => r.title.includes("ion-stoica"))).toBe(false)
    // non-manifest dangling ref becomes a review
    expect(result.reviewItems).toHaveLength(1)
    expect(result.reviewItems[0]).toMatchObject({
      type: "missing-page",
      title: "Missing page: databricks",
      affectedPages: ["wiki/entities/matei-zaharia.md"],
    })
  })

  it("treats unique-suffix shorthand as resolved and does not queue a review", async () => {
    // Per ADR 0002, the missing-page check must use the same resolution
    // policy as graph/post-link: `spark` resolves uniquely to `apache-spark`
    // (manifest entry), so no review should fire.
    mockReadFile.mockResolvedValue(
      [
        "---",
        "title: Matei Zaharia",
        "related: [spark, totally-unknown-thing]",
        "---",
        "",
        "Body",
      ].join("\n"),
    )

    const result = await materializeManifestPages(
      "/p",
      MANIFEST,
      "paper.pdf",
      ["wiki/entities/matei-zaharia.md"],
      "raw/sources/paper.pdf",
    )

    // `spark` resolves to manifest's `apache-spark` → no review.
    expect(result.reviewItems.some((r) => r.title.includes("spark"))).toBe(false)
    // Truly unresolvable ref still surfaces.
    expect(result.reviewItems).toHaveLength(1)
    expect(result.reviewItems[0]).toMatchObject({
      type: "missing-page",
      title: "Missing page: totally-unknown-thing",
    })
  })

  it("unions current source into frontmatter when manifest page already exists", async () => {
    mockListDirectory.mockImplementation(async (path: string) => {
      if (path.endsWith("/wiki/entities")) {
        return [
          {
            name: "ion-stoica.md",
            path: "/p/wiki/entities/ion-stoica.md",
            is_dir: false,
          },
        ] as never
      }
      if (path.endsWith("/wiki/concepts")) return [] as never
      throw new Error(`unexpected list: ${path}`)
    })
    mockReadFile.mockResolvedValue(
      [
        "---",
        'type: entity',
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

    const result = await materializeManifestPages(
      "/p",
      [{ name: "Ion Stoica", type: "entity" }],
      "new-paper.pdf",
      [],
    )

    expect(result.stubPaths).toEqual([])
    expect(mockWriteFile).toHaveBeenCalledTimes(1)
    expect(mockWriteFile).toHaveBeenCalledWith(
      "/p/wiki/entities/ion-stoica.md",
      expect.stringContaining('sources: ["old-paper.pdf", "new-paper.pdf"]'),
    )
  })

  it("returns no stubs when every manifest page already exists", async () => {
    mockListDirectory.mockImplementation(async (path: string) => {
      if (path.endsWith("/wiki/entities")) {
        return [
          { name: "ion-stoica.md", path: "/p/wiki/entities/ion-stoica.md", is_dir: false },
          { name: "matei-zaharia.md", path: "/p/wiki/entities/matei-zaharia.md", is_dir: false },
        ] as never
      }
      if (path.endsWith("/wiki/concepts")) {
        return [
          { name: "apache-spark.md", path: "/p/wiki/concepts/apache-spark.md", is_dir: false },
        ] as never
      }
      throw new Error(path)
    })
    mockReadFile.mockResolvedValue("---\nrelated: []\n---\n")

    const result = await materializeManifestPages("/p", MANIFEST, "paper.pdf", [])

    expect(result.stubPaths).toEqual([])
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

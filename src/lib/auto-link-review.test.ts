import { beforeEach, describe, expect, it, vi } from "vitest"
import type { LlmConfig } from "@/stores/wiki-store"
import type {
  AutoLinkSuggestion,
  PageCatalogEntry,
} from "./auto-link-types"

vi.mock("./page-catalog", () => ({
  buildProjectPageCatalog: vi.fn(),
}))
vi.mock("./enrich-wikilinks", () => ({
  suggestWikilinks: vi.fn(),
}))
vi.mock("./auto-link-ignore", () => ({
  loadAutoLinkIgnoreRules: vi.fn(),
}))
vi.mock("./auto-link-candidates", () => ({
  buildAutoLinkSuggestions: vi.fn(),
}))

import { buildProjectPageCatalog } from "./page-catalog"
import { suggestWikilinks } from "./enrich-wikilinks"
import { loadAutoLinkIgnoreRules } from "./auto-link-ignore"
import { buildAutoLinkSuggestions } from "./auto-link-candidates"
import { prepareAutoLinkReview } from "./auto-link-review"

const mockBuildCatalog = vi.mocked(buildProjectPageCatalog)
const mockSuggest = vi.mocked(suggestWikilinks)
const mockLoadIgnores = vi.mocked(loadAutoLinkIgnoreRules)
const mockBuildSuggestions = vi.mocked(buildAutoLinkSuggestions)

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  )
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
}

const llmConfig: LlmConfig = {
  provider: "openai",
  apiKey: "test-key",
  model: "test-model",
  ollamaUrl: "",
  customEndpoint: "",
  maxContextSize: 128000,
}

function catalogPage(slug: string, path: string): PageCatalogEntry {
  return { slug, title: slug, type: "concept", tags: [], path }
}

function readySuggestion(): AutoLinkSuggestion {
  return {
    id: "GDF3\u0000gdf3",
    term: "GDF3",
    selectedTarget: "gdf3",
    preferredTarget: "gdf3",
    alternatives: [{
      target: "gdf3",
      title: "GDF3",
      path: "/project/wiki/gdf3.md",
      band: "high",
      matchKind: "slug-exact",
      reason: "Exact slug",
    }],
    band: "high",
    selectedByDefault: true,
    reason: "Exact slug",
  }
}

function params(overrides: Partial<Parameters<typeof prepareAutoLinkReview>[0]> = {}) {
  return {
    projectPath: "/project",
    filePath: "/project/wiki/current.md",
    fileContent: "---\ntitle: Current\n---\nGDF3 is discussed here.",
    llmConfig,
    ...overrides,
  }
}

beforeEach(() => {
  vi.resetAllMocks()
  mockLoadIgnores.mockResolvedValue({ terms: [], pairs: [] })
})

describe("prepareAutoLinkReview", () => {
  it("returns empty without building a catalog for frontmatter-only content", async () => {
    await expect(
      prepareAutoLinkReview(params({
        fileContent: "---\ntitle: Current\n---\n",
      })),
    ).resolves.toMatchObject({ status: "empty" })
    expect(mockBuildCatalog).not.toHaveBeenCalled()
    expect(mockSuggest).not.toHaveBeenCalled()
  })

  it("returns no-targets when the catalog only contains the current page", async () => {
    mockBuildCatalog.mockResolvedValue([
      catalogPage("current", "/project/wiki/current.md"),
    ])

    await expect(prepareAutoLinkReview(params())).resolves.toMatchObject({
      status: "no-targets",
    })
    expect(mockSuggest).not.toHaveBeenCalled()
  })

  it("normalizes separators when excluding the current page", async () => {
    const target = catalogPage("gdf3", "C:/project/wiki/gdf3.md")
    mockBuildCatalog.mockResolvedValue([
      catalogPage("current", "C:/project/wiki/current.md"),
      target,
    ])
    mockSuggest.mockResolvedValue([{ term: "GDF3", target: "gdf3" }])
    mockBuildSuggestions.mockReturnValue([readySuggestion()])

    const result = await prepareAutoLinkReview(params({
      projectPath: "C:\\project",
      filePath: "C:\\project\\wiki\\current.md",
    }))

    expect(result.status).toBe("ready")
    expect(mockBuildSuggestions).toHaveBeenCalledWith(
      [{ term: "GDF3", target: "gdf3" }],
      [target],
      { terms: [], pairs: [] },
    )
  })

  it("returns a retryable error when suggestion discovery fails", async () => {
    mockBuildCatalog.mockResolvedValue([
      catalogPage("gdf3", "/project/wiki/gdf3.md"),
    ])
    mockSuggest.mockRejectedValue(new Error("transport failed"))

    await expect(prepareAutoLinkReview(params())).resolves.toEqual({
      status: "error",
      message: "transport failed",
    })
    expect(mockLoadIgnores).not.toHaveBeenCalled()
    expect(mockBuildSuggestions).not.toHaveBeenCalled()
  })

  it("returns an error when the page catalog cannot be read", async () => {
    mockBuildCatalog.mockRejectedValue(new Error("catalog read failed"))

    await expect(prepareAutoLinkReview(params())).resolves.toEqual({
      status: "error",
      message: "catalog read failed",
    })
    expect(mockSuggest).not.toHaveBeenCalled()
  })

  it("returns none when validation and ignore rules remove every suggestion", async () => {
    const target = catalogPage("gdf3", "/project/wiki/gdf3.md")
    mockBuildCatalog.mockResolvedValue([target])
    mockSuggest.mockResolvedValue([{ term: "GDF3", target: "gdf3" }])
    mockBuildSuggestions.mockReturnValue([])

    await expect(prepareAutoLinkReview(params())).resolves.toMatchObject({
      status: "none",
    })
  })

  it("returns ranked suggestions without applying or writing", async () => {
    const target = catalogPage("gdf3", "/project/wiki/gdf3.md")
    const suggestion = readySuggestion()
    mockBuildCatalog.mockResolvedValue([target])
    mockSuggest.mockResolvedValue([{ term: "GDF3", target: "gdf3" }])
    mockBuildSuggestions.mockReturnValue([suggestion])

    const reviewParams = params()
    await expect(prepareAutoLinkReview(reviewParams)).resolves.toEqual({
      status: "ready",
      suggestions: [suggestion],
      contentHash: await sha256(reviewParams.fileContent),
    })
    expect(mockBuildCatalog).toHaveBeenCalledWith("/project")
    expect(mockLoadIgnores).toHaveBeenCalledWith("/project")
    expect(mockSuggest).toHaveBeenCalledWith(
      "/project",
      "/project/wiki/current.md",
      llmConfig,
      { content: reviewParams.fileContent },
    )
  })
})

import { beforeEach, describe, expect, it } from "vitest"
import { useWikiStore } from "./wiki-store"

describe("wiki preview store actions", () => {
  beforeEach(() => {
    useWikiStore.getState().setFileTree([])
    useWikiStore.setState({
      activeView: "wiki",
      selectedFile: null,
      fileContent: "",
      previewContentPath: null,
      externalPreview: null,
    })
  })

  it("keeps the project path index in sync when setting the file tree", () => {
    useWikiStore.getState().setFileTree([
      {
        name: "wiki",
        path: "/project/wiki",
        is_dir: true,
        children: [
          {
            name: "entities",
            path: "/project/wiki/entities",
            is_dir: true,
            children: [
              { name: "foo.md", path: "/project/wiki/entities/foo.md", is_dir: false },
            ],
          },
        ],
      },
    ])

    const index = useWikiStore.getState().projectPathIndex
    expect(index.byPath.get("/project/wiki/entities/foo.md")?.name).toBe("foo.md")
    expect(index.filesByName.get("foo.md")?.[0]?.path).toBe(
      "/project/wiki/entities/foo.md",
    )
  })

  it("clears the project path index when clearing the file tree", () => {
    useWikiStore.getState().setFileTree([
      { name: "foo.md", path: "/project/wiki/foo.md", is_dir: false },
    ])
    expect(useWikiStore.getState().projectPathIndex.byPath.size).toBe(1)

    useWikiStore.getState().setFileTree([])

    const index = useWikiStore.getState().projectPathIndex
    expect(index.byPath.size).toBe(0)
    expect(index.filesByName.size).toBe(0)
  })

  it("replaces the project path index when replacing the file tree", () => {
    useWikiStore.getState().setFileTree([
      { name: "old.md", path: "/project/wiki/old.md", is_dir: false },
    ])

    useWikiStore.getState().setFileTree([
      { name: "new.md", path: "/project/wiki/new.md", is_dir: false },
    ])

    const index = useWikiStore.getState().projectPathIndex
    expect(index.filesByName.get("old.md")).toBeUndefined()
    expect(index.byPath.get("/project/wiki/old.md")).toBeUndefined()
    expect(index.filesByName.get("new.md")?.[0]?.path).toBe("/project/wiki/new.md")
  })

  it("can update the display tree without replacing the project path index", () => {
    useWikiStore.getState().setFileTree([
      { name: "indexed.md", path: "/project/wiki/indexed.md", is_dir: false },
    ])

    useWikiStore.getState().setFileTree([
      { name: "display-only.md", path: "/project/wiki/display-only.md", is_dir: false },
    ], { syncPathIndex: false })

    const state = useWikiStore.getState()
    expect(state.fileTree[0]?.name).toBe("display-only.md")
    expect(state.projectPathIndex.filesByName.get("indexed.md")?.[0]?.path).toBe(
      "/project/wiki/indexed.md",
    )
    expect(state.projectPathIndex.filesByName.get("display-only.md")).toBeUndefined()
  })

  it("can rebuild only the project path index from a full tree", () => {
    useWikiStore.getState().setFileTree([
      { name: "display.md", path: "/project/wiki/display.md", is_dir: false },
    ])

    useWikiStore.getState().setProjectPathIndexFromTree([
      { name: "full.md", path: "/project/wiki/deep/full.md", is_dir: false },
    ])

    const state = useWikiStore.getState()
    expect(state.fileTree[0]?.name).toBe("display.md")
    expect(state.projectPathIndex.filesByName.get("display.md")).toBeUndefined()
    expect(state.projectPathIndex.filesByName.get("full.md")?.[0]?.path).toBe(
      "/project/wiki/deep/full.md",
    )
  })

  it("opens a path in the wiki preview and clears external previews", () => {
    useWikiStore.setState({
      activeView: "chat",
      selectedFile: null,
      fileContent: "old",
      previewContentPath: "/old.md",
      externalPreview: {
        title: "External",
        path: "remote",
        source: "AnyTXT",
        url: "anytxt://remote",
        snippet: "snippet",
      },
    })

    useWikiStore.getState().openPathInPreview("/project/wiki/page.md")

    const state = useWikiStore.getState()
    expect(state.activeView).toBe("wiki")
    expect(state.selectedFile).toBe("/project/wiki/page.md")
    expect(state.fileContent).toBe("old")
    expect(state.previewContentPath).toBeNull()
    expect(state.externalPreview).toBeNull()
  })

  it("opens loaded file content in the wiki preview", () => {
    useWikiStore.setState({
      activeView: "search",
      selectedFile: null,
      fileContent: "",
      previewContentPath: null,
      externalPreview: {
        title: "External",
        path: "remote",
        source: "AnyTXT",
        url: "anytxt://remote",
        snippet: "snippet",
      },
    })

    useWikiStore.getState().openFileInPreview("/project/wiki/page.md", "# Page")

    const state = useWikiStore.getState()
    expect(state.activeView).toBe("wiki")
    expect(state.selectedFile).toBe("/project/wiki/page.md")
    expect(state.fileContent).toBe("# Page")
    expect(state.previewContentPath).toBe("/project/wiki/page.md")
    expect(state.externalPreview).toBeNull()
  })

  it("keeps graph ui state until explicitly reset", () => {
    useWikiStore.getState().resetGraphUiState()

    useWikiStore.getState().setGraphUiState((current) => ({
      ...current,
      colorMode: "community",
      filters: {
        ...current.filters,
        minLinks: 2,
        hiddenTypes: new Set(["source"]),
      },
      nodeScale: 1.25,
      graphSpacingDraft: 1.4,
    }))
    useWikiStore.getState().setActiveView("chat")
    useWikiStore.getState().setActiveView("graph")

    const preserved = useWikiStore.getState().graphUiState
    expect(preserved.colorMode).toBe("community")
    expect(preserved.filters.minLinks).toBe(2)
    expect(preserved.filters.hiddenTypes.has("source")).toBe(true)
    expect(preserved.nodeScale).toBe(1.25)
    expect(preserved.graphSpacingDraft).toBe(1.4)

    useWikiStore.getState().resetGraphUiState()
    const reset = useWikiStore.getState().graphUiState
    expect(reset.colorMode).toBe("type")
    expect(reset.filters.minLinks).toBeUndefined()
    expect(reset.filters.hiddenTypes.size).toBe(0)
    expect(reset.nodeScale).toBe(1)
    expect(reset.graphSpacingDraft).toBe(1)
  })
})

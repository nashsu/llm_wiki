import { beforeEach, describe, expect, it } from "vitest"
import { useResearchStore } from "./research-store"

describe("research-store", () => {
  beforeEach(() => {
    useResearchStore.setState({
      tasks: [],
      panelOpen: false,
      maxConcurrent: 3,
    })
  })

  it("clearFinished removes only done and error tasks", () => {
    useResearchStore.setState({
      tasks: [
        {
          id: "queued",
          projectId: "proj",
          projectPath: "/project",
          topic: "queued",
          status: "queued",
          webResults: [],
          synthesis: "",
          savedPath: null,
          error: null,
          createdAt: 1,
        },
        {
          id: "searching",
          projectId: "proj",
          projectPath: "/project",
          topic: "searching",
          status: "searching",
          webResults: [],
          synthesis: "",
          savedPath: null,
          error: null,
          createdAt: 2,
        },
        {
          id: "done",
          projectId: "proj",
          projectPath: "/project",
          topic: "done",
          status: "done",
          webResults: [],
          synthesis: "ok",
          savedPath: "wiki/queries/a.md",
          error: null,
          createdAt: 3,
        },
        {
          id: "error",
          projectId: "proj",
          projectPath: "/project",
          topic: "error",
          status: "error",
          webResults: [],
          synthesis: "partial",
          savedPath: null,
          error: "boom",
          createdAt: 4,
        },
      ],
    })

    useResearchStore.getState().clearFinished()
    expect(useResearchStore.getState().tasks.map((task) => task.id)).toEqual([
      "queued",
      "searching",
    ])
  })
})

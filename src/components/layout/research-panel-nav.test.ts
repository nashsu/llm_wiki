import { describe, expect, it } from "vitest"
import {
  isResearchPanelVisible,
  nextResearchPanelNavState,
} from "./research-panel-nav"

describe("research panel nav state", () => {
  it("switches standalone views to wiki and opens the panel", () => {
    expect(nextResearchPanelNavState("chat", false)).toEqual({
      activeView: "wiki",
      researchPanelOpen: true,
    })
    expect(nextResearchPanelNavState("settings", true)).toEqual({
      activeView: "wiki",
      researchPanelOpen: true,
    })
  })

  it("toggles the panel inside workspace views", () => {
    expect(nextResearchPanelNavState("search", true)).toEqual({
      activeView: "search",
      researchPanelOpen: false,
    })
    expect(nextResearchPanelNavState("graph", false)).toEqual({
      activeView: "graph",
      researchPanelOpen: true,
    })
  })

  it("only marks the panel visible outside standalone views", () => {
    expect(isResearchPanelVisible("chat", true)).toBe(false)
    expect(isResearchPanelVisible("settings", true)).toBe(false)
    expect(isResearchPanelVisible("wiki", true)).toBe(true)
  })
})

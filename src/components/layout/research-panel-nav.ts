import type { WikiState } from "@/stores/wiki-store"

export function isStandaloneView(view: WikiState["activeView"]): boolean {
  // `jira` is a full-width workspace: searching issues needs the horizontal
  // room, and neither the wiki tree nor the research panel applies to it.
  return view === "chat" || view === "skills" || view === "settings" || view === "jira"
}

export function isResearchPanelVisible(
  activeView: WikiState["activeView"],
  researchPanelOpen: boolean,
): boolean {
  return researchPanelOpen && !isStandaloneView(activeView)
}

export function nextResearchPanelNavState(
  activeView: WikiState["activeView"],
  researchPanelOpen: boolean,
): { activeView: WikiState["activeView"]; researchPanelOpen: boolean } {
  if (isStandaloneView(activeView)) {
    return { activeView: "wiki", researchPanelOpen: true }
  }
  return { activeView, researchPanelOpen: !researchPanelOpen }
}

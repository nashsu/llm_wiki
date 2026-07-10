import type { WikiState } from "@/stores/wiki-store"
import { isStandaloneView } from "./research-panel-nav"

export function getAppLayoutVisibility(
  activeView: WikiState["activeView"],
  researchPanelOpen: boolean,
): { showLeftPanel: boolean; hasRightPanel: boolean } {
  const isStandalone = isStandaloneView(activeView)
  return {
    showLeftPanel: !isStandalone,
    hasRightPanel: !isStandalone && researchPanelOpen,
  }
}

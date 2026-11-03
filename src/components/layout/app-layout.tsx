import { useCallback, useEffect, useState } from "react"
import { useWikiStore } from "@/stores/wiki-store"
import { refreshProjectFileTree } from "@/lib/project-file-tree-refresh"
import { IconSidebar } from "./icon-sidebar"
import { UpdateBanner } from "./update-banner"
import { SidebarPanel } from "./sidebar-panel"
import { ContentArea } from "./content-area"
import { ResearchPanel } from "./research-panel"
import { ActivityPanel } from "./activity-panel"
import { useResearchStore } from "@/stores/research-store"
import { ErrorBoundary } from "@/components/error-boundary"
import { getAppLayoutVisibility } from "./app-layout-visibility"
import { PanelResizeHandle, panelMaxWidth, panelOuterWidth, panelReserve } from "./panel-resize-handle"
import { PanelLeftOpen } from "lucide-react"
import { useTranslation } from "react-i18next"

const LEFT_PANEL_COLLAPSED_KEY = "llm-wiki:left-panel-collapsed"
const COLLAPSED_LEFT_PANEL_WIDTH = 36
const MIN_LEFT_WIDTH = 150
const MIN_RIGHT_WIDTH = 250

interface AppLayoutProps {
  onSwitchProject: () => void
}

export function AppLayout({ onSwitchProject }: AppLayoutProps) {
  const { t } = useTranslation()
  const project = useWikiStore((s) => s.project)
  const activeView = useWikiStore((s) => s.activeView)
  const researchPanelOpen = useResearchStore((s) => s.panelOpen)
  const [leftWidth, setLeftWidth] = useState(280)
  const [rightWidth, setRightWidth] = useState(400)
  const [leftCollapsed, setLeftCollapsed] = useState(
    () => localStorage.getItem(LEFT_PANEL_COLLAPSED_KEY) === "true",
  )

  const loadFileTree = useCallback(async () => {
    if (!project) return
    await refreshProjectFileTree(project.path, {
      projectId: project.id,
      clearDisplayTreeFirst: true,
    })
  }, [project])

  useEffect(() => {
    loadFileTree()
  }, [loadFileTree])

  // Settings and Chat are standalone views. Hide the project file tree,
  // activity strip, and optional right research panel there so those
  // screens use the whole work area.
  const { showLeftPanel, hasRightPanel } = getAppLayoutVisibility(activeView, researchPanelOpen)
  const leftPanelSpace = !showLeftPanel
    ? 0
    : leftCollapsed ? COLLAPSED_LEFT_PANEL_WIDTH : panelOuterWidth(leftWidth)
  const leftReserve = panelReserve(hasRightPanel ? panelOuterWidth(rightWidth) : 0)
  const rightReserve = panelReserve(leftPanelSpace)
  const toggleLeftPanel = () => {
    setLeftCollapsed((value) => {
      const next = !value
      localStorage.setItem(LEFT_PANEL_COLLAPSED_KEY, String(next))
      return next
    })
  }

  return (
    // Outer column layout: full-width update banner on top (when an
    // update is available AND not dismissed for this version), the
    // existing IconSidebar + content row below. Banner is shrink-0
    // so it doesn't compress the work area; main row is flex-1 so
    // it fills the rest of the viewport.
    <div className="flex h-full flex-col bg-background text-foreground">
      <UpdateBanner />
      <div className="flex min-h-0 flex-1">
        <IconSidebar onSwitchProject={onSwitchProject} />
        <div className="relative flex min-w-0 flex-1 overflow-hidden">
          {showLeftPanel && !leftCollapsed && (
            <>
              {/* Left: File tree + Activity */}
              <div
                className="flex shrink-0 flex-col overflow-hidden border-r"
                style={{ width: leftWidth, maxWidth: panelMaxWidth(leftReserve) }}
              >
                <div className="flex-1 overflow-hidden">
                  <SidebarPanel onCollapse={toggleLeftPanel} />
                </div>
                <ActivityPanel />
              </div>
              <PanelResizeHandle
                side="left"
                width={leftWidth}
                min={MIN_LEFT_WIDTH}
                reserve={leftReserve}
                label={t("layout.resizePanel")}
                onResize={setLeftWidth}
              />
            </>
          )}

          {showLeftPanel && leftCollapsed && (
            <div className="flex w-9 shrink-0 justify-center border-r bg-muted/20 pt-2">
              <button
                type="button"
                onClick={toggleLeftPanel}
                className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                title={t("layout.showSidebar", "Show sidebar")}
                aria-label={t("layout.showSidebar", "Show sidebar")}
              >
                <PanelLeftOpen className="h-4 w-4" />
              </button>
            </div>
          )}

          {/* Center: Chat, wiki preview, or tool view */}
          <div className="min-w-0 flex-1 overflow-hidden">
            <ErrorBoundary>
              <ContentArea />
            </ErrorBoundary>
          </div>

          {/* Right panels */}
          {hasRightPanel && (
            <>
              <PanelResizeHandle
                side="right"
                width={rightWidth}
                min={MIN_RIGHT_WIDTH}
                reserve={rightReserve}
                label={t("layout.resizePanel")}
                onResize={setRightWidth}
              />
              <div
                className="flex shrink-0 flex-col overflow-hidden border-l"
                style={{ width: rightWidth, maxWidth: panelMaxWidth(rightReserve) }}
              >
                <ErrorBoundary>
                  <ResearchPanel />
                </ErrorBoundary>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

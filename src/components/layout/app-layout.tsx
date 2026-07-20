import { useCallback, useEffect, useRef, useState } from "react"
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
import { PanelLeftOpen } from "lucide-react"
import { useTranslation } from "react-i18next"

const LEFT_PANEL_COLLAPSED_KEY = "llm-wiki:left-panel-collapsed"

interface AppLayoutProps {
  onSwitchProject: () => void
}

export function AppLayout({ onSwitchProject }: AppLayoutProps) {
  const { t } = useTranslation()
  const project = useWikiStore((s) => s.project)
  const activeView = useWikiStore((s) => s.activeView)
  const researchPanelOpen = useResearchStore((s) => s.panelOpen)
  const [leftWidth, setLeftWidth] = useState(220)
  const [rightWidth, setRightWidth] = useState(400)
  const [leftCollapsed, setLeftCollapsed] = useState(
    () => localStorage.getItem(LEFT_PANEL_COLLAPSED_KEY) === "true",
  )
  const isDraggingLeft = useRef(false)
  const isDraggingRight = useRef(false)
  const containerRef = useRef<HTMLDivElement>(null)

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

  const startDrag = useCallback(
    (side: "left" | "right") => (e: React.MouseEvent) => {
      e.preventDefault()
      if (side === "left") isDraggingLeft.current = true
      else isDraggingRight.current = true
      document.body.style.cursor = "col-resize"
      document.body.style.userSelect = "none"
      document.body.dataset.panelResizing = "true"

      const handleMouseMove = (e: MouseEvent) => {
        if (!containerRef.current) return
        const rect = containerRef.current.getBoundingClientRect()

        if (isDraggingLeft.current) {
          const newWidth = e.clientX - rect.left
          // Hard cap: 150 to 400px
          setLeftWidth(Math.max(150, Math.min(400, newWidth)))
        }
        if (isDraggingRight.current) {
          const newWidth = rect.right - e.clientX
          // Hard cap: 250 to 50% of container
          setRightWidth(Math.max(250, Math.min(rect.width * 0.5, newWidth)))
        }
      }

      const handleMouseUp = () => {
        isDraggingLeft.current = false
        isDraggingRight.current = false
        document.body.style.cursor = ""
        document.body.style.userSelect = ""
        delete document.body.dataset.panelResizing
        document.removeEventListener("mousemove", handleMouseMove)
        document.removeEventListener("mouseup", handleMouseUp)
      }

      document.addEventListener("mousemove", handleMouseMove)
      document.addEventListener("mouseup", handleMouseUp)
    },
    []
  )

  // Settings and Chat are standalone views. Hide the project file tree,
  // activity strip, and optional right research panel there so those
  // screens use the whole work area.
  const { showLeftPanel, hasRightPanel } = getAppLayoutVisibility(activeView, researchPanelOpen)
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
        <div ref={containerRef} className="relative flex min-w-0 flex-1 overflow-hidden">
          {showLeftPanel && !leftCollapsed && (
            <>
              {/* Left: File tree + Activity */}
              <div
                className="flex shrink-0 flex-col overflow-hidden border-r"
                style={{ width: leftWidth }}
              >
                <div className="flex-1 overflow-hidden">
                  <SidebarPanel onCollapse={toggleLeftPanel} />
                </div>
                <ActivityPanel />
              </div>
              <div
                className="w-1.5 shrink-0 cursor-col-resize bg-border/40 transition-colors hover:bg-primary/30 active:bg-primary/40"
                onMouseDown={startDrag("left")}
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
              <div
                className="w-1.5 shrink-0 cursor-col-resize bg-border/40 transition-colors hover:bg-primary/30 active:bg-primary/40"
                onMouseDown={startDrag("right")}
              />
              <div
                className="flex shrink-0 flex-col overflow-hidden border-l"
                style={{ width: rightWidth }}
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

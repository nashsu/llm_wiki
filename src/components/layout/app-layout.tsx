import { useCallback, useEffect, useRef, useState } from "react"
import { useWikiStore } from "@/stores/wiki-store"
import { listDirectory } from "@/commands/fs"
import { normalizePath } from "@/lib/path-utils"
import { IconSidebar } from "./icon-sidebar"
import { UpdateBanner } from "./update-banner"
import { SidebarPanel } from "./sidebar-panel"
import { ContentArea } from "./content-area"
import { PreviewPanel } from "./preview-panel"
import { ResearchPanel } from "./research-panel"
import { ActivityPanel } from "./activity-panel"
import { useResearchStore } from "@/stores/research-store"
import { ErrorBoundary } from "@/components/error-boundary"

interface AppLayoutProps {
  onSwitchProject: () => void
}

export function AppLayout({ onSwitchProject }: AppLayoutProps) {
  const project = useWikiStore((s) => s.project)
  const selectedFile = useWikiStore((s) => s.selectedFile)
  const activeView = useWikiStore((s) => s.activeView)
  const researchPanelOpen = useResearchStore((s) => s.panelOpen)
  const setFileTree = useWikiStore((s) => s.setFileTree)
  const [leftWidth, setLeftWidth] = useState(220)
  const [rightWidth, setRightWidth] = useState(400)
  const isDraggingLeft = useRef(false)
  const isDraggingRight = useRef(false)
  const containerRef = useRef<HTMLDivElement>(null)

  const loadFileTree = useCallback(async () => {
    if (!project) return
    try {
      const tree = await listDirectory(normalizePath(project.path))
      setFileTree(tree)
    } catch (err) {
      console.error("Failed to load file tree:", err)
    }
  }, [project, setFileTree])

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

  // Settings is a full-width admin view — the file tree / activity panel
  // are irrelevant there and their narrow column makes the settings form
  // cramped. Hide both the left sidebar (and the file preview on the
  // right) so the settings screen uses the whole content area.
  const isSettings = activeView === "settings"
  const hasRightPanel = !isSettings && !!(selectedFile || researchPanelOpen)

  return (
    // Outer column layout: full-width update banner on top (when an
    // update is available AND not dismissed for this version), the
    // existing IconSidebar + content row below. Banner is shrink-0
    // so it doesn't compress the work area; main row is flex-1 so
    // it fills the rest of the viewport.
    <div className="flex h-screen flex-col bg-background text-foreground">
      <UpdateBanner />
      <div className="flex min-h-0 flex-1 bg-background/80">
        <IconSidebar onSwitchProject={onSwitchProject} />
        <div ref={containerRef} className="flex min-w-0 flex-1 overflow-hidden">
        {!isSettings && (
          <>
            {/* Left: File tree + Activity */}
            <div
              className="flex shrink-0 flex-col overflow-hidden border-r border-border/80 bg-card/70 shadow-sm shadow-foreground/5"
              style={{ width: leftWidth }}
            >
              <div className="flex-1 overflow-hidden">
                <SidebarPanel />
              </div>
              <ActivityPanel />
            </div>
            <div
              className="w-1.5 shrink-0 cursor-col-resize bg-border/40 transition-colors hover:bg-primary/35 active:bg-primary/45"
              onMouseDown={startDrag("left")}
            />
          </>
        )}

        {/* Center: Chat or view (sources/settings/review) */}
        <div className="min-w-0 flex-1 overflow-hidden bg-background/65">
          <ErrorBoundary>
            <ContentArea />
          </ErrorBoundary>
        </div>

        {/* Right panels */}
        {hasRightPanel && (
          <>
            <div
              className="w-1.5 shrink-0 cursor-col-resize bg-border/40 transition-colors hover:bg-primary/35 active:bg-primary/45"
              onMouseDown={startDrag("right")}
            />
            <div
              className="flex shrink-0 flex-col overflow-hidden border-l border-border/80 bg-card/75 shadow-sm shadow-foreground/5"
              style={{ width: rightWidth }}
            >
              <ErrorBoundary>
                {/* File preview on top (if file selected) */}
                {selectedFile && (
                  <div className={researchPanelOpen ? "flex-1 overflow-hidden border-b" : "flex-1 overflow-hidden"}>
                    <PreviewPanel />
                  </div>
                )}
                {/* Research panel on bottom (if open) */}
                {researchPanelOpen && (
                  <div className={selectedFile ? "h-1/2 shrink-0 overflow-hidden" : "flex-1 overflow-hidden"}>
                    <ResearchPanel />
                  </div>
                )}
              </ErrorBoundary>
            </div>
          </>
        )}
        </div>
      </div>
    </div>
  )
}

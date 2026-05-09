import { useState, useEffect } from "react"
import {
  FileText, FolderOpen, Search, Network, ClipboardCheck, Settings, ArrowLeftRight, ClipboardList, Globe,
} from "lucide-react"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { useWikiStore } from "@/stores/wiki-store"
import { useReviewStore } from "@/stores/review-store"
import { useResearchStore } from "@/stores/research-store"
import { useUpdateStore, hasAvailableUpdate } from "@/stores/update-store"
import { useTranslation } from "react-i18next"
import logoImg from "@/assets/logo.jpg"
import type { WikiState } from "@/stores/wiki-store"
import { normalizePath } from "@/lib/path-utils"

type NavView = WikiState["activeView"]

const NAV_ITEMS: { view: NavView; icon: typeof FileText; labelKey: string }[] = [
  { view: "wiki", icon: FileText, labelKey: "nav.wiki" },
  { view: "sources", icon: FolderOpen, labelKey: "nav.sources" },
  { view: "search", icon: Search, labelKey: "nav.search" },
  { view: "graph", icon: Network, labelKey: "nav.graph" },
  { view: "lint", icon: ClipboardCheck, labelKey: "nav.lint" },
  { view: "review", icon: ClipboardList, labelKey: "nav.review" },
]

interface IconSidebarProps {
  onSwitchProject: () => void
}

export function IconSidebar({ onSwitchProject }: IconSidebarProps) {
  const { t } = useTranslation()
  const activeView = useWikiStore((s) => s.activeView)
  const setActiveView = useWikiStore((s) => s.setActiveView)
  const currentProjectPath = useWikiStore((s) => s.project?.path ? normalizePath(s.project.path) : "")
  const pendingCount = useReviewStore((s) =>
    s.items.filter((i) => !i.resolved && normalizePath(i.projectPath) === currentProjectPath).length,
  )
  const researchPanelOpen = useResearchStore((s) => s.panelOpen)
  const researchActiveCount = useResearchStore((s) => s.tasks.filter((t) => t.status !== "done" && t.status !== "error").length)
  const toggleResearchPanel = useResearchStore((s) => s.setPanelOpen)
  // Use `hasAvailableUpdate` (ignores dismiss state) rather than
  // `shouldShowUpdateBanner`. The dot is a passive signpost — it
  // should keep marking the gear as long as the update exists, even
  // after the user closes the more aggressive top banner. Without
  // this split, dismissing the banner would silently lose the only
  // remaining indicator that an update is available, so the user
  // never finds their way back to it.
  const updateAvailable = useUpdateStore((s) => hasAvailableUpdate(s))

  // Daemon health check
  const [daemonStatus, setDaemonStatus] = useState<string>("starting")
  useEffect(() => {
    const check = async () => {
      try {
        const { clipServerStatus } = await import("@/commands/fs")
        const status = await clipServerStatus()
        setDaemonStatus(status)
      } catch {
        setDaemonStatus("error")
      }
    }
    check()
    const interval = setInterval(check, 30000)
    return () => clearInterval(interval)
  }, [])

  return (
    <TooltipProvider delay={300}>
      <div className="flex h-full w-12 flex-col items-center border-r bg-muted/50 py-2">
        {/* Logo */}
        <div className="mb-2 flex items-center justify-center">
          <img
            src={logoImg}
            alt="LLM Wiki"
            className="h-8 w-8 rounded-[22%]"
          />
        </div>
        {/* Top: main nav items + Deep Research */}
        <div className="flex flex-1 flex-col items-center gap-1">
          {NAV_ITEMS.map(({ view, icon: Icon, labelKey }) => (
            <Tooltip key={view}>
              <TooltipTrigger
                onClick={() => setActiveView(view)}
                className={`relative flex h-10 w-10 items-center justify-center rounded-md transition-colors ${
                  activeView === view
                    ? "bg-accent text-accent-foreground"
                    : "text-muted-foreground hover:bg-accent/50 hover:text-accent-foreground"
                }`}
              >
                <Icon className="h-5 w-5" />
                {view === "review" && pendingCount > 0 && (
                  <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-bold text-primary-foreground">
                    {pendingCount > 99 ? "99+" : pendingCount}
                  </span>
                )}
              </TooltipTrigger>
              <TooltipContent side="right">
                {t(labelKey)}
                {view === "review" && pendingCount > 0 && ` (${pendingCount})`}
              </TooltipContent>
            </Tooltip>
          ))}
          {/* Deep Research — same row as other nav items */}
          <Tooltip>
            <TooltipTrigger
              onClick={() => toggleResearchPanel(!researchPanelOpen)}
              className={`relative flex h-10 w-10 items-center justify-center rounded-md transition-colors ${
                researchPanelOpen
                  ? "bg-accent text-accent-foreground"
                  : "text-muted-foreground hover:bg-accent/50 hover:text-accent-foreground"
              }`}
            >
              <Globe className="h-5 w-5" />
              {researchActiveCount > 0 && (
                <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-blue-500 px-1 text-[10px] font-bold text-white">
                  {researchActiveCount}
                </span>
              )}
            </TooltipTrigger>
            <TooltipContent side="right">Deep Research</TooltipContent>
          </Tooltip>
        </div>
        {/* Bottom: daemon status + settings + switch project */}
        <div className="flex flex-col items-center gap-1 pb-1">
          {/* Daemon status indicator */}
          <Tooltip>
            <TooltipTrigger className="flex h-6 w-6 items-center justify-center">
              <span
                className={`h-2.5 w-2.5 rounded-full ${
                  daemonStatus === "running" ? "bg-emerald-500" :
                  daemonStatus === "starting" ? "bg-amber-400 animate-pulse" :
                  daemonStatus === "port_conflict" ? "bg-red-500" :
                  "bg-red-500 animate-pulse"
                }`}
              />
            </TooltipTrigger>
            <TooltipContent side="right">
              {daemonStatus === "running" && "Clip server running"}
              {daemonStatus === "starting" && "Clip server starting..."}
              {daemonStatus === "port_conflict" && "Port 19827 is occupied. Web Clipper unavailable."}
              {daemonStatus === "error" && "Clip server error. Restarting..."}
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              onClick={() => setActiveView("settings")}
              className={`relative flex h-10 w-10 items-center justify-center rounded-md transition-colors ${
                activeView === "settings"
                  ? "bg-accent text-accent-foreground"
                  : "text-muted-foreground hover:bg-accent/50 hover:text-accent-foreground"
              }`}
            >
              <Settings className="h-5 w-5" />
              {updateAvailable && (
                // Update-available indicator on the Settings gear.
                // Smaller (8px / `h-2 w-2`) so it doesn't shout —
                // the top banner is already the loud surface; this
                // dot is just a quiet "where to go" signpost. Red
                // (vs. previous primary-blue) gives it enough
                // visual contrast that it's still noticeable
                // against the gear icon despite the small size.
                // Dismissed versions clear it automatically via
                // shouldShowUpdateBanner.
                <span
                  className="absolute right-1 top-1 h-2 w-2 rounded-full bg-red-500 ring-2 ring-muted/50"
                  title={t("nav.updateAvailable")}
                />
              )}
            </TooltipTrigger>
            <TooltipContent side="right">
              {t("nav.settings")}
              {updateAvailable ? t("nav.updateAvailableSuffix") : ""}
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              onClick={onSwitchProject}
              className="flex h-10 w-10 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent/50 hover:text-accent-foreground"
            >
              <ArrowLeftRight className="h-5 w-5" />
            </TooltipTrigger>
            <TooltipContent side="right">{t("nav.switchProject")}</TooltipContent>
          </Tooltip>
        </div>
      </div>
    </TooltipProvider>
  )
}

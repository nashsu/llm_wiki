import { useState } from "react"
import { useTranslation } from "react-i18next"
import { PanelLeftClose } from "lucide-react"
import { KnowledgeTree } from "./knowledge-tree"
import { FileTree } from "./file-tree"

interface SidebarPanelProps {
  onCollapse?: () => void
}

export function SidebarPanel({ onCollapse }: SidebarPanelProps) {
  const { t } = useTranslation()
  const [mode, setMode] = useState<"knowledge" | "files">("knowledge")

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 border-b">
        <button
          onClick={() => setMode("knowledge")}
          className={`flex-1 px-3 py-1.5 text-xs font-medium transition-colors ${
            mode === "knowledge"
              ? "border-b-2 border-primary text-foreground"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          {t("sidebar.knowledge")}
        </button>
        <button
          onClick={() => setMode("files")}
          className={`flex-1 px-3 py-1.5 text-xs font-medium transition-colors ${
            mode === "files"
              ? "border-b-2 border-primary text-foreground"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          {t("sidebar.files")}
        </button>
        {onCollapse && (
          <button
            type="button"
            onClick={onCollapse}
            className="flex w-9 shrink-0 items-center justify-center border-l text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            title={t("layout.hideSidebar", "Hide sidebar")}
            aria-label={t("layout.hideSidebar", "Hide sidebar")}
          >
            <PanelLeftClose className="h-4 w-4" />
          </button>
        )}
      </div>
      <div className="flex-1 overflow-hidden">
        {/*
         * Keep both trees mounted so switching tabs does not remount the
         * other one. KnowledgeTree's mount effect re-reads every wiki page
         * over IPC (hundreds of files), discarding expanded groups, the
         * source filter, and scroll position — a full rebuild every time
         * the user pokes the "Files" tab and comes back. Hide instead.
         */}
        <div className={mode === "knowledge" ? "h-full" : "hidden"}>
          <KnowledgeTree />
        </div>
        <div className={mode === "files" ? "h-full" : "hidden"}>
          <FileTree />
        </div>
      </div>
    </div>
  )
}

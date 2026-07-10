import { useWikiStore } from "@/stores/wiki-store"
import { ChatPanel } from "@/components/chat/chat-panel"
import { SettingsView } from "@/components/settings/settings-view"
import { SkillsSection } from "@/components/settings/sections/skills-section"
import { SourcesView } from "@/components/sources/sources-view"
import { ReviewView } from "@/components/review/review-view"
import { LintView } from "@/components/lint/lint-view"
import { SearchView } from "@/components/search/search-view"
import { GraphView } from "@/components/graph/graph-view"
import { PreviewPanel } from "./preview-panel"

export function ContentArea() {
  const activeView = useWikiStore((s) => s.activeView)

  switch (activeView) {
    case "chat":
      return <ChatPanel />
    case "wiki":
      return <PreviewPanel />
    case "settings":
      return <SettingsView />
    case "skills":
      return <SkillsView />
    case "sources":
      return <SourcesView />
    case "review":
      return <ReviewView />
    case "lint":
      return <LintView />
    case "search":
      return <SearchView />
    case "graph":
      return <GraphView />
    default:
      return <PreviewPanel />
  }
}

function SkillsView() {
  return (
    <div className="h-full overflow-y-auto px-8 py-6">
      <div className="mx-auto max-w-3xl">
        <SkillsSection />
      </div>
    </div>
  )
}

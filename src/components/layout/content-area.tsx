import { useEffect, useState } from "react"
import { useWikiStore } from "@/stores/wiki-store"
import { ChatPanel } from "@/components/chat/chat-panel"
import { SettingsView } from "@/components/settings/settings-view"
import { SkillsSection } from "@/components/settings/sections/skills-section"
import { SourcesView } from "@/components/sources/sources-view"
import { ReviewView } from "@/components/review/review-view"
import { LintView } from "@/components/lint/lint-view"
import { SearchView } from "@/components/search/search-view"
import { GraphView } from "@/components/graph/graph-view"
import { HistoryView } from "@/components/history/history-view"
import { JiraView } from "@/components/jira/jira-view"
import { PreviewPanel } from "./preview-panel"

export function ContentArea() {
  const activeView = useWikiStore((s) => s.activeView)
  const project = useWikiStore((s) => s.project)

  // Keep SourcesView mounted after its first visit. Opening a source uses the
  // full-width wiki preview, and unmounting the source tree here would discard
  // its scroll position, expanded folders, and incremental row limit. Hiding
  // the mounted view makes closing the preview a true return operation.
  const [hasMountedSources, setHasMountedSources] = useState(activeView === "sources")

  useEffect(() => {
    if (activeView === "sources") setHasMountedSources(true)
  }, [activeView])

  // Same for SearchView: closing the full-width wiki preview after opening a
  // result must return to the exact search results, not a freshly-mounted
  // empty search page. SearchView holds query + results in local state, so
  // unmounting it discards them.
  const [hasMountedSearch, setHasMountedSearch] = useState(activeView === "search")

  useEffect(() => {
    if (activeView === "search") setHasMountedSearch(true)
  }, [activeView])

  // Keep LintView mounted so a running check continues in the background when
  // the user switches to another view; unmounting it would trigger the
  // abort-on-unmount cleanup in lint-view.tsx and cancel the in-flight check.
  const [hasMountedLint, setHasMountedLint] = useState(activeView === "lint")

  useEffect(() => {
    if (activeView === "lint") setHasMountedLint(true)
  }, [activeView])

  // Same for the wiki preview: switching to chat or another view and back
  // must return to the open page, not remount WikiEditor (losing edit mode,
  // selection panels, and scroll position over a full markdown re-render).
  const [hasMountedWiki, setHasMountedWiki] = useState(activeView === "wiki")

  useEffect(() => {
    if (activeView === "wiki") setHasMountedWiki(true)
  }, [activeView])

  // Keep ReviewView mounted so a running re-analysis sweep continues in the
  // background when the user switches to another view — the sweep itself is
  // store-backed so it survives, but unmounting would reset the "analyzing"
  // button state, making it look like the analysis was cancelled.
  const [hasMountedReview, setHasMountedReview] = useState(activeView === "review")

  useEffect(() => {
    if (activeView === "review") setHasMountedReview(true)
  }, [activeView])

  // Same for JiraView: opening an exported document switches to the wiki
  // preview, and coming back must land on the same search results and mode
  // rather than a fresh empty search.
  const [hasMountedJira, setHasMountedJira] = useState(activeView === "jira")

  useEffect(() => {
    if (activeView === "jira") setHasMountedJira(true)
  }, [activeView])

  const keepSources = hasMountedSources || activeView === "sources"
  const keepSearch = hasMountedSearch || activeView === "search"
  const keepLint = hasMountedLint || activeView === "lint"
  const keepWiki = hasMountedWiki || activeView === "wiki"
  const keepReview = hasMountedReview || activeView === "review"
  const keepJira = hasMountedJira || activeView === "jira"

  // Key the persistent views by project so switching projects remounts them
  // with cleared state instead of surfacing the previous project's results.
  // SearchView / SourcesView are rendered by their wrappers when kept; any
  // other active view goes through ActiveContent.
  return (
    <>
      {keepSources && (
        <div className={activeView === "sources" ? "h-full" : "hidden"}>
          <SourcesView />
        </div>
      )}
      {keepSearch && (
        <div className={activeView === "search" ? "h-full" : "hidden"}>
          <SearchView key={project?.id} />
        </div>
      )}
      {keepLint && (
        <div className={activeView === "lint" ? "h-full" : "hidden"}>
          <LintView key={project?.id} />
        </div>
      )}
      {keepWiki && (
        <div className={activeView === "wiki" ? "h-full" : "hidden"}>
          <PreviewPanel />
        </div>
      )}
      {keepReview && (
        <div className={activeView === "review" ? "h-full" : "hidden"}>
          <ReviewView key={project?.id} />
        </div>
      )}
      {keepJira && (
        <div className={activeView === "jira" ? "h-full" : "hidden"}>
          <JiraView key={project?.id} />
        </div>
      )}
      {activeView !== "sources" &&
        activeView !== "search" &&
        activeView !== "lint" &&
        activeView !== "wiki" &&
        activeView !== "review" &&
        activeView !== "jira" && <ActiveContent activeView={activeView} />}
    </>
  )
}

function ActiveContent({
  activeView,
}: {
  activeView: ReturnType<typeof useWikiStore.getState>["activeView"]
}) {
  switch (activeView) {
    case "chat":
      return <ChatPanel />
    case "wiki":
      return null
    case "settings":
      return <SettingsView />
    case "skills":
      return <SkillsView />
    case "sources":
      return null
    case "review":
      return null
    case "jira":
      return null
    case "lint":
      return null
    case "search":
      return <SearchView />
    case "graph":
      return <GraphView />
    case "history":
      return <HistoryView />
    default:
      return null
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

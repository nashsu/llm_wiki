import { Suspense, lazy } from "react"
import { useWikiStore } from "@/stores/wiki-store"
import { ChatPanel } from "@/components/chat/chat-panel"

const SettingsView = lazy(() =>
  import("@/components/settings/settings-view").then((m) => ({ default: m.SettingsView })),
)
const SourcesView = lazy(() =>
  import("@/components/sources/sources-view").then((m) => ({ default: m.SourcesView })),
)
const ReviewView = lazy(() =>
  import("@/components/review/review-view").then((m) => ({ default: m.ReviewView })),
)
const LintView = lazy(() =>
  import("@/components/lint/lint-view").then((m) => ({ default: m.LintView })),
)
const SearchView = lazy(() =>
  import("@/components/search/search-view").then((m) => ({ default: m.SearchView })),
)
const GraphView = lazy(() =>
  import("@/components/graph/graph-view").then((m) => ({ default: m.GraphView })),
)

function ViewSpinner() {
  return (
    <div className="flex h-full items-center justify-center text-muted-foreground">
      <span className="text-sm animate-pulse">Loading...</span>
    </div>
  )
}

export function ContentArea() {
  const activeView = useWikiStore((s) => s.activeView)

  switch (activeView) {
    case "settings":
      return <Suspense fallback={<ViewSpinner />}><SettingsView /></Suspense>
    case "sources":
      return <Suspense fallback={<ViewSpinner />}><SourcesView /></Suspense>
    case "review":
      return <Suspense fallback={<ViewSpinner />}><ReviewView /></Suspense>
    case "lint":
      return <Suspense fallback={<ViewSpinner />}><LintView /></Suspense>
    case "search":
      return <Suspense fallback={<ViewSpinner />}><SearchView /></Suspense>
    case "graph":
      return <Suspense fallback={<ViewSpinner />}><GraphView /></Suspense>
    default:
      return <ChatPanel />
  }
}

import { lazy, Suspense } from "react"
import type { ReactNode } from "react"
import { useWikiStore } from "@/stores/wiki-store"

const ChatPanel = lazy(() => import("@/components/chat/chat-panel").then((module) => ({ default: module.ChatPanel })))
const SettingsView = lazy(() => import("@/components/settings/settings-view").then((module) => ({ default: module.SettingsView })))
const SourcesView = lazy(() => import("@/components/sources/sources-view").then((module) => ({ default: module.SourcesView })))
const ReviewView = lazy(() => import("@/components/review/review-view").then((module) => ({ default: module.ReviewView })))
const LintView = lazy(() => import("@/components/lint/lint-view").then((module) => ({ default: module.LintView })))
const SearchView = lazy(() => import("@/components/search/search-view").then((module) => ({ default: module.SearchView })))
const GraphView = lazy(() => import("@/components/graph/graph-view").then((module) => ({ default: module.GraphView })))

export function ContentArea() {
  const activeView = useWikiStore((s) => s.activeView)

  let view: ReactNode
  switch (activeView) {
    case "settings":
      view = <SettingsView />
      break
    case "sources":
      view = <SourcesView />
      break
    case "review":
      view = <ReviewView />
      break
    case "lint":
      view = <LintView />
      break
    case "search":
      view = <SearchView />
      break
    case "graph":
      view = <GraphView />
      break
    default:
      view = <ChatPanel />
  }

  return <Suspense fallback={null}>{view}</Suspense>
}

import { useState } from "react"
import { useTranslation } from "react-i18next"
import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Loader2,
  Wrench,
  XCircle,
} from "lucide-react"
import type { AgentToolCallRecord } from "@/stores/chat-store"
import { formatDurationMs, getAgentToolStatus, safeStringify, type AgentToolStatus } from "./agent-format"

interface AgentToolTimelineProps {
  toolCalls: AgentToolCallRecord[]
  defaultCollapsed?: boolean
}

const STATUS_CLASS: Record<AgentToolStatus, string> = {
  pending: "text-muted-foreground bg-muted",
  running: "text-blue-600 bg-blue-50 dark:text-blue-400 dark:bg-blue-950/40",
  done: "text-emerald-600 bg-emerald-50 dark:text-emerald-400 dark:bg-emerald-950/40",
  failed: "text-red-600 bg-red-50 dark:text-red-400 dark:bg-red-950/40",
}

function StatusIcon({ status }: { status: AgentToolStatus }) {
  if (status === "running") return <Loader2 className="h-3.5 w-3.5 animate-spin" />
  if (status === "done") return <CheckCircle2 className="h-3.5 w-3.5" />
  if (status === "failed") return <XCircle className="h-3.5 w-3.5" />
  return <Wrench className="h-3.5 w-3.5" />
}

export function AgentToolTimeline({ toolCalls, defaultCollapsed = true }: AgentToolTimelineProps) {
  const { t } = useTranslation()
  const [collapsed, setCollapsed] = useState(defaultCollapsed)
  if (toolCalls.length === 0) return null

  const failed = toolCalls.filter((call) => getAgentToolStatus(call) === "failed").length
  const running = toolCalls.filter((call) => getAgentToolStatus(call) === "running").length

  return (
    <div className="rounded-md border border-border/60 bg-background/70 text-xs">
      <button
        type="button"
        onClick={() => setCollapsed((v) => !v)}
        title={collapsed ? t("agent.actions.expand") : t("agent.actions.collapse")}
        aria-label={collapsed ? t("agent.actions.expand") : t("agent.actions.collapse")}
        className="flex w-full items-center gap-1.5 px-2.5 py-2 text-left text-muted-foreground hover:text-foreground"
      >
        {collapsed ? <ChevronRight className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
        <Wrench className="h-3.5 w-3.5" />
        <span className="font-medium">{t("agent.timeline.title")}</span>
        <span className="ml-auto text-[10px]">
          {toolCalls.length}
          {running > 0 ? ` / ${t("agent.status.running")}: ${running}` : ""}
          {failed > 0 ? ` / ${t("agent.status.failed")}: ${failed}` : ""}
        </span>
      </button>
      {!collapsed && (
        <div className="space-y-1.5 px-2.5 pb-2">
          {toolCalls.map((call, index) => {
            const status = getAgentToolStatus(call)
            const hasDetails = call.inputPreview !== undefined || call.error
            return (
              <div key={`${call.toolUseId ?? call.toolName}-${index}`} className="rounded border border-border/50 bg-muted/20 p-2">
                <div className="flex min-w-0 items-center gap-2">
                  <span className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] ${STATUS_CLASS[status]}`}>
                    <StatusIcon status={status} />
                    {t(`agent.status.${status}`)}
                  </span>
                  <span className="min-w-0 flex-1 truncate font-medium text-foreground">{call.toolName}</span>
                  <span className="shrink-0 text-[10px] text-muted-foreground">{formatDurationMs(call.durationMs)}</span>
                </div>
                {hasDetails && (
                  <details className="mt-1.5" open={status === "running" || status === "failed"}>
                    <summary className="cursor-pointer text-[10px] text-muted-foreground">
                      {status === "failed" ? t("agent.timeline.error") : t("agent.timeline.input")}
                    </summary>
                    {call.error && (
                      <pre className="mt-1 max-h-28 overflow-auto rounded bg-red-950/5 p-2 text-[10px] text-red-700 dark:text-red-300">
                        {call.error}
                      </pre>
                    )}
                    {call.inputPreview !== undefined && (
                      <pre className="mt-1 max-h-36 overflow-auto rounded bg-background/80 p-2 text-[10px] text-muted-foreground">
                        {safeStringify(call.inputPreview)}
                      </pre>
                    )}
                  </details>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

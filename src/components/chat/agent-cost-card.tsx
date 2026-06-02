import { Clock, DollarSign, Hash, Repeat2 } from "lucide-react"
import { useTranslation } from "react-i18next"
import { formatCostUsd, formatDurationMs, formatTokenCount } from "./agent-format"

export interface AgentCostCardProps {
  costUsd?: number
  inputTokens?: number
  outputTokens?: number
  durationMs?: number
  numTurns?: number
}

export function hasAgentCostData(props: AgentCostCardProps): boolean {
  return (
    props.costUsd !== undefined ||
    props.inputTokens !== undefined ||
    props.outputTokens !== undefined ||
    props.durationMs !== undefined ||
    props.numTurns !== undefined
  )
}

export function AgentCostCard(props: AgentCostCardProps) {
  const { t } = useTranslation()
  if (!hasAgentCostData(props)) return null

  const items = [
    {
      key: "cost",
      icon: DollarSign,
      label: t("agent.cost.cost"),
      value: formatCostUsd(props.costUsd),
    },
    {
      key: "input",
      icon: Hash,
      label: t("agent.cost.inputTokens"),
      value: formatTokenCount(props.inputTokens),
    },
    {
      key: "output",
      icon: Hash,
      label: t("agent.cost.outputTokens"),
      value: formatTokenCount(props.outputTokens),
    },
    {
      key: "turns",
      icon: Repeat2,
      label: t("agent.cost.turns"),
      value: formatTokenCount(props.numTurns),
    },
    {
      key: "duration",
      icon: Clock,
      label: t("agent.cost.duration"),
      value: formatDurationMs(props.durationMs),
    },
  ]

  return (
    <div className="rounded-md border border-border/60 bg-background/70 px-2.5 py-2 text-xs">
      <div className="mb-1.5 font-medium text-muted-foreground">{t("agent.cost.title")}</div>
      <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-5">
        {items.map((item) => {
          const Icon = item.icon
          return (
            <div key={item.key} className="min-w-0 rounded bg-muted/40 px-2 py-1">
              <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
                <Icon className="h-3 w-3 shrink-0" />
                <span className="truncate">{item.label}</span>
              </div>
              <div className="mt-0.5 truncate font-medium text-foreground">{item.value}</div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

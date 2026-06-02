import { useTranslation } from "react-i18next"
import { Wrench } from "lucide-react"
import type { ReactNode } from "react"
import type { SDKContentBlock, SDKTextBlock, SDKToolResultBlock } from "@/lib/agent/agent-types"
import { safeStringify } from "./agent-format"

interface AgentBlockListProps {
  blocks: SDKContentBlock[]
  renderText: (content: string) => ReactNode
}

function toolResultText(block: SDKToolResultBlock): string {
  if (typeof block.content === "string") return block.content
  return block.content
    .filter((item): item is SDKTextBlock => item.type === "text")
    .map((item) => item.text)
    .join("")
}

export function AgentBlockList({ blocks, renderText }: AgentBlockListProps) {
  const { t } = useTranslation()
  if (blocks.length === 0) return null

  return (
    <div className="space-y-2">
      {blocks.map((block, index) => {
        if (block.type === "text") {
          return <div key={index}>{renderText(block.text)}</div>
        }
        if (block.type === "tool_use") {
          return (
            <details key={block.id || index} className="rounded-md border border-border/60 bg-background/70 px-2 py-1.5">
              <summary className="flex cursor-pointer items-center gap-1.5 text-xs font-medium text-muted-foreground">
                <Wrench className="h-3.5 w-3.5" />
                {t("agent.blocks.toolUse")}: <span className="text-foreground">{block.name}</span>
              </summary>
              <pre className="mt-1.5 max-h-40 overflow-auto rounded bg-muted/40 p-2 text-[10px] text-muted-foreground">
                {safeStringify(block.input)}
              </pre>
            </details>
          )
        }
        if (block.type === "tool_result") {
          const text = toolResultText(block)
          return (
            <details key={block.tool_use_id || index} className="rounded-md border border-border/60 bg-background/70 px-2 py-1.5">
              <summary className="cursor-pointer text-xs font-medium text-muted-foreground">
                {t("agent.blocks.toolResult")}
              </summary>
              {text ? (
                <div className="mt-1.5">{renderText(text)}</div>
              ) : (
                <pre className="mt-1.5 max-h-40 overflow-auto rounded bg-muted/40 p-2 text-[10px] text-muted-foreground">
                  {safeStringify(block.content)}
                </pre>
              )}
            </details>
          )
        }
        return null
      })}
    </div>
  )
}

import { useCallback, useEffect, useMemo, useState, type KeyboardEvent } from "react"
import { useTranslation } from "react-i18next"
import { ShieldAlert } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import {
  buildAgentPermissionDecision,
  formatAgentPermissionInputPreview,
  type AgentPermissionAction,
} from "./agent-permission"
import { useChatStore, type AgentPermissionRequestRecord } from "@/stores/chat-store"
import type { AgentPermissionDecision } from "@/lib/agent/agent-types"

interface AgentPermissionDialogProps {
  request: AgentPermissionRequestRecord | null
  onDecision: (requestId: string, decision: AgentPermissionDecision) => void
}

interface AgentPermissionDialogBodyProps {
  request: AgentPermissionRequestRecord
  remainingSeconds: number
  onAction: (action: AgentPermissionAction) => void
}

export function AgentPermissionDialogBody({
  request,
  remainingSeconds,
  onAction,
}: AgentPermissionDialogBodyProps) {
  const { t } = useTranslation()
  const toolLabel = request.displayName ?? request.toolName
  const inputPreview = useMemo(
    () => formatAgentPermissionInputPreview(request.inputPreview),
    [request.inputPreview],
  )

  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <ShieldAlert className="h-4 w-4 text-amber-500" />
          {request.title || t("agent.permission.title")}
        </DialogTitle>
        <DialogDescription>
          {request.description || t("agent.permission.noDescription")}
        </DialogDescription>
      </DialogHeader>

      <div className="min-h-0 space-y-3 overflow-y-auto pr-1">
        <div className="grid gap-1 text-xs">
          <span className="font-medium text-muted-foreground">
            {t("agent.permission.tool")}
          </span>
          <span className="break-words rounded-md bg-muted/50 px-2 py-1 text-foreground">
            {toolLabel}
          </span>
        </div>

        {request.blockedPath && (
          <div className="grid gap-1 text-xs">
            <span className="font-medium text-muted-foreground">
              {t("agent.permission.blockedPath")}
            </span>
            <span className="break-all rounded-md bg-muted/50 px-2 py-1 font-mono text-[11px] text-foreground">
              {request.blockedPath}
            </span>
          </div>
        )}

        <div className="grid gap-1 text-xs">
          <span className="font-medium text-muted-foreground">
            {t("agent.permission.input")}
          </span>
          <pre className="max-h-56 overflow-auto rounded-md bg-muted/50 p-2 text-[11px] text-muted-foreground">
            {inputPreview}
          </pre>
        </div>

        <p className="text-xs text-muted-foreground">
          {t("agent.permission.expiresIn", { seconds: remainingSeconds })}
        </p>
        <p className="text-[11px] text-muted-foreground">
          {t("agent.permission.keyboardHint")}
        </p>
      </div>

      <DialogFooter className="flex-col gap-2 sm:flex-row sm:flex-wrap">
        <Button variant="outline" onClick={() => onAction("deny")}>
          {t("agent.permission.deny")}
        </Button>
        <Button variant="destructive" onClick={() => onAction("deny_interrupt")}>
          {t("agent.permission.denyInterrupt")}
        </Button>
        <Button variant="outline" onClick={() => onAction("allow_permanent")}>
          {t("agent.permission.allowPermanent")}
        </Button>
        <Button onClick={() => onAction("allow_temporary")}>
          {t("agent.permission.allowTemporary")}
        </Button>
      </DialogFooter>
    </>
  )
}

export function AgentPermissionDialog({ request, onDecision }: AgentPermissionDialogProps) {
  const [now, setNow] = useState(() => Date.now())
  const remainingSeconds = request
    ? Math.max(0, Math.ceil((request.expiresAt - now) / 1000))
    : 0

  useEffect(() => {
    if (!request) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [request])

  const decide = useCallback(
    (action: AgentPermissionAction) => {
      if (!request) return
      onDecision(request.requestId, buildAgentPermissionDecision(action, request))
    },
    [onDecision, request],
  )

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open) decide("deny")
    },
    [decide],
  )

  const handleKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (event.key === "Enter") {
        event.preventDefault()
        decide("allow_temporary")
      }
      if (event.key === "Escape") {
        event.preventDefault()
        decide("deny")
      }
    },
    [decide],
  )

  return (
    <Dialog open={Boolean(request)} onOpenChange={handleOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="max-h-[90vh] max-w-2xl grid-rows-[auto_1fr_auto] overflow-hidden"
        onKeyDown={handleKeyDown}
      >
        {request && (
          <AgentPermissionDialogBody
            request={request}
            remainingSeconds={remainingSeconds}
            onAction={decide}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

export function AgentPermissionDialogHost() {
  const request = useChatStore((s) => s.activeAgentPermissionRequest)
  const resolveAgentPermission = useChatStore((s) => s.resolveAgentPermission)

  return (
    <AgentPermissionDialog
      request={request}
      onDecision={resolveAgentPermission}
    />
  )
}

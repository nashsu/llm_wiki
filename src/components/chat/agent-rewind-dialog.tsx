import { useCallback } from "react"
import { useTranslation } from "react-i18next"
import { RotateCcw } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { rewindAgentFiles } from "@/lib/agent/agent-transport"
import { useChatStore } from "@/stores/chat-store"

export function AgentRewindDialogHost() {
  const { t } = useTranslation()
  const request = useChatStore((s) => s.activeAgentRewindRequest)
  const clearAgentRewindRequest = useChatStore((s) => s.clearAgentRewindRequest)

  const confirm = useCallback(() => {
    if (!request) return
    void rewindAgentFiles(request.streamId, request.userMessageId)
    clearAgentRewindRequest()
  }, [clearAgentRewindRequest, request])

  return (
    <Dialog open={Boolean(request)} onOpenChange={(open) => {
      if (!open) clearAgentRewindRequest()
    }}>
      <DialogContent showCloseButton={false} className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <RotateCcw className="h-4 w-4 text-amber-500" />
            {t("agent.rewind.title")}
          </DialogTitle>
          <DialogDescription>
            {t("agent.rewind.description")}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={clearAgentRewindRequest}>
            {t("agent.rewind.cancel")}
          </Button>
          <Button variant="destructive" onClick={confirm}>
            {t("agent.rewind.confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

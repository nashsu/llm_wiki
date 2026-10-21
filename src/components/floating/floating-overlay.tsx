import { useEffect, useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import { MessageSquare, LoaderCircle, Minimize2, Maximize2, X } from "lucide-react"
import { useFloatingStore } from "@/stores/floating-store"
import { useChatStore } from "@/stores/chat-store"
import { ChatMessage } from "@/components/chat/chat-message"

/**
 * The floating overlay lives in the same window as the app. When the user
 * collapses the app ("收起为浮窗"), the main window is morphed into a small
 * frameless always-on-top window; this overlay fills it with either the
 * ball or the read-only chat card. The underlying app stays mounted on
 * purpose — the chat panel keeps streaming — the overlay just sits on top.
 * When mode is "full" we render nothing and the normal app shows.
 */
export function FloatingOverlay() {
  const { t } = useTranslation()
  const mode = useFloatingStore((s) => s.mode)
  const setMode = useFloatingStore((s) => s.setMode)
  const isStreaming = useChatStore((s) => s.isStreaming)
  const activeConversationId = useChatStore((s) => s.activeConversationId)
  // Select stable store slices and memoize the filtered list — returning a
  // fresh array from the selector would make zustand's useSyncExternalStore
  // treat every snapshot as changed and loop ("getSnapshot should be cached").
  const allMessages = useChatStore((s) => s.messages)
  const messages = useMemo(
    () => (activeConversationId ? allMessages.filter((m) => m.conversationId === activeConversationId) : []),
    [allMessages, activeConversationId],
  )
  const [previewText, setPreviewText] = useState<string | null>(null)

  // Reply-finished notice: when a stream completes while the window is
  // collapsed to the ball, grow it into a small capsule showing a snippet of
  // the assistant's reply, so the user sees "the answer is ready" without
  // being taken to the full chat window.
  useEffect(() => {
    const unsub = useChatStore.subscribe((state, prev) => {
      if (!(prev.isStreaming && !state.isStreaming)) return
      if (useFloatingStore.getState().mode !== "ball") return
      const lastAssistant = useChatStore.getState()
        .getActiveMessages()
        .filter((m) => m.role === "assistant")
        .pop()
      if (!lastAssistant) return
      const text = lastAssistant.content.replace(/\s+/g, " ").trim()
      setPreviewText(text.slice(0, 96))
      useFloatingStore.getState().setMode("preview")
    })
    return unsub
  }, [])

  if (mode === "full") return null

  return (
    <div className="fixed inset-0 z-50 overflow-hidden">
      {mode === "ball" && (
        <div
          onClick={() => setMode("chat")}
          data-tauri-drag-region
          role="button"
          tabIndex={0}
          className="flex h-full w-full cursor-pointer items-center justify-center bg-card text-card-foreground transition-colors hover:bg-accent"
          title={t("floating.openChat")}
          aria-label={t("floating.openChat")}
        >
          {isStreaming ? (
            <LoaderCircle className="h-6 w-6 animate-spin" />
          ) : (
            <MessageSquare className="h-6 w-6" />
          )}
        </div>
      )}

      {mode === "preview" && (
        <div
          className="flex h-full w-full flex-col bg-card text-card-foreground shadow-xl"
          data-tauri-drag-region
        >
          <div className="flex items-start gap-1.5 p-2">
            <p className="min-w-0 flex-1 text-xs leading-snug text-foreground line-clamp-3">
              {previewText || t("floating.replyDone")}
            </p>
            <button
              type="button"
              onClick={() => {
                setPreviewText(null)
                setMode("full")
              }}
              className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              title={t("floating.openApp")}
            >
              <Maximize2 className="h-3.5 w-3.5" />
              <span>{t("floating.openApp")}</span>
            </button>
            <button
              type="button"
              onClick={() => {
                setPreviewText(null)
                setMode("ball")
              }}
              className="flex shrink-0 h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              title={t("floating.collapse")}
              aria-label={t("floating.collapse")}
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}

      {mode === "chat" && (
        <div
          className="flex h-full w-full flex-col bg-card text-card-foreground shadow-xl"
          data-tauri-drag-region
        >
          <div
            className="flex shrink-0 items-center gap-2 border-b px-3 py-2"
            data-tauri-drag-region
          >
            <MessageSquare className="h-4 w-4 text-muted-foreground" />
            <span className="flex-1 truncate text-sm font-semibold">
              {t("floating.chatTitle")}
            </span>
            <button
              type="button"
              onClick={() => setMode("ball")}
              className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              title={t("floating.collapse")}
              aria-label={t("floating.collapse")}
            >
              <Minimize2 className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => setMode("full")}
              className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              title={t("floating.openApp")}
            >
              <Maximize2 className="h-3.5 w-3.5" />
              <span>{t("floating.openApp")}</span>
            </button>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
            {!activeConversationId || messages.length === 0 ? (
              <p className="mt-8 text-center text-sm text-muted-foreground">
                {t("floating.empty")}
              </p>
            ) : (
              messages.map((m) => <ChatMessage key={m.id} message={m} />)
            )}
          </div>
        </div>
      )}
    </div>
  )
}

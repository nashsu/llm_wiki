import { useEffect, useRef, useState, useCallback } from "react"
import { FileSearch, Globe2, Send, Square } from "lucide-react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { isImeComposing } from "@/lib/keyboard-utils"

export interface ChatSendOptions {
  useWebSearch: boolean
  useAnyTxtSearch: boolean
}

interface ChatInputProps {
  onSend: (text: string, options: ChatSendOptions) => void
  onStop: () => void
  isStreaming: boolean
  anyTxtAvailable?: boolean
  placeholder?: string
}

export function ChatInput({ onSend, onStop, isStreaming, anyTxtAvailable = true, placeholder }: ChatInputProps) {
  const { t } = useTranslation()
  const [value, setValue] = useState("")
  const [useWebSearch, setUseWebSearch] = useState(false)
  const [useAnyTxtSearch, setUseAnyTxtSearch] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (!anyTxtAvailable) setUseAnyTxtSearch(false)
  }, [anyTxtAvailable])

  const handleInput = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setValue(e.target.value)
    const ta = e.target
    ta.style.height = "auto"
    ta.style.height = `${Math.min(ta.scrollHeight, 120)}px`
  }, [])

  const handleSend = useCallback(() => {
    const trimmed = value.trim()
    if (!trimmed || isStreaming) return
    onSend(trimmed, { useWebSearch, useAnyTxtSearch })
    setValue("")
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto"
    }
  }, [value, isStreaming, onSend, useWebSearch, useAnyTxtSearch])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // Don't submit on the Enter that commits an IME candidate —
      // the user is mid-composition (Chinese / Japanese / Korean
      // input method picking an English word or phrase) and would
      // see the message fire before they finished typing.
      if (isImeComposing(e)) return
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault()
        handleSend()
      }
    },
    [handleSend],
  )

  const searchToggleClass = (active: boolean) =>
    `inline-flex h-7 items-center gap-1.5 rounded-md border px-2.5 text-xs font-medium transition-colors ${
      active
        ? "border-border bg-accent text-foreground shadow-sm"
        : "border-transparent bg-transparent text-muted-foreground hover:bg-accent/60 hover:text-foreground"
    } disabled:pointer-events-none disabled:opacity-50`

  return (
    <div className="border-t bg-background/95 p-3">
      <div className="rounded-lg border border-border/80 bg-card/80 p-2 shadow-sm ring-1 ring-black/5 focus-within:border-ring/60 focus-within:ring-ring/20 dark:ring-white/5">
        <textarea
          ref={textareaRef}
          value={value}
          dir="auto"
          onChange={handleInput}
          onKeyDown={handleKeyDown}
          placeholder={placeholder ?? "Type a message... (Enter to send, Shift+Enter for newline)"}
          disabled={isStreaming}
          rows={1}
          className="block w-full resize-none border-0 bg-transparent px-2 py-2 text-sm leading-6 placeholder:text-muted-foreground focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
          style={{ maxHeight: "120px", overflowY: "auto" }}
        />
        <div className="mt-1 flex items-center justify-between gap-3 border-t border-border/50 pt-2">
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            <button
              type="button"
              aria-pressed={useWebSearch}
              onClick={() => setUseWebSearch((v) => !v)}
              disabled={isStreaming}
              className={searchToggleClass(useWebSearch)}
            >
              <Globe2 className="h-3.5 w-3.5" />
              {t("chat.useWebSearch")}
              <span
                className={`ml-0.5 h-1.5 w-1.5 rounded-full ${
                  useWebSearch ? "bg-emerald-500" : "bg-muted-foreground/30"
                }`}
              />
            </button>
            <TooltipProvider delay={0}>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <span className="inline-flex" />
                  }
                >
                  <button
                    type="button"
                    aria-pressed={useAnyTxtSearch}
                    onClick={() => setUseAnyTxtSearch((v) => !v)}
                    disabled={isStreaming || !anyTxtAvailable}
                    className={searchToggleClass(useAnyTxtSearch)}
                  >
                    <FileSearch className="h-3.5 w-3.5" />
                    {t("chat.useAnyTxtSearch")}
                    <span
                      className={`ml-0.5 h-1.5 w-1.5 rounded-full ${
                        useAnyTxtSearch ? "bg-emerald-500" : "bg-muted-foreground/30"
                      }`}
                    />
                  </button>
                </TooltipTrigger>
                {!anyTxtAvailable && (
                  <TooltipContent side="top" className="max-w-64 whitespace-normal leading-relaxed">
                    {t("chat.enableAnyTxtInSettings")}
                  </TooltipContent>
                )}
              </Tooltip>
            </TooltipProvider>
          </div>
          {isStreaming ? (
            <Button
              variant="destructive"
              size="sm"
              onClick={onStop}
              className="h-8 shrink-0 gap-1.5 rounded-md px-3"
              title={t("chat.stopGeneration")}
            >
              <Square className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">{t("chat.stopGeneration")}</span>
            </Button>
          ) : (
            <Button
              size="sm"
              onClick={handleSend}
              disabled={!value.trim()}
              className="h-8 shrink-0 gap-1.5 rounded-md px-3"
              title={t("chat.sendMessage")}
            >
              <Send className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">{t("chat.sendMessage")}</span>
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}

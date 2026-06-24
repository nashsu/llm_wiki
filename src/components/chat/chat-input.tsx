import { useEffect, useRef, useState, useCallback } from "react"
import { FileSearch, Globe2, ImagePlus, Send, Square, X } from "lucide-react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { isImeComposing } from "@/lib/keyboard-utils"
import type { MessageImage } from "@/stores/chat-store"
import {
  MAX_IMAGE_BYTES,
  MAX_IMAGE_MB,
  MAX_IMAGES_PER_MESSAGE,
  fileToMessageImage,
  isAcceptedImageType,
  messageImageToDataUrl,
} from "@/lib/chat-image-utils"

export interface ChatSendOptions {
  useWebSearch: boolean
  useAnyTxtSearch: boolean
}

interface ChatInputProps {
  onSend: (text: string, images: MessageImage[], options: ChatSendOptions) => void
  onStop: () => void
  isStreaming: boolean
  useWebSearch: boolean
  useAnyTxtSearch: boolean
  onUseWebSearchChange: (enabled: boolean) => void
  onUseAnyTxtSearchChange: (enabled: boolean) => void
  anyTxtAvailable?: boolean
  imageInputAvailable?: boolean
  placeholder?: string
}

export function ChatInput({
  onSend,
  onStop,
  isStreaming,
  useWebSearch,
  useAnyTxtSearch,
  onUseWebSearchChange,
  onUseAnyTxtSearchChange,
  anyTxtAvailable = true,
  imageInputAvailable = true,
  placeholder,
}: ChatInputProps) {
  const { t } = useTranslation()
  const [value, setValue] = useState("")
  const [images, setImages] = useState<MessageImage[]>([])
  const [imageError, setImageError] = useState<string | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!anyTxtAvailable && useAnyTxtSearch) onUseAnyTxtSearchChange(false)
  }, [anyTxtAvailable, onUseAnyTxtSearchChange, useAnyTxtSearch])

  // Validate + decode a batch of files (from paste, drop, or the file
  // picker) and append the accepted ones to `images`. Rejections set a
  // transient error message rather than throwing — one bad file should
  // never block the good ones in the same batch.
  const addFiles = useCallback(
    async (files: File[]) => {
      const imageFiles = files.filter((f) => f.type.startsWith("image/"))
      if (imageFiles.length === 0) return
      if (!imageInputAvailable) {
        setImageError(t("chat.imageInputUnavailable"))
        return
      }
      let error: string | null = null
      const accepted: MessageImage[] = []
      // Read current count via the functional updater below; here we
      // pre-compute remaining slots from the latest render's state.
      let remaining = MAX_IMAGES_PER_MESSAGE - images.length
      for (const file of imageFiles) {
        if (remaining <= 0) {
          error = t("chat.tooManyImages", { max: MAX_IMAGES_PER_MESSAGE })
          break
        }
        if (!isAcceptedImageType(file.type)) {
          error = t("chat.unsupportedImageType", { type: file.type || "?" })
          continue
        }
        if (file.size > MAX_IMAGE_BYTES) {
          error = t("chat.imageTooLarge", { max: MAX_IMAGE_MB, name: file.name || "image" })
          continue
        }
        try {
          accepted.push(await fileToMessageImage(file))
          remaining -= 1
        } catch {
          error = t("chat.unsupportedImageType", { type: file.type || "?" })
        }
      }
      if (accepted.length > 0) {
        setImages((prev) => [...prev, ...accepted].slice(0, MAX_IMAGES_PER_MESSAGE))
      }
      setImageError(error)
    },
    [imageInputAvailable, images.length, t],
  )

  const handlePaste = useCallback(
    (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const items = e.clipboardData?.items
      if (!items) return
      const files: File[] = []
      for (const item of items) {
        if (item.kind === "file" && item.type.startsWith("image/")) {
          const file = item.getAsFile()
          if (file) files.push(file)
        }
      }
      if (files.length > 0) {
        // Prevent the image's stray name/path from landing in the
        // textarea as text on browsers that surface both.
        e.preventDefault()
        void addFiles(files)
      }
    },
    [addFiles],
  )

  const handleFilePick = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files ? Array.from(e.target.files) : []
      void addFiles(files)
      // Reset so picking the same file again still fires onChange.
      e.target.value = ""
    },
    [addFiles],
  )

  const removeImage = useCallback((index: number) => {
    setImages((prev) => prev.filter((_, i) => i !== index))
    setImageError(null)
  }, [])

  const handleInput = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setValue(e.target.value)
    const ta = e.target
    ta.style.height = "auto"
    ta.style.height = `${Math.min(ta.scrollHeight, 120)}px`
  }, [])

  const handleSend = useCallback(() => {
    const trimmed = value.trim()
    // Allow image-only messages: send if there's text OR at least one image.
    if ((!trimmed && images.length === 0) || isStreaming) return
    if (images.length > 0 && !imageInputAvailable) {
      setImageError(t("chat.imageInputUnavailable"))
      return
    }
    onSend(trimmed, images, { useWebSearch, useAnyTxtSearch })
    setValue("")
    setImages([])
    setImageError(null)
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto"
    }
  }, [imageInputAvailable, images, isStreaming, onSend, t, useAnyTxtSearch, useWebSearch, value])

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
        {images.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-2 px-1">
            {images.map((img, i) => (
              <div key={i} className="group relative h-16 w-16 overflow-hidden rounded-md border border-border/70">
                <img
                  src={messageImageToDataUrl(img)}
                  alt=""
                  className="h-full w-full object-cover"
                />
                <button
                  type="button"
                  onClick={() => removeImage(i)}
                  className="absolute right-0.5 top-0.5 rounded-full bg-background/80 p-0.5 text-muted-foreground opacity-0 shadow-sm transition-opacity hover:text-destructive group-hover:opacity-100"
                  title={t("chat.removeImage")}
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>
        )}
        {imageError && (
          <p className="mb-1 px-1 text-xs text-destructive">{imageError}</p>
        )}
        {images.length > 0 && !imageError && (
          <p className="mb-1 px-1 text-xs text-muted-foreground">
            {t("chat.imageVisionHint")}
          </p>
        )}
        <textarea
          ref={textareaRef}
          value={value}
          dir="auto"
          onChange={handleInput}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder={placeholder ?? "Type a message... (Enter to send, Shift+Enter for newline)"}
          disabled={isStreaming}
          rows={1}
          className="block w-full resize-none border-0 bg-transparent px-2 py-2 text-sm leading-6 placeholder:text-muted-foreground focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
          style={{ maxHeight: "120px", overflowY: "auto" }}
        />
        <input
          ref={fileInputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          multiple
          className="hidden"
          onChange={handleFilePick}
        />
        <div className="mt-1 flex items-center justify-between gap-3 border-t border-border/50 pt-2">
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            <span
              className="inline-flex"
              title={!imageInputAvailable ? t("chat.imageInputUnavailable") : t("chat.attachImage")}
            >
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={isStreaming || !imageInputAvailable || images.length >= MAX_IMAGES_PER_MESSAGE}
                className={searchToggleClass(false)}
              >
                <ImagePlus className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">{t("chat.attachImage")}</span>
              </button>
            </span>
            <button
              type="button"
              aria-pressed={useWebSearch}
              onClick={() => onUseWebSearchChange(!useWebSearch)}
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
                    onClick={() => onUseAnyTxtSearchChange(!useAnyTxtSearch)}
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
              disabled={!value.trim() && images.length === 0}
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

import { useEffect, useMemo, useRef, useState, useCallback } from "react"
import { BrainCircuit, ChevronDown, FileSearch, FileText, Globe2, ImagePlus, Send, Sparkles, Square, X } from "lucide-react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { isImeComposing } from "@/lib/keyboard-utils"
import type { MessageImage } from "@/stores/chat-store"
import type { ChatAgentMode, ChatRetrievalMode } from "@/lib/chat-agent-types"
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
  agentMode: ChatAgentMode
  retrievalMode: ChatRetrievalMode
  skills: string[]
  contextFiles: string[]
  skillMode?: "auto" | "explicit"
  approvedShellCommands?: string[]
  shellCommand?: string
}

const AGENT_MODE_OPTIONS: ChatAgentMode[] = ["fast", "standard", "deep", "local_first"]
const RETRIEVAL_MODE_OPTIONS: ChatRetrievalMode[] = ["standard", "smart", "faithful"]

export interface ChatSkillOption {
  id: string
  name: string
  description?: string
  source: string
}

interface SlashSkillTrigger {
  start: number
  end: number
  query: string
}

interface SlashSkillTokenEdit {
  value: string
  cursor: number
}

export type SkillChipDeleteTarget = "first" | "last" | null

export function findSlashSkillTrigger(value: string, cursor: number): SlashSkillTrigger | null {
  if (cursor < 0 || cursor > value.length) return null
  const prefix = value.slice(0, cursor)
  const match = /(^|\s)\/([^\s/]*)$/.exec(prefix)
  if (!match) return null
  const query = match[2] ?? ""
  const suffix = value.slice(cursor)
  const suffixEnd = suffix.search(/\s/)
  return {
    start: cursor - query.length - 1,
    end: suffixEnd === -1 ? value.length : cursor + suffixEnd,
    query,
  }
}

export function findContextFileTrigger(value: string, cursor: number): SlashSkillTrigger | null {
  if (cursor < 0 || cursor > value.length) return null
  const prefix = value.slice(0, cursor)
  const match = /(^|\s)@([^\s@]*)$/.exec(prefix)
  if (!match) return null
  const query = match[2] ?? ""
  const suffix = value.slice(cursor)
  const suffixEnd = suffix.search(/\s/)
  return {
    start: cursor - query.length - 1,
    end: suffixEnd === -1 ? value.length : cursor + suffixEnd,
    query,
  }
}

export function filterSlashSkillOptions(
  skills: ChatSkillOption[],
  query: string,
  sourceLabel: (source: string) => string,
  limit = Number.POSITIVE_INFINITY,
): ChatSkillOption[] {
  const normalized = query.trim().toLowerCase()
  return skills
    .filter((skill) => {
      if (!normalized) return true
      return [
        skill.name,
        skill.id,
        skill.description ?? "",
        sourceLabel(skill.source),
      ].some((part) => part.toLowerCase().includes(normalized))
    })
    .slice(0, limit)
}

export function removeSlashSkillToken(value: string, trigger: SlashSkillTrigger): SlashSkillTokenEdit {
  const before = value.slice(0, trigger.start)
  const after = value.slice(trigger.end)
  const needsSpacer = before.length > 0 && after.length > 0 && !/\s$/.test(before) && !/^\s/.test(after)
  return {
    value: `${before}${needsSpacer ? " " : ""}${after}`,
    cursor: before.length + (needsSpacer ? 1 : 0),
  }
}

function slashSkillTokenKey(value: string, trigger: SlashSkillTrigger | null): string | null {
  if (!trigger) return null
  const token = value.slice(trigger.start, trigger.end)
  return `${trigger.start}:${token}`
}

export function skillChipDeleteTarget(
  key: string,
  value: string,
  selectionStart: number,
  selectionEnd: number,
  selectedSkillCount: number,
): SkillChipDeleteTarget {
  if (selectedSkillCount === 0 || selectionStart !== 0 || selectionEnd !== 0) return null
  if (key === "Backspace") return "last"
  if (key === "Delete" && value.length === 0) return "first"
  return null
}

interface ChatInputProps {
  onSend: (text: string, images: MessageImage[], options: ChatSendOptions) => void
  onStop: () => void
  isStreaming: boolean
  useWebSearch: boolean
  useAnyTxtSearch: boolean
  agentMode: ChatAgentMode
  retrievalMode: ChatRetrievalMode
  availableSkills: ChatSkillOption[]
  selectedSkills: string[]
  availableContextFiles: string[]
  selectedContextFiles: string[]
  onUseWebSearchChange: (enabled: boolean) => void
  onUseAnyTxtSearchChange: (enabled: boolean) => void
  onAgentModeChange: (mode: ChatAgentMode) => void
  onRetrievalModeChange: (mode: ChatRetrievalMode) => void
  onSelectedSkillsChange: (skills: string[]) => void
  onSelectedContextFilesChange: (paths: string[]) => void
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
  agentMode,
  retrievalMode,
  availableSkills,
  selectedSkills,
  availableContextFiles,
  selectedContextFiles,
  onUseWebSearchChange,
  onUseAnyTxtSearchChange,
  onAgentModeChange,
  onRetrievalModeChange,
  onSelectedSkillsChange,
  onSelectedContextFilesChange,
  anyTxtAvailable = true,
  imageInputAvailable = true,
  placeholder,
}: ChatInputProps) {
  const { t } = useTranslation()
  const [value, setValue] = useState("")
  const [images, setImages] = useState<MessageImage[]>([])
  const [imageError, setImageError] = useState<string | null>(null)
  const [showSkills, setShowSkills] = useState(false)
  const [cursorPosition, setCursorPosition] = useState(0)
  const [slashSkillIndex, setSlashSkillIndex] = useState(0)
  const [dismissedSlashKey, setDismissedSlashKey] = useState<string | null>(null)
  const [contextFileIndex, setContextFileIndex] = useState(0)
  const [dismissedContextKey, setDismissedContextKey] = useState<string | null>(null)
  const inputFrameRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const skillSourceLabel = useCallback(
    (source: string) => t(`chat.skillSources.${source}`, { defaultValue: source }),
    [t],
  )

  const slashSkillTrigger = useMemo(
    () => findSlashSkillTrigger(value, cursorPosition),
    [cursorPosition, value],
  )
  const slashSkillOptions = useMemo(() => {
    if (!slashSkillTrigger) return []
    return filterSlashSkillOptions(availableSkills, slashSkillTrigger.query, skillSourceLabel)
  }, [availableSkills, skillSourceLabel, slashSkillTrigger])
  const selectedSkillOptions = useMemo(() => {
    const byId = new Map(availableSkills.map((skill) => [skill.id, skill]))
    return selectedSkills.map((id) => byId.get(id) ?? {
      id,
      name: id,
      source: "custom",
    })
  }, [availableSkills, selectedSkills])
  const slashSkillKey = slashSkillTokenKey(value, slashSkillTrigger)
  const showSlashSkills =
    !!slashSkillTrigger
    && slashSkillKey !== dismissedSlashKey
    && slashSkillOptions.length > 0
    && !isStreaming
  const contextFileTrigger = useMemo(
    () => findContextFileTrigger(value, cursorPosition),
    [cursorPosition, value],
  )
  const contextFileKey = slashSkillTokenKey(value, contextFileTrigger)
  const contextFileOptions = useMemo(() => {
    if (!contextFileTrigger) return []
    const query = contextFileTrigger.query.toLowerCase()
    return availableContextFiles
      .filter((path) => !selectedContextFiles.includes(path))
      .filter((path) => !query || path.toLowerCase().includes(query))
      .slice(0, 50)
  }, [availableContextFiles, contextFileTrigger, selectedContextFiles])
  const showContextFiles = Boolean(
    contextFileTrigger
    && contextFileKey !== dismissedContextKey
    && contextFileOptions.length > 0
    && !isStreaming
  )

  useEffect(() => {
    if (!anyTxtAvailable && useAnyTxtSearch) onUseAnyTxtSearchChange(false)
  }, [anyTxtAvailable, onUseAnyTxtSearchChange, useAnyTxtSearch])

  useEffect(() => {
    setSlashSkillIndex(0)
    setDismissedSlashKey(null)
  }, [slashSkillKey])

  useEffect(() => {
    setContextFileIndex(0)
    setDismissedContextKey(null)
  }, [contextFileKey])

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const frame = inputFrameRef.current
      if (!frame || frame.contains(event.target as Node)) return
      setShowSkills(false)
      if (slashSkillKey) setDismissedSlashKey(slashSkillKey)
      if (contextFileKey) setDismissedContextKey(contextFileKey)
    }
    document.addEventListener("pointerdown", onPointerDown)
    return () => document.removeEventListener("pointerdown", onPointerDown)
  }, [contextFileKey, slashSkillKey])

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

  const removeSelectedSkill = useCallback(
    (id: string) => {
      onSelectedSkillsChange(selectedSkills.filter((item) => item !== id))
      requestAnimationFrame(() => textareaRef.current?.focus())
    },
    [onSelectedSkillsChange, selectedSkills],
  )

  const handleInput = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setValue(e.target.value)
    setCursorPosition(e.target.selectionStart ?? e.target.value.length)
    const ta = e.target
    ta.style.height = "auto"
    ta.style.height = `${Math.min(ta.scrollHeight, 120)}px`
  }, [])

  const handleSelect = useCallback((e: React.SyntheticEvent<HTMLTextAreaElement>) => {
    const target = e.currentTarget
    setCursorPosition(target.selectionStart ?? target.value.length)
  }, [])

  const handleSend = useCallback(() => {
    const trimmed = value.trim()
    // Allow image-only messages: send if there's text OR at least one image.
    if ((!trimmed && images.length === 0) || isStreaming) return
    if (images.length > 0 && !imageInputAvailable) {
      setImageError(t("chat.imageInputUnavailable"))
      return
    }
    onSend(trimmed, images, {
      useWebSearch,
      useAnyTxtSearch,
      agentMode,
      retrievalMode,
      skills: selectedSkills,
      contextFiles: selectedContextFiles,
      skillMode: selectedSkills.length > 0 ? "explicit" : "auto",
    })
    setValue("")
    setImages([])
    setImageError(null)
    setShowSkills(false)
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto"
    }
  }, [agentMode, imageInputAvailable, images, isStreaming, onSend, retrievalMode, selectedContextFiles, selectedSkills, t, useAnyTxtSearch, useWebSearch, value])

  const applySlashSkill = useCallback(
    (skill: ChatSkillOption) => {
      const trigger = slashSkillTrigger
      if (!trigger) return
      const edit = removeSlashSkillToken(value, trigger)
      const nextValue = edit.value
      const nextCursor = edit.cursor
      setValue(nextValue)
      setCursorPosition(nextCursor)
      setDismissedSlashKey(null)
      onSelectedSkillsChange(selectedSkills.includes(skill.id) ? selectedSkills : [...selectedSkills, skill.id])
      setShowSkills(false)
      requestAnimationFrame(() => {
        const ta = textareaRef.current
        if (!ta) return
        ta.focus()
        ta.setSelectionRange(nextCursor, nextCursor)
        ta.style.height = "auto"
        ta.style.height = `${Math.min(ta.scrollHeight, 120)}px`
      })
    },
    [onSelectedSkillsChange, selectedSkills, slashSkillTrigger, value],
  )

  const applyContextFile = useCallback((path: string) => {
    const trigger = contextFileTrigger
    if (!trigger) return
    const edit = removeSlashSkillToken(value, trigger)
    setValue(edit.value)
    setCursorPosition(edit.cursor)
    setDismissedContextKey(null)
    onSelectedContextFilesChange([...selectedContextFiles, path])
    requestAnimationFrame(() => {
      const textarea = textareaRef.current
      if (!textarea) return
      textarea.focus()
      textarea.setSelectionRange(edit.cursor, edit.cursor)
    })
  }, [contextFileTrigger, onSelectedContextFilesChange, selectedContextFiles, value])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // Don't submit on the Enter that commits an IME candidate —
      // the user is mid-composition (Chinese / Japanese / Korean
      // input method picking an English word or phrase) and would
      // see the message fire before they finished typing.
      if (isImeComposing(e)) return
      const target = e.currentTarget
      const selectionStart = target.selectionStart ?? 0
      const selectionEnd = target.selectionEnd ?? selectionStart
      const chipDeleteTarget = !showSlashSkills
        ? skillChipDeleteTarget(e.key, value, selectionStart, selectionEnd, selectedSkills.length)
        : null
      if (chipDeleteTarget) {
        e.preventDefault()
        e.stopPropagation()
        removeSelectedSkill(chipDeleteTarget === "last" ? selectedSkills[selectedSkills.length - 1] : selectedSkills[0])
        return
      }
      if (showContextFiles) {
        if (e.key === "ArrowDown") {
          e.preventDefault()
          setContextFileIndex((index) => Math.min(index + 1, contextFileOptions.length - 1))
          return
        }
        if (e.key === "ArrowUp") {
          e.preventDefault()
          setContextFileIndex((index) => Math.max(index - 1, 0))
          return
        }
        if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
          e.preventDefault()
          const path = contextFileOptions[contextFileIndex] ?? contextFileOptions[0]
          if (path) applyContextFile(path)
          return
        }
        if (e.key === "Escape") {
          e.preventDefault()
          if (contextFileKey) setDismissedContextKey(contextFileKey)
          return
        }
      }
      if (showSlashSkills) {
        if (e.key === "Enter" && e.shiftKey) {
          return
        }
        if (e.key === "ArrowDown") {
          e.preventDefault()
          e.stopPropagation()
          setSlashSkillIndex((idx) => Math.min(idx + 1, slashSkillOptions.length - 1))
          return
        }
        if (e.key === "ArrowUp") {
          e.preventDefault()
          e.stopPropagation()
          setSlashSkillIndex((idx) => Math.max(idx - 1, 0))
          return
        }
        if (e.key === "Tab" || e.key === "Enter") {
          e.preventDefault()
          e.stopPropagation()
          const skill = slashSkillOptions[slashSkillIndex] ?? slashSkillOptions[0]
          if (skill) applySlashSkill(skill)
          return
        }
        if (e.key === "Escape") {
          e.preventDefault()
          e.stopPropagation()
          if (slashSkillKey) setDismissedSlashKey(slashSkillKey)
          return
        }
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault()
        handleSend()
      }
    },
    [applyContextFile, applySlashSkill, contextFileIndex, contextFileKey, contextFileOptions, handleSend, removeSelectedSkill, selectedSkills, showContextFiles, showSlashSkills, slashSkillIndex, slashSkillKey, slashSkillOptions, value],
  )

  const searchToggleClass = (active: boolean) =>
    `inline-flex h-7 items-center gap-1.5 rounded-md border px-2.5 text-xs font-medium transition-colors ${
      active
        ? "border-border bg-accent text-foreground shadow-sm"
        : "border-transparent bg-transparent text-muted-foreground hover:bg-accent/60 hover:text-foreground"
    } disabled:pointer-events-none disabled:opacity-50`

  const agentModeLabel = (mode: ChatAgentMode) => {
    switch (mode) {
      case "fast":
        return t("chat.agentModes.fast")
      case "deep":
        return t("chat.agentModes.deep")
      case "local_first":
        return t("chat.agentModes.localFirst")
      case "standard":
      default:
        return t("chat.agentModes.standard")
    }
  }

  const toggleSkill = (id: string) => {
    if (selectedSkills.includes(id)) {
      onSelectedSkillsChange(selectedSkills.filter((item) => item !== id))
    } else {
      onSelectedSkillsChange([...selectedSkills, id])
    }
  }

  return (
    <div className="border-t bg-background/95 p-3">
      <div ref={inputFrameRef} className="relative rounded-lg border border-border/80 bg-card/80 p-2 shadow-sm ring-1 ring-black/5 focus-within:border-ring/60 focus-within:ring-ring/20 dark:ring-white/5">
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
        <div className="flex flex-wrap items-start gap-1 px-1">
          {selectedContextFiles.map((path) => (
            <span
              key={path}
              className="group mt-1 inline-flex h-7 max-w-[18rem] items-center gap-1.5 rounded-md border border-blue-500/25 bg-blue-500/10 px-2 text-xs font-medium text-blue-700 dark:text-blue-300"
              title={path}
            >
              <FileText className="h-3 w-3 shrink-0" />
              <span className="truncate">{path.split("/").pop() ?? path}</span>
              <button
                type="button"
                onClick={() => onSelectedContextFilesChange(selectedContextFiles.filter((item) => item !== path))}
                className="rounded p-0.5 opacity-70 hover:bg-blue-500/15 group-hover:opacity-100"
                title={t("chat.removeContextFile", { name: path })}
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
          {selectedSkillOptions.map((skill) => (
            <span
              key={skill.id}
              className="group mt-1 inline-flex h-7 max-w-[16rem] items-center gap-1.5 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2 text-xs font-medium text-emerald-700 shadow-sm dark:text-emerald-300"
              title={`${skill.name} · ${skillSourceLabel(skill.source)}`}
            >
              <Sparkles className="h-3 w-3 shrink-0 text-emerald-500" />
              <span className="truncate">/{skill.name}</span>
              <button
                type="button"
                onClick={() => removeSelectedSkill(skill.id)}
                className="rounded p-0.5 text-emerald-700/60 opacity-70 transition hover:bg-emerald-500/15 hover:text-emerald-700 group-hover:opacity-100 dark:text-emerald-300/70 dark:hover:text-emerald-300"
                title={t("chat.removeSkill", { name: skill.name })}
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
          <textarea
            ref={textareaRef}
            value={value}
            dir="auto"
            onChange={handleInput}
            onSelect={handleSelect}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            placeholder={placeholder ?? "Type a message... (Enter to send, Shift+Enter for newline)"}
            disabled={isStreaming}
            rows={1}
            className="min-w-[12rem] flex-1 resize-none border-0 bg-transparent px-1 py-2 text-sm leading-6 placeholder:text-muted-foreground focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
            style={{ maxHeight: "120px", overflowY: "auto" }}
          />
        </div>
        {showSlashSkills && (
          <div className="absolute bottom-[4.75rem] left-4 right-4 z-30 max-w-xl rounded-md border border-border bg-popover p-1.5 text-popover-foreground shadow-lg">
            <div className="px-2 pb-1 text-[11px] font-medium text-muted-foreground">
              {t("chat.slashSkillHint")}
            </div>
            <div className="max-h-64 overflow-y-auto">
              {slashSkillOptions.map((skill, index) => {
                const active = index === slashSkillIndex
                const selected = selectedSkills.includes(skill.id)
                return (
                  <button
                    key={`${skill.source}:${skill.id}`}
                    type="button"
                    onMouseDown={(event) => {
                      event.preventDefault()
                      applySlashSkill(skill)
                    }}
                    className={`flex w-full items-start gap-2 rounded px-2 py-1.5 text-left text-xs transition-colors ${
                      active ? "bg-accent text-foreground" : "hover:bg-accent/60"
                    }`}
                  >
                    <Sparkles className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${selected ? "text-emerald-500" : "text-muted-foreground"}`} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">{skill.name}</span>
                      <span className="block truncate text-muted-foreground">
                        {skill.description || skillSourceLabel(skill.source)}
                      </span>
                    </span>
                    <span className="shrink-0 text-[10px] uppercase text-muted-foreground">
                      {skillSourceLabel(skill.source)}
                    </span>
                  </button>
                )
              })}
            </div>
          </div>
        )}
        {showContextFiles && (
          <div className="absolute bottom-[4.75rem] left-4 right-4 z-30 max-w-xl rounded-md border border-border bg-popover p-1.5 text-popover-foreground shadow-lg">
            <div className="px-2 pb-1 text-[11px] font-medium text-muted-foreground">
              {t("chat.contextFileHint")}
            </div>
            <div className="max-h-64 overflow-y-auto">
              {contextFileOptions.map((path, index) => (
                <button
                  key={path}
                  type="button"
                  onMouseDown={(event) => {
                    event.preventDefault()
                    applyContextFile(path)
                  }}
                  className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs ${index === contextFileIndex ? "bg-accent" : "hover:bg-accent/60"}`}
                >
                  <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate">{path}</span>
                </button>
              ))}
            </div>
          </div>
        )}
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
            <div className="relative">
              <button
                type="button"
                aria-expanded={showSkills}
                onClick={() => setShowSkills((open) => !open)}
                disabled={isStreaming || availableSkills.length === 0}
                className={searchToggleClass(selectedSkills.length > 0)}
                title={availableSkills.length === 0 ? t("chat.noSkillsAvailable") : t("chat.skills")}
              >
                <Sparkles className="h-3.5 w-3.5" />
                {t("chat.skills")}
                {selectedSkills.length > 0 && (
                  <span className="ml-0.5 rounded bg-emerald-500/15 px-1 text-[10px] font-semibold text-emerald-600 dark:text-emerald-400">
                    {selectedSkills.length}
                  </span>
                )}
              </button>
              {showSkills && availableSkills.length > 0 && (
                <div className="absolute bottom-full left-0 z-20 mb-2 w-72 rounded-md border border-border bg-popover p-2 text-popover-foreground shadow-lg">
                  <div className="mb-1 px-1 text-xs font-medium text-muted-foreground">
                    {t("chat.enabledSkills")}
                    {selectedSkills.length === 0 && (
                      <span className="ml-1 font-normal text-muted-foreground">
                        {t("chat.skillsAutoMode", { defaultValue: "Auto" })}
                      </span>
                    )}
                  </div>
                  <div className="max-h-56 overflow-y-auto">
                    {availableSkills.map((skill) => {
                      const active = selectedSkills.includes(skill.id)
                      return (
                        <button
                          key={`${skill.source}:${skill.id}`}
                          type="button"
                          onClick={() => toggleSkill(skill.id)}
                          className={`mb-1 flex w-full items-start gap-2 rounded px-2 py-1.5 text-left text-xs transition-colors ${
                            active ? "bg-accent text-foreground" : "hover:bg-accent/60"
                          }`}
                        >
                          <span
                            className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${
                              active ? "bg-emerald-500" : "bg-muted-foreground/30"
                            }`}
                          />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate font-medium">{skill.name}</span>
                            <span className="block truncate text-muted-foreground">
                              {skill.description || skillSourceLabel(skill.source)}
                            </span>
                          </span>
                          <span className="shrink-0 text-[10px] uppercase text-muted-foreground">
                            {skillSourceLabel(skill.source)}
                          </span>
                        </button>
                      )
                    })}
                  </div>
                </div>
              )}
            </div>
            <label
              className="relative inline-flex h-7 items-center rounded-md border border-border/70 bg-muted/30 text-xs font-medium text-foreground transition-colors hover:bg-accent/60 focus-within:border-ring/60 focus-within:ring-1 focus-within:ring-ring/30"
              title={t("chat.retrievalModeHint")}
            >
              <BrainCircuit className="ml-2 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <select
                value={retrievalMode}
                onChange={(event) => onRetrievalModeChange(event.target.value as ChatRetrievalMode)}
                disabled={isStreaming}
                aria-label={t("chat.retrievalMode")}
                className="h-full max-w-36 appearance-none bg-transparent py-0 pl-1.5 pr-7 text-xs font-medium outline-none disabled:pointer-events-none disabled:opacity-50"
              >
                {RETRIEVAL_MODE_OPTIONS.map((retrieval) => (
                  <option key={retrieval} value={retrieval}>
                    {t(`chat.retrievalModes.${retrieval}`)}
                  </option>
                ))}
              </select>
              <ChevronDown className="pointer-events-none absolute right-1.5 h-3.5 w-3.5 text-muted-foreground" />
            </label>
            <label
              className="relative inline-flex h-7 items-center rounded-md border border-border/70 bg-muted/30 text-xs font-medium text-foreground transition-colors hover:bg-accent/60 focus-within:border-ring/60 focus-within:ring-1 focus-within:ring-ring/30"
              title={t("chat.agentMode")}
            >
              <select
                value={agentMode}
                onChange={(event) => onAgentModeChange(event.target.value as ChatAgentMode)}
                disabled={isStreaming}
                aria-label={t("chat.agentMode")}
                className="h-full max-w-28 appearance-none bg-transparent py-0 pl-2 pr-7 text-xs font-medium outline-none disabled:pointer-events-none disabled:opacity-50"
              >
                {AGENT_MODE_OPTIONS.map((mode) => (
                  <option key={mode} value={mode}>
                    {agentModeLabel(mode)}
                  </option>
                ))}
              </select>
              <ChevronDown className="pointer-events-none absolute right-1.5 h-3.5 w-3.5 text-muted-foreground" />
            </label>
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

import { useRef, useEffect, useCallback, useState } from "react"
import { useTranslation } from "react-i18next"
import { convertFileSrc, invoke } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"
import { BookOpen, Plus, Trash2, MessageSquare, X, Maximize2, FolderOpen, FileText } from "lucide-react"
import { Button } from "@/components/ui/button"
import { ChatMessage, StreamingMessage, useSourceFiles, type ChatReferencePreview } from "./chat-message"
import { ChatInput, type ChatSendOptions } from "./chat-input"
import { useChatStore, chatMessagesToLLM, type MessageImage, type MessageReference } from "@/stores/chat-store"
import { useWikiStore } from "@/stores/wiki-store"
import { isReasoningOnlyResponseError, streamChat } from "@/lib/llm-client"
import { supportsImageInput } from "@/lib/llm-providers"
import { executeIngestWrites } from "@/lib/ingest"
import { deleteFile, openPathInProject, readFile } from "@/commands/fs"
import { getFileName, isAbsolutePath, normalizePath } from "@/lib/path-utils"
import { hasConfiguredAnyTxt } from "@/lib/anytxt-search"
import type { ChatAgentEvent, ChatAgentStep, ChatUserInputRequest } from "@/lib/chat-agent-types"
import type { ChatMessage as LlmChatMessage, ContentBlock } from "@/lib/llm-client"
import { FilePreview } from "@/components/editor/file-preview"
import { WikiReader } from "@/components/editor/wiki-reader"
import { FrontmatterPanel } from "@/components/editor/frontmatter-panel"
import { parseFrontmatter } from "@/lib/frontmatter"
import { getFileCategory, getFileExtension, isTextReadable } from "@/lib/file-types"
import { refreshProjectFileTree } from "@/lib/project-file-tree-refresh"

type InternalChatSendOptions = ChatSendOptions & {
  suppressUserMessage?: boolean
  historyOverride?: { role: "user" | "assistant"; content: string }[]
}

interface BackendAgentReference {
  title: string
  path: string
  kind: string
  snippet?: string
  score?: number
}

interface BackendAgentToolEvent {
  tool: string
  status: string
  detail?: string
}

interface BackendAgentEventPayload {
  sessionId: string
  runId?: string
  event: {
    type: string
    text?: string
    tool?: string
    input?: string
    output?: string
    message?: string
    reference?: BackendAgentReference
    request?: ChatUserInputRequest
    sessionId?: string
  }
}

interface BackendAgentResponse {
  sessionId: string
  mode?: string
  message: string | { role?: string; content?: string }
  references?: BackendAgentReference[]
  toolEvents?: BackendAgentToolEvent[]
  userInputRequest?: ChatUserInputRequest
}

interface AvailableAgentSkill {
  id: string
  name: string
  description?: string
  source: string
}

// Store the page mapping from the last query so SourceFilesBar can show which pages were cited
export let lastQueryPages: { title: string; path: string }[] = []

const AGENT_STREAM_IDLE_TIMEOUT_MS = 8 * 60 * 1000
const AGENT_SKILL_STREAM_IDLE_TIMEOUT_MS = 15 * 60 * 1000

function parentDirectory(path: string): string {
  const normalized = normalizePath(path).replace(/\/+$/g, "")
  const idx = normalized.lastIndexOf("/")
  if (idx <= 0) return normalized
  return normalized.slice(0, idx)
}

function commonDirectory(paths: string[]): string | null {
  const directories = paths
    .map(parentDirectory)
    .filter((dir) => dir.trim().length > 0)
  if (directories.length === 0) return null
  const firstParts = directories[0].split("/")
  let commonLength = firstParts.length
  for (const dir of directories.slice(1)) {
    const parts = dir.split("/")
    commonLength = Math.min(commonLength, parts.length)
    for (let i = 0; i < commonLength; i += 1) {
      if (firstParts[i] !== parts[i]) {
        commonLength = i
        break
      }
    }
  }
  return firstParts.slice(0, commonLength).join("/") || null
}

function agentStreamIdleTimeoutMs(options: ChatSendOptions, skillCount: number): number {
  return skillCount > 0 || options.agentMode === "deep"
    ? AGENT_SKILL_STREAM_IDLE_TIMEOUT_MS
    : AGENT_STREAM_IDLE_TIMEOUT_MS
}

function formatDate(timestamp: number): string {
  const d = new Date(timestamp)
  const now = new Date()
  const isToday = d.toDateString() === now.toDateString()
  if (isToday) {
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
  }
  return d.toLocaleDateString([], { month: "short", day: "numeric" })
}

function ConversationSidebar({
  onNewConversation,
  onSelectConversation,
}: {
  onNewConversation?: () => void
  onSelectConversation?: (id: string) => void
}) {
  const { t } = useTranslation()
  const conversations = useChatStore((s) => s.conversations)
  const activeConversationId = useChatStore((s) => s.activeConversationId)
  const messages = useChatStore((s) => s.messages)
  const createConversation = useChatStore((s) => s.createConversation)
  const deleteConversation = useChatStore((s) => s.deleteConversation)
  const setActiveConversation = useChatStore((s) => s.setActiveConversation)

  const [hoveredId, setHoveredId] = useState<string | null>(null)

  const sorted = [...conversations].sort((a, b) => b.updatedAt - a.updatedAt)

  function getMessageCount(convId: string): number {
    return messages.filter((m) => m.conversationId === convId).length
  }

  return (
    <div className="flex h-full w-[200px] flex-shrink-0 flex-col border-r bg-muted/30">
      <div className="border-b p-2">
        <Button
          variant="outline"
          size="sm"
          className="w-full gap-2"
          onClick={() => {
            if (onNewConversation) {
              onNewConversation()
            } else {
              createConversation()
            }
          }}
        >
          <Plus className="h-3.5 w-3.5" />
          {t("chat.newChat")}
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto py-1">
        {sorted.length === 0 ? (
          <p className="px-3 py-4 text-xs text-muted-foreground text-center">
            {t("chat.noConversationsYet")}
          </p>
        ) : (
          sorted.map((conv) => {
            const isActive = conv.id === activeConversationId
            const msgCount = getMessageCount(conv.id)
            return (
              <div
                key={conv.id}
                className={`group relative mx-1 my-0.5 flex cursor-pointer flex-col rounded-md px-2 py-1.5 text-sm transition-colors ${
                  isActive
                    ? "bg-primary/10 text-primary"
                    : "hover:bg-accent text-foreground"
                }`}
                onClick={() => {
                  if (onSelectConversation) {
                    onSelectConversation(conv.id)
                  } else {
                    setActiveConversation(conv.id)
                  }
                }}
                onMouseEnter={() => setHoveredId(conv.id)}
                onMouseLeave={() => setHoveredId(null)}
              >
                <div className="flex items-start justify-between gap-1">
                  <span className="line-clamp-2 flex-1 text-xs font-medium leading-snug">
                    {conv.title}
                  </span>
                  {hoveredId === conv.id && (
                    <button
                      className="flex-shrink-0 rounded p-0.5 text-muted-foreground hover:text-destructive"
                      onClick={(e) => {
                        e.stopPropagation()
                        deleteConversation(conv.id)
                        // Delete persisted chat file
                        const proj = useWikiStore.getState().project
                        if (proj) {
                          deleteFile(`${proj.path}/.llm-wiki/chats/${conv.id}.json`).catch(() => {})
                        }
                      }}
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  )}
                </div>
                <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-muted-foreground">
                  <span>{formatDate(conv.updatedAt)}</span>
                  {msgCount > 0 && (
                    <>
                      <span>·</span>
                      <span>{msgCount} {t("chat.msgCount")}</span>
                    </>
                  )}
                </div>
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}

function backendReferenceToMessageReference(ref: BackendAgentReference): MessageReference {
  const isWiki = ref.kind === "wiki" || ref.path.startsWith("wiki/")
  const isWeb = ref.kind === "web" || /^https?:\/\//i.test(ref.path)
  const isWorkspace = ref.kind === "workspace" || ref.path.startsWith("agent-workspace/")
  const source =
    isWorkspace ? "Workspace"
      : ref.kind === "anytxt" ? "AnyTXT"
      : ref.kind === "web" ? "Web"
        : ref.kind === "source" ? "Source"
          : ref.kind === "graph" ? "Graph"
            : undefined
  return {
    title: ref.title,
    path: ref.path,
    kind: isWiki ? "wiki" : isWorkspace ? "workspace" : "external",
    source,
    url: isWeb ? ref.path : undefined,
    snippet: ref.snippet,
  }
}

function projectAbsolutePath(projectPath: string, path: string): string {
  const pp = normalizePath(projectPath)
  const normalized = normalizePath(path)
  if (normalized.startsWith(`${pp}/`)) return normalized
  if (isAbsolutePath(normalized)) return normalized
  return `${pp}/${normalized.replace(/^\/+/, "")}`
}

function isAgentWorkspacePath(filePath: string): boolean {
  return normalizePath(filePath).split("/").includes("agent-workspace")
}

function isGeneratedOutputImage(filePath: string): boolean {
  const category = getFileCategory(filePath)
  return category === "image" || (getFileExtension(filePath) === "svg" && isAgentWorkspacePath(filePath))
}

function backendToolToAgentStep(event: BackendAgentToolEvent, index: number) {
  if (event.tool === "agent.plan_tools") {
    return {
      id: `backend-${index}-${event.tool}-${event.status}`,
      type: "routing" as const,
      message: event.detail ?? event.tool,
      status: event.status === "failed" ? "error" as const : "success" as const,
    }
  }
  if (event.tool === "llm.generate") {
    return {
      id: `backend-${index}-${event.tool}-${event.status}`,
      type: "final" as const,
      message: event.detail ?? event.tool,
      status: event.status === "failed" ? "error" as const
        : event.status === "started" ? "running" as const
          : "success" as const,
    }
  }
  const tool = normalizeBackendToolName(event.tool)
  return {
    id: `backend-${index}-${event.tool}-${event.status}`,
    type: event.status === "started" ? "tool_call" as const : "tool_result" as const,
    tool,
    message: event.detail ?? event.tool,
    status: event.status === "failed" ? "error" as const
      : event.status === "available" ? "skipped" as const
        : event.status === "started" ? "running" as const
          : "success" as const,
  }
}

function normalizeBackendToolName(tool: string) {
  const normalized = tool.split(".").join("_")
  if (normalized === "wiki_search") return "wiki_search" as const
  if (normalized === "wiki_read_page") return "project_file_read" as const
  if (normalized === "wiki_write_page") return "project_files" as const
  if (normalized === "workspace_write_file") return "project_files" as const
  if (normalized === "workspace_append_file") return "project_files" as const
  if (normalized === "skills_load") return "project_file_read" as const
  if (normalized === "skill_read_file") return "project_file_read" as const
  if (normalized === "source_search") return "project_file_read" as const
  if (normalized === "graph_search") return "graph_search" as const
  if (normalized === "web_search") return "web_search" as const
  if (normalized === "anytxt_search") return "anytxt_search" as const
  if (normalized === "shell_exec") return "shell_exec" as const
  if (normalized === "deep_research_run") return "project_file_read" as const
  return "unknown_tool" as const
}

function backendToolToAgentEvent(event: BackendAgentToolEvent): ChatAgentEvent {
  if (event.tool === "agent.plan_tools") {
    return {
      stage: "routing",
      message: event.detail ?? event.tool,
      status: event.status === "failed" ? "error" : "success",
    }
  }
  if (event.tool === "llm.generate") {
    return {
      stage: "writing",
      message: event.detail ?? event.tool,
      status: event.status === "failed" ? "error"
        : event.status === "started" ? "running"
          : "success",
    }
  }
  const tool = normalizeBackendToolName(event.tool)
  const stage =
    tool === "web_search" ? "searching_web"
      : tool === "anytxt_search" ? "searching_anytxt"
        : tool === "graph_search" ? "searching_graph"
          : tool === "project_file_read" ? "reading_context"
            : tool === "wiki_search" ? "searching_wiki"
              : event.status === "started" ? "tool_call"
                : "tool_result"
  return {
    stage,
    tool,
    message: event.detail ?? event.tool,
    status: event.status === "failed" ? "error"
      : event.status === "started" ? "running"
        : event.status === "available" ? "skipped"
          : "success",
  }
}

function backendResponseText(response: BackendAgentResponse): string {
  if (typeof response.message === "string") return response.message
  return response.message?.content ?? ""
}

function enabledSkillIds(skills: AvailableAgentSkill[], disabledSkills: string[]): Set<string> {
  const disabled = new Set(disabledSkills)
  return new Set(skills.filter((skill) => !disabled.has(skill.id)).map((skill) => skill.id))
}

function summarizeAgentStepsForResume(steps: ChatAgentStep[] = []): string {
  const lines = steps
    .filter((step) => step.message?.trim())
    .slice(-12)
    .map((step) => {
      const label = step.tool ?? step.type
      const status = step.status ?? "success"
      return `- ${label} ${status}: ${step.message?.trim()}`
    })
  return lines.length > 0 ? lines.join("\n") : "- No prior tool observations were saved."
}

function compactChatHistoryForResume(
  messages: Array<{ role: "user" | "assistant" | "system"; content: string }>,
  maxMessages: number,
): { role: "user" | "assistant"; content: string }[] {
  return messages
    .filter((message): message is { role: "user" | "assistant"; content: string } =>
      message.role === "user" || message.role === "assistant"
    )
    .slice(-maxMessages)
    .map((message) => ({
      role: message.role,
      content: message.content,
    }))
}

function conversationMessages(conversationId: string) {
  return useChatStore.getState().messages.filter((message) => message.conversationId === conversationId)
}

export function ChatPanel() {
  const { t } = useTranslation()
  useSourceFiles() // Keep source file cache warm
  const activeConversationId = useChatStore((s) => s.activeConversationId)
  const isStreaming = useChatStore((s) => s.isStreaming)
  const streamingContent = useChatStore((s) => s.streamingContent)
  const mode = useChatStore((s) => s.mode)
  const addMessageToConversation = useChatStore((s) => s.addMessageToConversation)
  const setStreaming = useChatStore((s) => s.setStreaming)
  const appendStreamToken = useChatStore((s) => s.appendStreamToken)
  const finalizeStreamForConversation = useChatStore((s) => s.finalizeStreamForConversation)
  const createConversation = useChatStore((s) => s.createConversation)
  const removeLastAssistantMessage = useChatStore((s) => s.removeLastAssistantMessage)
  const maxHistoryMessages = useChatStore((s) => s.maxHistoryMessages)
  const useWebSearch = useChatStore((s) => s.useWebSearch)
  const useAnyTxtSearch = useChatStore((s) => s.useAnyTxtSearch)
  const agentMode = useChatStore((s) => s.agentMode)
  const selectedSkills = useChatStore((s) => s.selectedSkills)
  const disabledSkills = useChatStore((s) => s.disabledSkills)
  const setUseWebSearch = useChatStore((s) => s.setUseWebSearch)
  const setUseAnyTxtSearch = useChatStore((s) => s.setUseAnyTxtSearch)
  const setAgentMode = useChatStore((s) => s.setAgentMode)
  const setSelectedSkills = useChatStore((s) => s.setSelectedSkills)

  // Derive active messages via selector to re-render on message changes
  const allMessages = useChatStore((s) => s.messages)
  const activeMessages = activeConversationId
    ? allMessages.filter((m) => m.conversationId === activeConversationId)
    : []

  const project = useWikiStore((s) => s.project)
  const llmConfig = useWikiStore((s) => s.llmConfig)
  const searchApiConfig = useWikiStore((s) => s.searchApiConfig)
  const anyTxtAvailable = hasConfiguredAnyTxt(searchApiConfig.anyTxt)
  const imageInputAvailable = supportsImageInput(llmConfig)

  const abortRef = useRef<AbortController | null>(null)
  const activeRunSessionIdRef = useRef<string | null>(null)
  const activeRunIdRef = useRef<string | null>(null)
  const runIdRef = useRef(0)
  const dismissedGeneratedOutputsKeyRef = useRef<string | null>(null)
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const [agentEvents, setAgentEvents] = useState<ChatAgentEvent[]>([])
  const [referencePreview, setReferencePreview] = useState<ChatReferencePreview | null>(null)
  const [generatedOutputPreviews, setGeneratedOutputPreviews] = useState<ChatReferencePreview[]>([])
  const [generatedOutputPreview, setGeneratedOutputPreview] = useState<ChatReferencePreview | null>(null)
  const [referencePreviewWidth, setReferencePreviewWidth] = useState(420)
  const [availableSkills, setAvailableSkills] = useState<AvailableAgentSkill[]>([])
  const [approvingShellMessageId, setApprovingShellMessageId] = useState<string | null>(null)
  const [streamingConversationId, setStreamingConversationId] = useState<string | null>(null)
  const buildGeneratedOutputPreview = useCallback(async (ref: MessageReference): Promise<ChatReferencePreview | null> => {
    if (!project) return null
    const outputPath = projectAbsolutePath(project.path, ref.path)
    try {
      const category = getFileCategory(outputPath)
      const shouldReadContent = isTextReadable(category) || category === "pdf"
      const content = shouldReadContent ? await readFile(outputPath) : ""
      return {
        title: ref.title || getFileName(outputPath),
        path: outputPath,
        source: ref.source ?? "Workspace",
        content,
        snippet: ref.snippet,
      }
    } catch (err) {
      console.warn("[chat] failed to auto-open generated output:", err)
      return {
        title: ref.title || getFileName(outputPath),
        path: outputPath,
        source: ref.source ?? "Workspace",
        content: `Unable to load generated file: ${ref.path}`,
        snippet: ref.snippet,
      }
    }
  }, [project])
  const autoOpenSingleGeneratedOutput = useCallback((conversationId: string, references?: MessageReference[]) => {
    if (useChatStore.getState().activeConversationId !== conversationId) return
    const outputs = (references ?? []).filter((ref) => ref.kind === "workspace")
    if (outputs.length === 0 || !project) return
    const previews = outputs.map((ref) => {
      const outputPath = projectAbsolutePath(project.path, ref.path)
      return {
        title: ref.title || getFileName(outputPath),
        path: outputPath,
        source: ref.source ?? "Workspace",
        content: "",
        snippet: ref.snippet,
      }
    })
    setReferencePreview(null)
    setGeneratedOutputPreviews(previews)
    if (outputs.length === 1) {
      void buildGeneratedOutputPreview(outputs[0]).then((preview) => {
        if (preview) {
          setGeneratedOutputPreviews([preview])
          setGeneratedOutputPreview(preview)
        }
      })
    }
  }, [buildGeneratedOutputPreview, project])
  const activeStreaming = Boolean(isStreaming && activeConversationId && streamingConversationId === activeConversationId)
  const activeAgentEvents = activeStreaming ? agentEvents : []
  const lastMessage = activeMessages[activeMessages.length - 1]
  const latestGeneratedOutputMessage = [...activeMessages]
    .reverse()
    .find((message) =>
      message.role === "assistant"
      && (message.references ?? []).some((ref) => ref.kind === "workspace")
    )
  const scrollKey = [
    activeConversationId ?? "",
    activeMessages.length,
    lastMessage?.id ?? "",
    lastMessage?.content.length ?? 0,
    activeStreaming ? streamingContent.length : 0,
  ].join(":")

  // Auto-scroll to bottom when messages change or streaming content updates
  useEffect(() => {
    const container = scrollContainerRef.current
    if (container) {
      container.scrollTop = container.scrollHeight
    }
  }, [scrollKey])

  useEffect(() => {
    setReferencePreview(null)
    setGeneratedOutputPreviews([])
    setGeneratedOutputPreview(null)
    dismissedGeneratedOutputsKeyRef.current = null
  }, [activeConversationId])

  useEffect(() => {
    if (!project || activeStreaming || !latestGeneratedOutputMessage) return
    const outputs = (latestGeneratedOutputMessage.references ?? []).filter((ref) => ref.kind === "workspace")
    if (outputs.length === 0) return
    const previews = outputs.map((ref) => {
      const outputPath = projectAbsolutePath(project.path, ref.path)
      return {
        title: ref.title || getFileName(outputPath),
        path: outputPath,
        source: ref.source ?? "Workspace",
        content: "",
        snippet: ref.snippet,
      }
    })
    const currentKey = generatedOutputPreviews.map((preview) => preview.path).join("\n")
    const nextKey = previews.map((preview) => preview.path).join("\n")
    const scopedNextKey = `${activeConversationId ?? ""}:${nextKey}`
    if (dismissedGeneratedOutputsKeyRef.current === scopedNextKey) return
    if (currentKey === nextKey) return
    setReferencePreview(null)
    setGeneratedOutputPreviews(previews)
  }, [activeConversationId, activeStreaming, generatedOutputPreviews, latestGeneratedOutputMessage, project])

  const loadGeneratedOutputPreview = useCallback(async (preview: ChatReferencePreview): Promise<ChatReferencePreview> => {
    const category = getFileCategory(preview.path)
    const shouldReadContent = isTextReadable(category) || category === "pdf"
    if (!shouldReadContent || preview.content) return preview
    try {
      return {
        ...preview,
        content: await readFile(preview.path),
      }
    } catch {
      return preview
    }
  }, [])

  const openGeneratedOutputModal = useCallback((preview: ChatReferencePreview) => {
    void loadGeneratedOutputPreview(preview).then(setGeneratedOutputPreview)
  }, [loadGeneratedOutputPreview])

  const closeGeneratedOutputsPanel = useCallback(() => {
    const currentKey = generatedOutputPreviews.map((preview) => preview.path).join("\n")
    dismissedGeneratedOutputsKeyRef.current = `${activeConversationId ?? ""}:${currentKey}`
    setGeneratedOutputPreviews([])
    setGeneratedOutputPreview(null)
  }, [activeConversationId, generatedOutputPreviews])

  const openGeneratedOutputDirectory = useCallback(() => {
    if (!project) return
    const directory = commonDirectory(generatedOutputPreviews.map((preview) => preview.path))
    if (!directory) return
    void openPathInProject(project.path, directory).catch((err) => {
      console.error("[chat] failed to open generated output directory:", err)
    })
  }, [generatedOutputPreviews, project])

  const handleOpenReferencePreview = useCallback((preview: ChatReferencePreview, relatedPreviews?: ChatReferencePreview[]) => {
    const isGeneratedOutput = preview.source === "Workspace"
      || normalizePath(preview.path).split("/").includes("agent-workspace")
    if (!isGeneratedOutput) {
      setGeneratedOutputPreviews([])
      setGeneratedOutputPreview(null)
      setReferencePreview(preview)
      return
    }
    const previews = relatedPreviews && relatedPreviews.length > 0
      ? relatedPreviews.map((item) =>
          item.path === preview.path
            ? { ...item, content: preview.content }
            : item
        )
      : [preview]
    setReferencePreview(null)
    setGeneratedOutputPreviews(previews)
    openGeneratedOutputModal(preview)
  }, [openGeneratedOutputModal])

  useEffect(() => {
    let cancelled = false
    if (!project?.path) {
      setAvailableSkills([])
      return
    }
    invoke<AvailableAgentSkill[]>("agent_list_skills", { projectPath: project.path })
      .then((skills) => {
        if (cancelled) return
        const enabled = enabledSkillIds(skills, useChatStore.getState().disabledSkills)
        const enabledSkills = skills.filter((skill) => enabled.has(skill.id))
        setAvailableSkills(enabledSkills)
        const current = useChatStore.getState().selectedSkills
        const filtered = current.filter((name) => enabled.has(name))
        if (filtered.length !== current.length) {
          setSelectedSkills(filtered)
        }
      })
      .catch(() => {
        if (!cancelled) setAvailableSkills([])
      })
    return () => {
      cancelled = true
    }
  }, [project?.path, disabledSkills, setSelectedSkills])

  const handleSend = useCallback(
    async (
      text: string,
      images: MessageImage[] = [],
      options?: InternalChatSendOptions,
    ) => {
      const sendOptions = options ?? {
        useWebSearch: useChatStore.getState().useWebSearch,
        useAnyTxtSearch: useChatStore.getState().useAnyTxtSearch,
        agentMode: useChatStore.getState().agentMode,
        skills: useChatStore.getState().selectedSkills,
        skillMode: useChatStore.getState().selectedSkills.length > 0 ? "explicit" : "auto",
      }
      const allowedSkills = enabledSkillIds(
        availableSkills,
        useChatStore.getState().disabledSkills,
      )
      const requestedSkillMode = sendOptions.skillMode ?? (
        sendOptions.skills.length > 0 ? "explicit" : "auto"
      )
      const requestSkills = requestedSkillMode === "auto" && sendOptions.skills.length === 0
        ? Array.from(allowedSkills)
        : sendOptions.skills.filter((id) => allowedSkills.has(id))
      // Auto-create a conversation if none is active
      let convId = useChatStore.getState().activeConversationId
      if (!convId) {
        convId = createConversation()
      }

      if (!sendOptions.suppressUserMessage) {
        addMessageToConversation(convId, "user", text, images)
      }
      setStreamingConversationId(convId)
      setStreaming(true)
      setAgentEvents([])
      let finalized = false
      const runId = ++runIdRef.current
      const backendRunId = `ui-${Date.now()}-${runId}`

      try {
        const controller = new AbortController()
        abortRef.current = controller
        activeRunSessionIdRef.current = convId
        activeRunIdRef.current = backendRunId
        const isCurrentRun = () => runIdRef.current === runId && !controller.signal.aborted

        const useBackendAgent =
          llmConfig.provider !== "claude-code" &&
          llmConfig.provider !== "codex-cli"

        if (useBackendAgent) {
          setAgentEvents([
            {
              stage: "routing",
              status: "running",
              message: t("chat.agent.routing"),
            },
          ])
          const visibleHistory = conversationMessages(convId)
            .filter((m) => m.role === "user" || m.role === "assistant")
          const activeConvMessages = sendOptions.historyOverride
            ?? (sendOptions.suppressUserMessage ? visibleHistory : visibleHistory.slice(0, -1))
              .slice(-maxHistoryMessages)
              .map((m) => ({ role: m.role, content: m.content }))
          let accumulated = ""
          const references: MessageReference[] = []
          const backendEvents: BackendAgentToolEvent[] = []
          const seenRefs = new Set<string>()
          let pendingUserInputRequest: ChatUserInputRequest | undefined
          let streamFinished = false
          let streamUnlisten: (() => void) | null = null
          let resolveStream: (() => void) | null = null
          let rejectStream: ((err: Error) => void) | null = null
          const streamDone = new Promise<void>((resolve, reject) => {
            resolveStream = resolve
            rejectStream = reject
          })
          void streamDone.catch(() => {})
          const streamIdleTimeoutMs = agentStreamIdleTimeoutMs(sendOptions, requestSkills.length)
          let timeout: number | undefined
          const clearStreamTimeout = () => {
            if (timeout !== undefined) {
              window.clearTimeout(timeout)
              timeout = undefined
            }
          }
          const resetStreamTimeout = () => {
            clearStreamTimeout()
            timeout = window.setTimeout(() => {
              if (!streamFinished) {
                streamFinished = true
                rejectStream?.(new Error("Agent stream timed out"))
              }
            }, streamIdleTimeoutMs)
          }
          resetStreamTimeout()
          streamUnlisten = await listen<BackendAgentEventPayload>("agent-event", (event) => {
            const payload = event.payload
            if (payload.sessionId !== convId || payload.runId !== backendRunId || !isCurrentRun()) return
            resetStreamTimeout()
            const agentEvent = payload.event
            if (agentEvent.type === "done") {
              if (!streamFinished) {
                streamFinished = true
                clearStreamTimeout()
                resolveStream?.()
              }
              return
            }
            if (agentEvent.type === "messageDelta" && agentEvent.text) {
              accumulated += agentEvent.text
              appendStreamToken(agentEvent.text)
              return
            }
            if (agentEvent.type === "referenceAdded" && agentEvent.reference) {
              const ref = backendReferenceToMessageReference(agentEvent.reference)
              const key = `${ref.kind ?? "wiki"}:${ref.url ?? ref.path}`.toLowerCase()
              if (!seenRefs.has(key)) {
                seenRefs.add(key)
                references.push(ref)
              }
              if (ref.kind === "workspace" && project) {
                const outputPath = projectAbsolutePath(project.path, ref.path)
                const preview: ChatReferencePreview = {
                  title: ref.title || getFileName(outputPath),
                  path: outputPath,
                  source: ref.source ?? "Workspace",
                  content: "",
                  snippet: ref.snippet,
                }
                dismissedGeneratedOutputsKeyRef.current = null
                setReferencePreview(null)
                setGeneratedOutputPreviews((prev) => {
                  if (prev.some((item) => item.path === preview.path)) return prev
                  return [...prev, preview]
                })
              }
              return
            }
            if (agentEvent.type === "userInputRequired" && agentEvent.request) {
              pendingUserInputRequest = agentEvent.request
              if (!accumulated.trim()) {
                const intro = agentEvent.request.description
                  || t("chat.userInputRequiredDescription", { defaultValue: "Please provide the requested information to continue." })
                accumulated = intro
                appendStreamToken(intro)
              }
              return
            }
            if (agentEvent.type === "toolStart" && agentEvent.tool) {
              const toolEvent: BackendAgentToolEvent = {
                tool: agentEvent.tool,
                status: "started",
                detail: agentEvent.input,
              }
              backendEvents.push(toolEvent)
              setAgentEvents((prev) => [...prev, backendToolToAgentEvent(toolEvent)].slice(-6))
              return
            }
            if (agentEvent.type === "toolEnd" && agentEvent.tool) {
              const failed = typeof agentEvent.output === "string" && agentEvent.output.startsWith("failed:")
              const skipped = typeof agentEvent.output === "string" && agentEvent.output.startsWith("approval required:")
              const toolEvent: BackendAgentToolEvent = {
                tool: agentEvent.tool,
                status: failed ? "failed" : skipped ? "available" : "completed",
                detail: agentEvent.output,
              }
              backendEvents.push(toolEvent)
              setAgentEvents((prev) => [...prev, backendToolToAgentEvent(toolEvent)].slice(-6))
              return
            }
            if (agentEvent.type === "error" && agentEvent.message) {
              const toolEvent: BackendAgentToolEvent = {
                tool: "agent",
                status: "failed",
                detail: agentEvent.message,
              }
              backendEvents.push(toolEvent)
              setAgentEvents((prev) => [...prev, backendToolToAgentEvent(toolEvent)].slice(-6))
              if (!streamFinished) {
                streamFinished = true
                clearStreamTimeout()
                rejectStream?.(new Error(agentEvent.message))
              }
            }
          })
          try {
            await invoke<string>("agent_start_turn_stream", {
              projectId: project?.id ?? "current",
              request: {
                message: text,
                sessionId: convId,
                runId: backendRunId,
                mode: sendOptions.agentMode,
                stream: true,
                tools: {
                  wiki: true,
                  web: sendOptions.useWebSearch,
                  anytxt: sendOptions.useAnyTxtSearch,
                },
                topK: sendOptions.agentMode === "deep" ? 8 : 5,
                includeContent: sendOptions.agentMode === "deep",
                history: activeConvMessages,
                historyExplicit: true,
                skills: requestSkills,
                skillMode: requestedSkillMode,
                approvedShellCommands: sendOptions.approvedShellCommands ?? [],
                shellCommand: sendOptions.shellCommand,
                images: images.map((image) => ({
                  mediaType: image.mediaType,
                  dataBase64: image.dataBase64,
                })),
              },
            })
            await streamDone
          } finally {
            clearStreamTimeout()
            streamUnlisten?.()
          }
          if (!isCurrentRun()) return
          lastQueryPages = references
            .filter((ref) => ref.kind === "wiki")
            .map((ref) => ({ title: ref.title, path: ref.path }))
          const steps = backendEvents.map(backendToolToAgentStep)
          finalized = true
          finalizeStreamForConversation(convId, accumulated, references, steps, pendingUserInputRequest)
          if (!pendingUserInputRequest) {
            autoOpenSingleGeneratedOutput(convId, references)
          }
          setAgentEvents([])
          setStreamingConversationId(null)
          abortRef.current = null
          activeRunSessionIdRef.current = null
          activeRunIdRef.current = null
          return
        }

        const activeConvMessages = conversationMessages(convId)
          .filter((m) => m.role === "user" || m.role === "assistant")
          .slice(-maxHistoryMessages)
        const priorMessages = activeConvMessages.slice(0, -1)
        const priorWireMessages = sendOptions.historyOverride
          ?? chatMessagesToLLM(priorMessages).map((m) => ({
            role: m.role,
            content: typeof m.content === "string"
              ? m.content
              : m.content
                  .filter((block) => block.type === "text")
                  .map((block) => block.text)
                  .join("\n"),
          }))
        const backendResponse = await invoke<BackendAgentResponse>("agent_start_turn", {
          projectId: project?.id ?? "current",
          request: {
            message: text,
            sessionId: convId,
            runId: backendRunId,
            persistSession: false,
            mode: sendOptions.agentMode,
            tools: {
              wiki: true,
              web: sendOptions.useWebSearch,
              anytxt: sendOptions.useAnyTxtSearch,
            },
            topK: sendOptions.agentMode === "deep" ? 8 : 5,
            includeContent: sendOptions.agentMode === "deep",
            skills: requestSkills,
            skillMode: requestedSkillMode,
            historyExplicit: true,
            approvedShellCommands: sendOptions.approvedShellCommands ?? [],
            shellCommand: sendOptions.shellCommand,
            history: priorWireMessages,
            images: images.map((image) => ({
              mediaType: image.mediaType,
              dataBase64: image.dataBase64,
            })),
          },
        })
        if (!isCurrentRun()) return

        const backendReferences = (backendResponse.references ?? []).map(backendReferenceToMessageReference)
        const backendSteps = (backendResponse.toolEvents ?? []).map(backendToolToAgentStep)
        const backendEvents = (backendResponse.toolEvents ?? []).map(backendToolToAgentEvent)
        setAgentEvents(backendEvents.slice(-6))
        lastQueryPages = backendReferences
          .filter((ref) => ref.kind === "wiki")
          .map((ref) => ({ title: ref.title, path: ref.path }))

        if (backendResponse.userInputRequest) {
          finalized = true
          finalizeStreamForConversation(
            convId,
            backendResponse.message
              ? backendResponseText(backendResponse)
              : (backendResponse.userInputRequest.description ?? t("chat.userInputRequiredDescription", { defaultValue: "Please provide the requested information to continue." })),
            backendReferences,
            backendSteps,
            backendResponse.userInputRequest,
          )
          setAgentEvents([])
          setStreamingConversationId(null)
          abortRef.current = null
          activeRunSessionIdRef.current = null
          activeRunIdRef.current = null
          return
        }

        const contextText = [
          "You have access to the current LLM Wiki project context below. Use it as retrieved evidence when it is relevant.",
          "",
          backendResponseText(backendResponse),
          "",
          `User request: ${text}`,
        ].join("\n")
        const userContent: string | ContentBlock[] = images.length > 0
          ? [
              { type: "text", text: contextText },
              ...images.map((image) => ({
                type: "image" as const,
                mediaType: image.mediaType,
                dataBase64: image.dataBase64,
              })),
            ]
          : contextText
        const finalMessages: LlmChatMessage[] = [
          {
            role: "system",
            content: "Answer using the provided LLM Wiki context and references. If the context is insufficient, say what is missing instead of inventing details.",
          },
          ...(sendOptions.historyOverride ?? chatMessagesToLLM(priorMessages)),
          { role: "user", content: userContent },
        ]

        let accumulated = ""
        let thinkingOpen = false

        const appendReasoning = (token: string) => {
          if (!token) return
          if (!thinkingOpen) {
            thinkingOpen = true
            accumulated += "<think>"
            appendStreamToken("<think>")
          }
          accumulated += token
          appendStreamToken(token)
        }

        const closeReasoning = () => {
          if (!thinkingOpen) return
          thinkingOpen = false
          accumulated += "</think>"
          appendStreamToken("</think>")
        }

        const streamFinalAnswer = async (reasoningOff: boolean) => {
          let streamError: Error | null = null
          await streamChat(
            llmConfig,
            finalMessages,
            {
              onToken: (token) => {
                if (!isCurrentRun()) return
                closeReasoning()
                accumulated += token
                appendStreamToken(token)
              },
              onReasoningToken: (token) => {
                if (!isCurrentRun()) return
                if (reasoningOff) return
                appendReasoning(token)
              },
              onDone: () => {},
              onError: (err) => {
                streamError = err
              },
            },
            controller.signal,
            reasoningOff ? { reasoning: { mode: "off" } } : undefined,
          )
          if (streamError) throw streamError
        }

        try {
          await streamFinalAnswer(false)
        } catch (err) {
          if (!isCurrentRun()) return
          if (isReasoningOnlyResponseError(err)) {
            accumulated = ""
            thinkingOpen = false
            useChatStore.setState({ streamingContent: "" })
            await streamFinalAnswer(true)
          } else {
            throw err
          }
        }

        if (!isCurrentRun()) return
        closeReasoning()
        finalized = true
        finalizeStreamForConversation(convId, accumulated, backendReferences, backendSteps)
        autoOpenSingleGeneratedOutput(convId, backendReferences)
        setAgentEvents([])
        setStreamingConversationId(null)
        abortRef.current = null
        activeRunSessionIdRef.current = null
        activeRunIdRef.current = null
        // save-worthy detection removed — user has direct "Save to Wiki" button on each message
      } catch (err) {
        if (!finalized) {
          if (isAbortLikeError(err) || runIdRef.current !== runId) {
            setStreaming(false)
            setAgentEvents([])
            setStreamingConversationId(null)
            abortRef.current = null
            activeRunSessionIdRef.current = null
            activeRunIdRef.current = null
            return
          }
          const message = err instanceof Error ? err.message : String(err)
          finalizeStreamForConversation(convId, `Error: ${message}`, undefined)
          setAgentEvents([])
          setStreamingConversationId(null)
        }
        abortRef.current = null
        activeRunSessionIdRef.current = null
        activeRunIdRef.current = null
      }
    },
    [project, llmConfig, searchApiConfig, addMessageToConversation, setStreaming, appendStreamToken, finalizeStreamForConversation, createConversation, maxHistoryMessages, t, availableSkills, autoOpenSingleGeneratedOutput],
  )

  const handleStop = useCallback(() => {
    runIdRef.current += 1
    const sessionId = activeRunSessionIdRef.current
    const backendRunId = activeRunIdRef.current
    if (sessionId) {
      void invoke("agent_cancel_turn", {
        projectId: project?.id ?? "current",
        sessionId,
        runId: backendRunId ?? undefined,
      }).catch(() => {})
    }
    abortRef.current?.abort()
    abortRef.current = null
    activeRunSessionIdRef.current = null
    activeRunIdRef.current = null
    setStreaming(false)
    setAgentEvents([])
    setStreamingConversationId(null)
  }, [project, setStreaming])

  const handleNewConversation = useCallback(() => {
    handleStop()
    setReferencePreview(null)
    setGeneratedOutputPreviews([])
    setGeneratedOutputPreview(null)
    setApprovingShellMessageId(null)
    dismissedGeneratedOutputsKeyRef.current = null
    createConversation()
  }, [createConversation, handleStop])

  const handleSelectConversation = useCallback((conversationId: string) => {
    useChatStore.getState().setActiveConversation(conversationId)
    setApprovingShellMessageId(null)
  }, [])

  const handleRegenerate = useCallback(async () => {
    if (activeStreaming) return
    // Find the last user message in active conversation
    const active = useChatStore.getState().getActiveMessages()
    const lastUserMsg = [...active].reverse().find((m) => m.role === "user")
    if (!lastUserMsg) return
    // Remove the last assistant reply, then re-send
    removeLastAssistantMessage()
    // Small delay to let state update
    await new Promise((r) => setTimeout(r, 50))
    // Trigger send with the same text (handleSend will add a new user message,
    // so also remove the original to avoid duplication)
    // Actually: just call handleSend — but it adds a user message. To avoid dupe,
    // we remove the last user message too and let handleSend re-add it.
    const store = useChatStore.getState()
    const updatedActive = store.getActiveMessages()
    const lastUser = [...updatedActive].reverse().find((m) => m.role === "user")
    if (lastUser) {
      const activeId = useChatStore.getState().activeConversationId
      useChatStore.setState((s) => ({
        messages: s.messages.filter((m) => m.conversationId !== activeId || m.id !== lastUser.id),
      }))
    }
    // Re-send with the original text AND images so a regenerated turn
    // keeps the same vision context.
    handleSend(lastUserMsg.content, lastUserMsg.images ?? [])
  }, [activeStreaming, removeLastAssistantMessage, handleSend])

  const handleApproveShellCommand = useCallback(async (command: string, assistantMessageId: string) => {
    if (!command.trim() || approvingShellMessageId) return
    const active = useChatStore.getState().getActiveMessages()
    const assistantIndex = active.findIndex((message) => message.id === assistantMessageId)
    if (assistantIndex <= 0) {
      console.warn("[chat] shell approval ignored: assistant message not found", assistantMessageId)
      return
    }
    const priorUser = [...active.slice(0, assistantIndex)]
      .reverse()
      .find((message) => message.role === "user")
    if (!priorUser) {
      console.warn("[chat] shell approval ignored: no prior user message")
      return
    }
    const assistantMessage = active[assistantIndex]
    const resumeHistory = [
      ...compactChatHistoryForResume(active.slice(0, assistantIndex), maxHistoryMessages),
      {
        role: "assistant" as const,
        content: [
          "The previous Agent turn stopped at a shell approval boundary.",
          "Preserved tool progress before approval:",
          summarizeAgentStepsForResume(assistantMessage.agentSteps),
          "",
          assistantMessage.content,
        ].join("\n"),
      },
    ]
    const resumeMessage = [
      "Continue the same Agent task from the preserved tool progress. The user approved the pending shell command; execute only that approved command first, then continue from its result. Do not restart completed setup, file reads, or workspace writes unless the command result proves they are invalid.",
    ].join("\n")
    setApprovingShellMessageId(assistantMessageId)
    // Approval is a continuation of a turn that has already stopped at a
    // permission boundary. Clear any stale streaming state before resuming so a
    // delayed store update cannot make the button feel inert.
    abortRef.current?.abort()
    abortRef.current = null
    activeRunSessionIdRef.current = null
    activeRunIdRef.current = null
    setStreaming(false)
    try {
      await handleSend(resumeMessage, priorUser.images ?? [], {
        useWebSearch: useChatStore.getState().useWebSearch,
        useAnyTxtSearch: useChatStore.getState().useAnyTxtSearch,
        agentMode: useChatStore.getState().agentMode,
        skills: useChatStore.getState().selectedSkills,
        skillMode: useChatStore.getState().selectedSkills.length > 0 ? "explicit" : "auto",
        approvedShellCommands: [command.trim()],
        shellCommand: command.trim(),
        suppressUserMessage: true,
        historyOverride: resumeHistory,
      })
    } finally {
      setApprovingShellMessageId(null)
    }
  }, [approvingShellMessageId, handleSend, setStreaming])

  const handleSubmitUserInput = useCallback((request: ChatUserInputRequest, answers: Record<string, unknown>) => {
    if (activeStreaming) return false
    const answerLines = request.fields.map((field) => {
      const value = answers[field.id]
      const rendered = Array.isArray(value) ? value.join(", ") : String(value ?? "")
      return `- ${field.label} (${field.id}): ${rendered || "(empty)"}`
    })
    const resumeMessage = [
      `User provided answers for "${request.title}".`,
      "",
      ...answerLines,
      "",
      "Continue the previous task using these answers. Do not ask the same questions again unless required information is still missing.",
    ].join("\n")
    handleSend(resumeMessage, [], {
      useWebSearch: useChatStore.getState().useWebSearch,
      useAnyTxtSearch: useChatStore.getState().useAnyTxtSearch,
      agentMode: useChatStore.getState().agentMode,
      skills: useChatStore.getState().selectedSkills,
      skillMode: useChatStore.getState().selectedSkills.length > 0 ? "explicit" : "auto",
    })
    return true
  }, [handleSend, activeStreaming])

  const handleWriteToWiki = useCallback(async () => {
    if (!project) return
    const pp = normalizePath(project.path)
    try {
      await executeIngestWrites(pp, llmConfig, undefined, undefined)
      await refreshProjectFileTree(pp, { bumpDataVersion: true })
    } catch (err) {
      console.error("Failed to write to wiki:", err)
    }
  }, [project, llmConfig])

  const hasAssistantMessages = activeMessages.some((m) => m.role === "assistant")
  const showWriteButton = mode === "ingest" && !activeStreaming && hasAssistantMessages

  return (
    <div className="flex h-full flex-row overflow-hidden">
      <ConversationSidebar
        onNewConversation={handleNewConversation}
        onSelectConversation={handleSelectConversation}
      />

      <div className="flex flex-1 flex-col overflow-hidden">
        {!activeConversationId ? (
          <div className="flex flex-1 items-center justify-center text-muted-foreground">
            <div className="text-center">
              <MessageSquare className="mx-auto mb-3 h-8 w-8 opacity-30" />
              <p className="text-sm">{t("chat.startNewConversation")}</p>
              <p className="mt-1 text-xs opacity-60">{t("chat.clickNewChatToBegin")}</p>
            </div>
          </div>
          ) : (
            <>
              <div
                ref={scrollContainerRef}
                className="flex-1 overflow-y-auto px-3 py-2"
              >
                <div className="flex flex-col gap-3">
                  {activeMessages.map((msg, idx) => {
                    // Check if this is the last assistant message
                    const isLastAssistant = msg.role === "assistant" &&
                      !activeMessages.slice(idx + 1).some((m) => m.role === "assistant")
                    return (
                      <ChatMessage
                        key={`${msg.conversationId}:${msg.id}:${msg.timestamp}:${idx}`}
                        message={msg}
                        isLastAssistant={isLastAssistant && !activeStreaming}
                        onRegenerate={isLastAssistant ? handleRegenerate : undefined}
                        onOpenReferencePreview={handleOpenReferencePreview}
                        onApproveShellCommand={
                          isLastAssistant && approvingShellMessageId !== msg.id
                            ? handleApproveShellCommand
                            : undefined
                        }
                        onSubmitUserInput={isLastAssistant ? handleSubmitUserInput : undefined}
                      />
                    )
                  })}
                  {activeStreaming && <StreamingMessage content={streamingContent} agentEvents={activeAgentEvents} />}
                  <div ref={bottomRef} />
                </div>
              </div>

            {showWriteButton && (
              <div className="border-t px-3 py-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleWriteToWiki}
                  className="w-full gap-2"
                >
                  <BookOpen className="h-4 w-4" />
                  {t("chat.writeToWiki")}
                </Button>
              </div>
            )}
          </>
        )}

        <ChatInput
          onSend={handleSend}
          onStop={handleStop}
          isStreaming={activeStreaming}
          useWebSearch={useWebSearch}
          useAnyTxtSearch={useAnyTxtSearch}
          agentMode={agentMode}
          availableSkills={availableSkills}
          selectedSkills={selectedSkills}
          onUseWebSearchChange={setUseWebSearch}
          onUseAnyTxtSearchChange={setUseAnyTxtSearch}
          onAgentModeChange={setAgentMode}
          onSelectedSkillsChange={setSelectedSkills}
          anyTxtAvailable={anyTxtAvailable}
          imageInputAvailable={imageInputAvailable}
          placeholder={
            mode === "ingest"
              ? t("chat.ingestPlaceholder")
              : t("chat.typeAMessage")
          }
        />
      </div>

      {referencePreview && (
        <ChatReferencePreviewPanel
          preview={referencePreview}
          width={referencePreviewWidth}
          onResize={setReferencePreviewWidth}
          onClose={() => setReferencePreview(null)}
        />
      )}
      {generatedOutputPreviews.length > 0 && (
        <GeneratedOutputsPanel
          outputs={generatedOutputPreviews}
          onOpen={openGeneratedOutputModal}
          onOpenDirectory={project ? openGeneratedOutputDirectory : undefined}
          onClose={closeGeneratedOutputsPanel}
        />
      )}
      {generatedOutputPreview && (
        <GeneratedOutputPreviewDialog
          preview={generatedOutputPreview}
          onClose={() => setGeneratedOutputPreview(null)}
        />
      )}
    </div>
  )
}

function GeneratedOutputsPanel({
  outputs,
  onOpen,
  onOpenDirectory,
  onClose,
}: {
  outputs: ChatReferencePreview[]
  onOpen: (preview: ChatReferencePreview) => void
  onOpenDirectory?: () => void
  onClose: () => void
}) {
  const { t } = useTranslation()
  return (
    <aside className="flex h-full w-[280px] shrink-0 flex-col border-l bg-background">
      <div className="flex min-h-10 items-center gap-2 border-b px-3 py-2">
        <FolderOpen className="h-4 w-4 shrink-0 text-primary" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-medium">{t("chat.generatedOutputs")}</div>
          <div className="mt-0.5 text-[10px] text-muted-foreground">
            {t("chat.generatedOutputCount", { count: outputs.length })}
          </div>
        </div>
        {onOpenDirectory && (
          <button
            type="button"
            onClick={onOpenDirectory}
            className="shrink-0 rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
            title={t("chat.openGeneratedOutputFolder", { defaultValue: "Open output folder" })}
            aria-label={t("chat.openGeneratedOutputFolder", { defaultValue: "Open output folder" })}
          >
            <FolderOpen className="h-3.5 w-3.5" />
          </button>
        )}
        <button
          type="button"
          onClick={onClose}
          className="shrink-0 rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          title={t("chat.closeGeneratedOutputs")}
          aria-label={t("chat.closeGeneratedOutputs")}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-2">
        <div className="space-y-1">
          {outputs.map((output) => {
            const title = output.title || getFileName(output.path)
            const isImageOutput = isGeneratedOutputImage(output.path)
            const imageSrc = isImageOutput ? convertFileSrc(output.path) : null
            return (
              <button
                key={output.path}
                type="button"
                onClick={() => onOpen(output)}
                className="group flex w-full items-start gap-2 rounded-md border border-border/60 bg-muted/20 px-2 py-2 text-left transition-colors hover:border-primary/30 hover:bg-primary/5"
                title={output.path}
              >
                {imageSrc ? (
                  <span className="h-10 w-12 shrink-0 overflow-hidden rounded border border-primary/20 bg-background/80">
                    <img
                      src={imageSrc}
                      alt={title}
                      loading="lazy"
                      className="h-full w-full object-cover"
                      onError={(event) => {
                        event.currentTarget.style.opacity = "0"
                      }}
                    />
                  </span>
                ) : (
                  <FileText className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground group-hover:text-primary" />
                )}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs font-medium text-foreground">{title}</span>
                  <span className="mt-0.5 block truncate text-[10px] text-muted-foreground">{output.path}</span>
                </span>
                <Maximize2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground group-hover:text-primary" />
              </button>
            )
          })}
        </div>
      </div>
    </aside>
  )
}

function GeneratedOutputPreviewDialog({
  preview,
  onClose,
}: {
  preview: ChatReferencePreview
  onClose: () => void
}) {
  const { t } = useTranslation()
  const displayTitle = preview.title || getFileName(preview.path)
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose()
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [onClose])
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-6">
      <div className="flex h-[86vh] w-[80vw] min-w-0 max-w-[1600px] flex-col overflow-hidden rounded-xl border bg-background shadow-2xl">
        <div className="flex min-h-12 items-center gap-3 border-b px-4 py-2">
          <Maximize2 className="h-4 w-4 shrink-0 text-primary" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium" title={displayTitle}>{displayTitle}</div>
            <div className="mt-0.5 truncate text-[11px] text-muted-foreground" title={preview.path}>{preview.path}</div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 rounded p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
            title={t("chat.closeGeneratedOutputPreview")}
            aria-label={t("chat.closeGeneratedOutputPreview")}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-hidden">
          <ChatReferencePreviewContent preview={preview} />
        </div>
      </div>
    </div>
  )
}

function ChatReferencePreviewPanel({
  preview,
  width,
  onResize,
  onClose,
}: {
  preview: ChatReferencePreview
  width: number
  onResize: (width: number) => void
  onClose: () => void
}) {
  const { t } = useTranslation()
  const displayTitle = preview.title || getFileName(preview.path)
  const dragStartRef = useRef<{ x: number; width: number } | null>(null)

  const startResize = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    dragStartRef.current = { x: event.clientX, width }
    event.currentTarget.setPointerCapture(event.pointerId)
  }, [width])

  const handleResize = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!dragStartRef.current) return
    const delta = dragStartRef.current.x - event.clientX
    onResize(clampReferencePreviewWidth(dragStartRef.current.width + delta))
  }, [onResize])

  const stopResize = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    dragStartRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }, [])

  return (
    <aside
      className="relative flex h-full min-w-[320px] max-w-[56%] shrink-0 flex-col border-l bg-background"
      style={{ width }}
    >
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={t("chat.resizeReferencePreview")}
        tabIndex={0}
        onPointerDown={startResize}
        onPointerMove={handleResize}
        onPointerUp={stopResize}
        onPointerCancel={stopResize}
        onKeyDown={(event) => {
          if (event.key === "ArrowLeft") {
            event.preventDefault()
            onResize(clampReferencePreviewWidth(width + 32))
          } else if (event.key === "ArrowRight") {
            event.preventDefault()
            onResize(clampReferencePreviewWidth(width - 32))
          }
        }}
        className="absolute -left-1 top-0 z-10 h-full w-2 cursor-col-resize outline-none transition-colors hover:bg-primary/15 focus-visible:bg-primary/20"
      />
      <div className="flex min-h-10 items-center gap-2 border-b px-3 py-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-medium" title={displayTitle}>
            {displayTitle}
          </div>
          <div className="mt-0.5 truncate text-[10px] text-muted-foreground" title={preview.path}>
            {preview.source ?? t("chat.referencePreview")} · {preview.path}
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="shrink-0 rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          title={t("chat.closeReferencePreview")}
          aria-label={t("chat.closeReferencePreview")}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        <ChatReferencePreviewContent preview={preview} />
      </div>
    </aside>
  )
}

function ChatReferencePreviewContent({ preview }: { preview: ChatReferencePreview }) {
  if (preview.external) return <ExternalReferencePreview preview={preview} />
  if (getFileCategory(preview.path) === "markdown") {
    return <ChatMarkdownReferencePreview preview={preview} />
  }
  return (
    <FilePreview
      key={preview.path}
      filePath={preview.path}
      textContent={preview.content}
    />
  )
}

function clampReferencePreviewWidth(width: number): number {
  return Math.min(760, Math.max(320, Math.round(width)))
}

function ChatMarkdownReferencePreview({ preview }: { preview: ChatReferencePreview }) {
  const { frontmatter, body } = parseFrontmatter(preview.content)
  return (
    <div className="h-full overflow-auto px-6 py-6">
      {frontmatter && <FrontmatterPanel data={frontmatter} />}
      <WikiReader body={body} filePath={preview.path} />
    </div>
  )
}

function ExternalReferencePreview({ preview }: { preview: ChatReferencePreview }) {
  const { t } = useTranslation()
  return (
    <div className="flex h-full flex-col overflow-auto p-5">
      <div className="mb-4 space-y-2">
        <div className="flex items-center gap-2">
          {preview.source && (
            <span className="rounded border border-border/60 bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase text-muted-foreground">
              {preview.source}
            </span>
          )}
          <h3 className="truncate text-sm font-medium" title={preview.title}>{preview.title}</h3>
        </div>
        <div className="break-all rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
          {preview.path.replace(/^[a-z]+-preview:\/\//, "")}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto rounded-lg border border-border/60 bg-muted/20 p-4">
        <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-6">
          {preview.snippet?.trim() || t("chat.noReferencePreviewFragment")}
        </pre>
      </div>
    </div>
  )
}

function isAbortLikeError(err: unknown): boolean {
  if (err instanceof DOMException && err.name === "AbortError") return true
  if (!(err instanceof Error)) return false
  return err.name === "AbortError" || /abort|cancel/i.test(err.message)
}

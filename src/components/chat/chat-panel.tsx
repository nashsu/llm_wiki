import { useRef, useEffect, useCallback } from "react"
import { BookOpen } from "lucide-react"
import { Button } from "@/components/ui/button"
import { ChatMessage, StreamingMessage, useSourceFiles } from "./chat-message"
import { ChatInput } from "./chat-input"
import { useChatStore, chatMessagesToLLM } from "@/stores/chat-store"
import { useWikiStore } from "@/stores/wiki-store"
import { streamChat, type ChatMessage as LLMMessage } from "@/lib/llm-client"
import { executeIngestWrites } from "@/lib/ingest"
import { listDirectory, readFile } from "@/commands/fs"
import type { FileNode } from "@/types/wiki"

export function ChatPanel() {
  useSourceFiles() // Keep source file cache warm
  const messages = useChatStore((s) => s.messages)
  const isStreaming = useChatStore((s) => s.isStreaming)
  const streamingContent = useChatStore((s) => s.streamingContent)
  const mode = useChatStore((s) => s.mode)
  const addMessage = useChatStore((s) => s.addMessage)
  const setStreaming = useChatStore((s) => s.setStreaming)
  const appendStreamToken = useChatStore((s) => s.appendStreamToken)
  const finalizeStream = useChatStore((s) => s.finalizeStream)

  const project = useWikiStore((s) => s.project)
  const llmConfig = useWikiStore((s) => s.llmConfig)
  const setFileTree = useWikiStore((s) => s.setFileTree)

  const abortRef = useRef<AbortController | null>(null)
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const bottomRef = useRef<HTMLDivElement>(null)

  // Auto-scroll to bottom when messages change or streaming content updates
  useEffect(() => {
    const container = scrollContainerRef.current
    if (container) {
      container.scrollTop = container.scrollHeight
    }
  }, [messages, streamingContent])

  const handleSend = useCallback(
    async (text: string) => {
      addMessage("user", text)
      setStreaming(true)

      // Build system prompt with wiki context + source file list
      const systemMessages: LLMMessage[] = []
      if (project) {
        const [index, purpose] = await Promise.all([
          readFile(`${project.path}/wiki/index.md`).catch(() => ""),
          readFile(`${project.path}/purpose.md`).catch(() => ""),
        ])

        // Get list of actual source files the user uploaded
        let sourceFileList = ""
        try {
          const sourceTree = await listDirectory(`${project.path}/raw/sources`)
          const sourceNames = flattenFileNames(sourceTree)
          sourceFileList = sourceNames.length > 0
            ? sourceNames.map((n) => `- ${n}`).join("\n")
            : "(No source files yet)"
        } catch {
          sourceFileList = "(No source files yet)"
        }

        systemMessages.push({
          role: "system",
          content: [
            "You are a knowledgeable wiki assistant. Answer questions based ONLY on the wiki's actual content.",
            "",
            "## Citation Rules (CRITICAL)",
            "- Your answers are derived from the user's uploaded source documents.",
            "- At the end of your answer, under '**References:**', list the source files your answer draws from.",
            "- Reference format: use @filename exactly as listed below (e.g., @2603.25723v1.pdf). One per line.",
            "- Use the EXACT original file names. NEVER rename, paraphrase, or invent file names.",
            "- If the wiki doesn't have enough information to answer, say so honestly.",
            "- You may also use [[wikilink]] syntax to reference wiki pages in the index.",
            "",
            "Use markdown formatting for clarity.",
            "",
            purpose ? `## Wiki Purpose\n${purpose}` : "",
            `## Source Files (user's uploaded documents)\n${sourceFileList}`,
            index ? `## Wiki Index\n${index}` : "",
          ].filter(Boolean).join("\n"),
        })
      }

      const allMessages = useChatStore.getState().messages
      const llmMessages = [...systemMessages, ...chatMessagesToLLM(allMessages)]

      const controller = new AbortController()
      abortRef.current = controller

      let accumulated = ""

      await streamChat(
        llmConfig,
        llmMessages,
        {
          onToken: (token) => {
            accumulated += token
            appendStreamToken(token)
          },
          onDone: () => {
            finalizeStream(accumulated)
            abortRef.current = null
          },
          onError: (err) => {
            finalizeStream(`Error: ${err.message}`)
            abortRef.current = null
          },
        },
        controller.signal,
      )
    },
    [llmConfig, addMessage, setStreaming, appendStreamToken, finalizeStream],
  )

  const handleStop = useCallback(() => {
    abortRef.current?.abort()
    abortRef.current = null
  }, [])

  const handleWriteToWiki = useCallback(async () => {
    if (!project) return
    try {
      await executeIngestWrites(project.path, llmConfig, undefined, undefined)
      try {
        const tree = await listDirectory(project.path)
        setFileTree(tree)
      } catch {
        // ignore
      }
    } catch (err) {
      console.error("Failed to write to wiki:", err)
    }
  }, [project, llmConfig, setFileTree])

  const hasAssistantMessages = messages.some((m) => m.role === "assistant")
  const showWriteButton = mode === "ingest" && !isStreaming && hasAssistantMessages

  return (
    <div className="flex h-full flex-col">
      <div
        ref={scrollContainerRef}
        className="flex-1 overflow-y-auto px-3 py-2"
      >
        <div className="flex flex-col gap-3">
          {messages.map((msg) => (
            <ChatMessage key={msg.id} message={msg} />
          ))}
          {isStreaming && <StreamingMessage content={streamingContent} />}
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
            Write to Wiki
          </Button>
        </div>
      )}

      <ChatInput
        onSend={handleSend}
        onStop={handleStop}
        isStreaming={isStreaming}
        placeholder={
          mode === "ingest"
            ? "Discuss the source or ask follow-up questions..."
            : "Type a message..."
        }
      />
    </div>
  )
}

function flattenFileNames(nodes: FileNode[]): string[] {
  const names: string[] = []
  for (const node of nodes) {
    if (node.is_dir && node.children) {
      names.push(...flattenFileNames(node.children))
    } else if (!node.is_dir) {
      names.push(node.name)
    }
  }
  return names
}

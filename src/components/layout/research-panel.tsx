import { useState, useRef, useEffect, useMemo } from "react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import remarkMath from "remark-math"
import rehypeKatex from "rehype-katex"
import "katex/dist/katex.min.css"
import {
  Search, Loader2, CheckCircle2, AlertCircle, ChevronRight, ChevronDown, X,
  FileText, Send,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { useResearchStore, type ResearchTask } from "@/stores/research-store"
import { useWikiStore } from "@/stores/wiki-store"
import { readFile } from "@/commands/fs"
import { queueResearch } from "@/lib/deep-research"
import { normalizePath } from "@/lib/path-utils"
import { isImeComposing } from "@/lib/keyboard-utils"
import { detectLanguage } from "@/lib/detect-language"
import { getHtmlLang, getTextDirection } from "@/lib/language-metadata"
import { getResearchArtifactLabel } from "@/lib/research-artifacts"
import { MermaidDiagram, unwrapMermaidPre } from "@/components/mermaid-diagram"

export function ResearchPanel() {
  const tasks = useResearchStore((s) => s.tasks)
  const removeTask = useResearchStore((s) => s.removeTask)
  const setPanelOpen = useResearchStore((s) => s.setPanelOpen)
  const project = useWikiStore((s) => s.project)
  const llmConfig = useWikiStore((s) => s.llmConfig)
  const searchApiConfig = useWikiStore((s) => s.searchApiConfig)
  const [inputValue, setInputValue] = useState("")

  const running = tasks.filter((t) => ["searching", "synthesizing", "saving"].includes(t.status))
  const queued = tasks.filter((t) => t.status === "queued")
  const done = tasks.filter((t) => t.status === "done" || t.status === "error")

  function handleStartResearch() {
    const topic = inputValue.trim()
    if (!topic || !project) return
    if (searchApiConfig.provider === "none" || !searchApiConfig.apiKey) {
      window.alert("Web Search not configured. Go to Settings → Web Search to add a Tavily or SerpApi API key.")
      return
    }
    queueResearch(normalizePath(project.path), topic, llmConfig, searchApiConfig)
    setInputValue("")
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center justify-between border-b px-3 py-2">
        <div className="flex items-center gap-2">
          <Search className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-semibold">Deep Research</span>
          {(running.length > 0 || queued.length > 0) && (
            <span className="rounded-full bg-primary/20 px-1.5 py-0.5 text-[10px] font-medium text-primary">
              {running.length} active{queued.length > 0 ? `, ${queued.length} queued` : ""}
            </span>
          )}
        </div>
        <button
          onClick={() => setPanelOpen(false)}
          className="rounded p-1 text-muted-foreground hover:bg-accent"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Research input */}
      <div className="flex shrink-0 items-center gap-1.5 border-b px-3 py-2">
        <input
          value={inputValue}
          dir="auto"
          onChange={(e) => setInputValue(e.target.value)}
          onKeyDown={(e) => {
            if (isImeComposing(e)) return
            if (e.key === "Enter") handleStartResearch()
          }}
          placeholder="Enter a research topic..."
          className="flex-1 rounded border bg-background px-2 py-1 text-xs outline-none placeholder:text-muted-foreground focus:ring-1 focus:ring-ring"
        />
        <Button size="icon" variant="ghost" className="h-7 w-7" onClick={handleStartResearch} disabled={!inputValue.trim()}>
          <Send className="h-3.5 w-3.5" />
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {tasks.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 p-8 text-center text-xs text-muted-foreground">
            <Search className="h-8 w-8 opacity-20" />
            <p>No research tasks yet</p>
            <p>Enter a topic above or click "Deep Research" in Review</p>
          </div>
        ) : (
          <div className="flex flex-col gap-1 p-2">
            {running.map((task) => (
              <ResearchTaskCard key={task.id} task={task} onRemove={removeTask} />
            ))}
            {queued.map((task) => (
              <ResearchTaskCard key={task.id} task={task} onRemove={removeTask} />
            ))}
            {done.map((task) => (
              <ResearchTaskCard key={task.id} task={task} onRemove={removeTask} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

/** Separate <think>/<thinking> blocks from main content */
function separateThinking(text: string): { thinking: string; answer: string } {
  // Match <think>...</think> or <thinking>...</thinking>
  const thinkRegex = /^<think(?:ing)?>([\s\S]*?)(?:<\/think(?:ing)?>|$)/i
  const match = text.match(thinkRegex)
  if (match) {
    const thinking = match[1].trim()
    const rest = text.slice(match[0].length).trim()
    return { thinking, answer: rest }
  }
  return { thinking: "", answer: text }
}

function ResearchResultBlock({ synthesis, isStreaming }: { synthesis: string; isStreaming: boolean }) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const { thinking, answer } = useMemo(() => separateThinking(synthesis), [synthesis])
  const renderLanguage = useMemo(() => detectLanguage(answer || synthesis), [answer, synthesis])
  const direction = getTextDirection(renderLanguage)
  const htmlLang = getHtmlLang(renderLanguage)
  const [thinkingCollapsed, setThinkingCollapsed] = useState(false)

  // Auto-collapse thinking when answer starts appearing
  useEffect(() => {
    if (answer.length > 0 && thinking.length > 0 && !thinkingCollapsed) {
      setThinkingCollapsed(true)
    }
  }, [answer, thinking, thinkingCollapsed])

  // Auto-scroll to bottom during streaming
  useEffect(() => {
    if (isStreaming && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [synthesis, isStreaming])

  return (
    <div className="mb-2 flex flex-col min-h-0">
      <div className="mb-1 font-medium text-muted-foreground">Research Result</div>
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto rounded bg-muted/30 p-2 prose prose-xs prose-invert max-w-none"
        dir={direction}
        lang={htmlLang}
        style={{ maxHeight: "calc(100vh - 400px)", minHeight: "120px", textAlign: "start" }}
      >
        {thinking && (
          <div className="mb-2">
            <button
              onClick={() => setThinkingCollapsed((v) => !v)}
              className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground"
            >
              {thinkingCollapsed ? (
                <ChevronRight className="h-3 w-3" />
              ) : (
                <ChevronDown className="h-3 w-3" />
              )}
              Thinking{isStreaming && !answer ? "..." : ""}
            </button>
            {!thinkingCollapsed && (
              <div className="mt-1 rounded border border-muted px-2 py-1 text-[10px] text-muted-foreground opacity-70 leading-relaxed whitespace-pre-wrap">
                {isStreaming && !answer
                  ? thinking.split("\n").slice(-5).join("\n")
                  : thinking}
              </div>
            )}
          </div>
        )}
        {answer && (
          <ReactMarkdown
            remarkPlugins={[remarkGfm, remarkMath]}
            rehypePlugins={[rehypeKatex]}
            components={{
              table: ({ children, ...props }) => (
                <div className="my-2 overflow-x-auto rounded border border-border">
                  <table className="w-full border-collapse text-xs" {...props}>{children}</table>
                </div>
              ),
              thead: ({ children, ...props }) => (
                <thead className="bg-muted" {...props}>{children}</thead>
              ),
              th: ({ children, ...props }) => (
                <th className="border border-border/80 px-3 py-1.5 text-start font-semibold bg-muted" {...props}>{children}</th>
              ),
              td: ({ children, ...props }) => (
                <td className="border border-border/60 px-3 py-1.5" {...props}>{children}</td>
              ),
              pre: ({ children, ...props }) => {
                const mermaid = unwrapMermaidPre(children)
                if (mermaid) return <>{mermaid}</>
                return <pre dir="ltr" style={{ textAlign: "left" }} {...props}>{children}</pre>
              },
              code: ({ className, children, ...props }) => {
                const lang = className?.replace("language-", "")
                const codeText = String(children).replace(/\n$/, "")
                if (lang === "mermaid") return <MermaidDiagram code={codeText} />
                return <code dir="ltr" className={className} {...props}>{children}</code>
              },
            }}
          >
            {answer}
          </ReactMarkdown>
        )}
        {isStreaming && <span className="animate-pulse">▊</span>}
      </div>
    </div>
  )
}

function ResearchTaskCard({ task, onRemove }: { task: ResearchTask; onRemove: (id: string) => void }) {
  const [expanded, setExpanded] = useState(
    task.status === "synthesizing" || task.status === "searching"
  )
  const setSelectedFile = useWikiStore((s) => s.setSelectedFile)
  const setFileContent = useWikiStore((s) => s.setFileContent)
  const project = useWikiStore((s) => s.project)

  const statusIcon = {
    queued: <div className="h-3 w-3 rounded-full border-2 border-muted-foreground" />,
    searching: <Loader2 className="h-3 w-3 animate-spin text-blue-500" />,
    synthesizing: <Loader2 className="h-3 w-3 animate-spin text-purple-500" />,
    saving: <Loader2 className="h-3 w-3 animate-spin text-orange-500" />,
    done: <CheckCircle2 className="h-3 w-3 text-emerald-500" />,
    error: <AlertCircle className="h-3 w-3 text-destructive" />,
  }[task.status]

  const savedLabel = task.savedPath
    ? `Saved to ${getResearchArtifactLabel(task.savedArtifactType)}`
    : "Done"

  const statusText = {
    queued: "Queued",
    searching: "Searching web...",
    synthesizing: "Synthesizing...",
    saving: "Saving to wiki...",
    done: savedLabel,
    error: "Failed",
  }[task.status]

  async function handleOpenSaved() {
    if (!project || !task.savedPath) return
    const path = `${normalizePath(project.path)}/${task.savedPath}`
    try {
      const content = await readFile(path)
      setSelectedFile(path)
      setFileContent(content)
    } catch {
      // ignore
    }
  }

  return (
    <div className="rounded-lg border text-xs">
      {/* Header */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-accent/50"
      >
        {expanded ? (
          <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />
        )}
        {statusIcon}
        <span className="flex-1 truncate font-medium">{task.topic}</span>
        <span className="shrink-0 text-muted-foreground">{statusText}</span>
      </button>

      {/* Expanded content */}
      {expanded && (
        <div className="border-t px-3 py-2">
          {/* Error */}
          {task.error && (
            <p className="mb-2 text-destructive">{task.error}</p>
          )}

          {/* Web results */}
          {task.webResults.length > 0 && (
            <div className="mb-2">
              <div className="mb-1 font-medium text-muted-foreground">
                Sources ({task.webResults.length})
              </div>
              <div className="flex flex-col gap-1">
                {task.webResults.map((r, i) => (
                  <div key={i} className="flex items-start gap-1.5 rounded bg-muted/50 px-2 py-1">
                    <span className="shrink-0 font-mono text-muted-foreground">[{i + 1}]</span>
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium">{r.title}</div>
                      <div className="truncate text-muted-foreground">{r.source}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Research result (streaming) */}
          {task.synthesis && (
            <ResearchResultBlock synthesis={task.synthesis} isStreaming={task.status === "synthesizing"} />
          )}

          {/* Actions */}
          <div className="flex items-center gap-1.5 mt-2">
            {task.savedPath && (
              <Button variant="outline" size="sm" className="h-6 text-[11px] gap-1" onClick={handleOpenSaved}>
                <FileText className="h-3 w-3" />
                Open
              </Button>
            )}
            {(task.status === "done" || task.status === "error") && (
              <Button
                variant="ghost"
                size="sm"
                className="h-6 text-[11px] gap-1 text-muted-foreground"
                onClick={() => onRemove(task.id)}
              >
                <X className="h-3 w-3" />
                Remove
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

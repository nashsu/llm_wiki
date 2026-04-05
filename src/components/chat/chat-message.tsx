import { useCallback, useEffect, useRef, useState, useMemo } from "react"
import ReactMarkdown from "react-markdown"
import { Bot, User, FileText, Paperclip } from "lucide-react"
import { useWikiStore } from "@/stores/wiki-store"
import { readFile, listDirectory } from "@/commands/fs"
import type { DisplayMessage } from "@/stores/chat-store"
import type { FileNode } from "@/types/wiki"

// Module-level cache of source file names
let cachedSourceFiles: string[] = []

export function useSourceFiles() {
  const project = useWikiStore((s) => s.project)

  useEffect(() => {
    if (!project) return
    listDirectory(`${project.path}/raw/sources`)
      .then((tree) => {
        cachedSourceFiles = flattenNames(tree)
      })
      .catch(() => {
        cachedSourceFiles = []
      })
  }, [project])

  return cachedSourceFiles
}

function flattenNames(nodes: FileNode[]): string[] {
  const names: string[] = []
  for (const node of nodes) {
    if (node.is_dir && node.children) {
      names.push(...flattenNames(node.children))
    } else if (!node.is_dir) {
      names.push(node.name)
    }
  }
  return names
}

interface ChatMessageProps {
  message: DisplayMessage
}

export function ChatMessage({ message }: ChatMessageProps) {
  const isUser = message.role === "user"
  const isSystem = message.role === "system"

  return (
    <div className={`flex gap-2 ${isUser ? "flex-row-reverse" : "flex-row"}`}>
      <div
        className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${
          isSystem
            ? "bg-accent text-accent-foreground"
            : isUser
              ? "bg-primary text-primary-foreground"
              : "bg-muted text-muted-foreground"
        }`}
      >
        {isUser ? <User className="h-4 w-4" /> : <Bot className="h-4 w-4" />}
      </div>
      <div
        className={`max-w-[80%] rounded-lg px-3 py-2 text-sm ${
          isUser
            ? "bg-primary text-primary-foreground"
            : "bg-muted text-foreground"
        }`}
      >
        {isUser ? (
          <p className="whitespace-pre-wrap break-words">{message.content}</p>
        ) : (
          <MarkdownContent content={message.content} />
        )}
      </div>
    </div>
  )
}

interface StreamingMessageProps {
  content: string
}

export function StreamingMessage({ content }: StreamingMessageProps) {
  return (
    <div className="flex gap-2 flex-row">
      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <Bot className="h-4 w-4" />
      </div>
      <div className="max-w-[80%] rounded-lg px-3 py-2 text-sm bg-muted text-foreground">
        <MarkdownContent content={content} />
        <span className="animate-pulse">▊</span>
      </div>
    </div>
  )
}

function MarkdownContent({ content }: { content: string }) {
  const sourceFiles = cachedSourceFiles

  // Process the content: replace [[wikilinks]], @filename, and bare source filenames
  const processed = useMemo(
    () => processContent(content, sourceFiles),
    [content, sourceFiles]
  )

  return (
    <div className="chat-markdown prose prose-sm max-w-none dark:prose-invert prose-p:my-1 prose-headings:my-2 prose-ul:my-1 prose-ol:my-1 prose-li:my-0 prose-pre:my-2 prose-code:text-xs prose-code:before:content-none prose-code:after:content-none">
      <ReactMarkdown
        components={{
          a: ({ href, children }) => {
            if (href?.startsWith("wikilink:")) {
              const pageName = href.slice("wikilink:".length)
              return <WikiLink pageName={pageName}>{children}</WikiLink>
            }
            if (href?.startsWith("sourceref:")) {
              const fileName = href.slice("sourceref:".length)
              return <SourceRef fileName={fileName} />
            }
            return (
              <span className="text-primary underline cursor-default" title={href}>
                {children}
              </span>
            )
          },
          pre: ({ children, ...props }) => (
            <pre className="rounded bg-background/50 p-2 text-xs overflow-x-auto" {...props}>{children}</pre>
          ),
        }}
      >
        {processed}
      </ReactMarkdown>
    </div>
  )
}

/**
 * Process content to create clickable links:
 * 1. [[wikilinks]] → markdown links with wikilink: protocol
 * 2. @filename → markdown links with sourceref: protocol
 * 3. Bare source filenames mentioned in text → markdown links with sourceref: protocol
 */
function processContent(text: string, sourceFiles: string[]): string {
  // Step 1: Process [[wikilinks]]
  let result = text.replace(
    /\[\[([^\]|]+?)(?:\|([^\]]+?))?\]\]/g,
    (_match, pageName: string, displayText?: string) => {
      const display = displayText?.trim() || pageName.trim()
      return `[${display}](wikilink:${pageName.trim()})`
    }
  )

  // Step 2: Process @filename (with or without extension)
  result = result.replace(
    /@([\w.+\-]+)/g,
    (_match, name: string) => {
      return `[@${name}](sourceref:${name})`
    }
  )

  // Step 3: Replace bare source filenames that appear in the text
  // Sort by length (longest first) to avoid partial matches
  const sortedFiles = [...sourceFiles].sort((a, b) => b.length - a.length)
  for (const fileName of sortedFiles) {
    // Skip if already inside a markdown link
    // Use a regex that matches the filename but not inside []() syntax
    const escaped = fileName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    const pattern = new RegExp(`(?<!\\]\\(sourceref:)(?<!\\[@?)\\b(${escaped})\\b`, "g")
    result = result.replace(pattern, `[@$1](sourceref:$1)`)
  }

  return result
}

function SourceRef({ fileName }: { fileName: string }) {
  const project = useWikiStore((s) => s.project)
  const setSelectedFile = useWikiStore((s) => s.setSelectedFile)
  const setFileContent = useWikiStore((s) => s.setFileContent)
  const setActiveView = useWikiStore((s) => s.setActiveView)

  const handleClick = useCallback(async (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (!project) return

    // Try exact match first, then search with the name as given
    const candidates = [
      `${project.path}/raw/sources/${fileName}`,
    ]

    // If fileName has no extension, try to find a matching file
    if (!fileName.includes(".")) {
      for (const sf of cachedSourceFiles) {
        const stem = sf.replace(/\.[^.]+$/, "")
        if (stem === fileName || sf.startsWith(fileName)) {
          candidates.unshift(`${project.path}/raw/sources/${sf}`)
        }
      }
    }

    setActiveView("wiki")

    for (const path of candidates) {
      try {
        const content = await readFile(path)
        setSelectedFile(path)
        setFileContent(content)
        return
      } catch {
        // try next
      }
    }

    // Fallback: just set the path even if we can't read it
    setSelectedFile(candidates[0])
    setFileContent(`Unable to load: ${fileName}`)
  }, [project, fileName, setSelectedFile, setFileContent, setActiveView])

  return (
    <button
      type="button"
      onClick={handleClick}
      className="inline-flex items-center gap-0.5 rounded bg-accent/50 px-1.5 py-0.5 text-xs font-medium text-primary hover:bg-accent transition-colors"
      title={`Open source: ${fileName}`}
    >
      <Paperclip className="inline h-3 w-3" />
      {fileName}
    </button>
  )
}

function WikiLink({ pageName, children }: { pageName: string; children: React.ReactNode }) {
  const project = useWikiStore((s) => s.project)
  const setSelectedFile = useWikiStore((s) => s.setSelectedFile)
  const setFileContent = useWikiStore((s) => s.setFileContent)
  const setActiveView = useWikiStore((s) => s.setActiveView)
  const [exists, setExists] = useState<boolean | null>(null)
  const resolvedPath = useRef<string | null>(null)

  useEffect(() => {
    if (!project) return
    const candidates = [
      `${project.path}/wiki/entities/${pageName}.md`,
      `${project.path}/wiki/concepts/${pageName}.md`,
      `${project.path}/wiki/sources/${pageName}.md`,
      `${project.path}/wiki/queries/${pageName}.md`,
      `${project.path}/wiki/comparisons/${pageName}.md`,
      `${project.path}/wiki/synthesis/${pageName}.md`,
      `${project.path}/wiki/${pageName}.md`,
    ]

    let cancelled = false
    async function check() {
      for (const path of candidates) {
        try {
          await readFile(path)
          if (!cancelled) {
            resolvedPath.current = path
            setExists(true)
          }
          return
        } catch {
          // try next
        }
      }
      if (!cancelled) setExists(false)
    }
    check()
    return () => { cancelled = true }
  }, [project, pageName])

  const handleClick = useCallback(async () => {
    if (!resolvedPath.current) return
    try {
      const content = await readFile(resolvedPath.current)
      setSelectedFile(resolvedPath.current)
      setFileContent(content)
      setActiveView("wiki")
    } catch {
      // ignore
    }
  }, [setSelectedFile, setFileContent, setActiveView])

  if (exists === false) {
    return (
      <span className="inline text-muted-foreground" title={`Page not found: ${pageName}`}>
        {children}
      </span>
    )
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      className="inline-flex items-center gap-0.5 rounded px-1 py-0.5 text-primary underline decoration-primary/30 hover:bg-primary/10 hover:decoration-primary"
      title={`Open wiki page: ${pageName}`}
    >
      <FileText className="inline h-3 w-3" />
      {children}
    </button>
  )
}

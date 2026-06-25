import { useEffect, useMemo, useRef, useState } from "react"
import { convertFileSrc } from "@tauri-apps/api/core"
import { openPath } from "@tauri-apps/plugin-opener"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import remarkMath from "remark-math"
import rehypeKatex from "rehype-katex"
import "katex/dist/katex.min.css"
import {
  FileText,
  Image as ImageIcon,
  Film,
  Music,
  FileSpreadsheet,
  FileQuestion,
  Code2,
  ExternalLink,
  RefreshCw,
  Maximize2,
  Minus,
  Plus,
  X,
} from "lucide-react"
import { useTranslation } from "react-i18next"
import {
  getFileCategory,
  getCodeLanguage,
  getFileExtension,
  isExtractedTextPreviewFile,
} from "@/lib/file-types"
import type { FileCategory } from "@/lib/file-types"
import { getFileName, normalizePath } from "@/lib/path-utils"
import { resolveMarkdownImageSrc } from "@/lib/markdown-image-resolver"
import { transformImageEmbeds } from "@/lib/wikilink-transform"
import { detectLanguage } from "@/lib/detect-language"
import { getHtmlLang, getTextDirection } from "@/lib/language-metadata"
import { parseFrontmatter } from "@/lib/frontmatter"
import { FrontmatterPanel } from "@/components/editor/frontmatter-panel"
import { useWikiStore } from "@/stores/wiki-store"
import { MermaidDiagram, unwrapMermaidPre } from "@/components/mermaid-diagram"
import { FileHistoryButton } from "@/components/editor/file-history-panel"

interface FilePreviewProps {
  filePath: string
  textContent: string
}

export function FilePreview({ filePath, textContent }: FilePreviewProps) {
  return <div className="relative h-full min-h-0">
    <FilePreviewContent filePath={filePath} textContent={textContent} />
    <FileHistoryButton filePath={filePath} currentContent={textContent} />
  </div>
}

function FilePreviewContent({ filePath, textContent }: FilePreviewProps) {
  const category = getFileCategory(filePath)
  const fileName = getFileName(filePath)
  const extension = getFileExtension(filePath)

  switch (category) {
    case "image":
      return <ImagePreview filePath={filePath} fileName={fileName} />
    case "video":
      return <VideoPreview filePath={filePath} fileName={fileName} />
    case "audio":
      return <AudioPreview filePath={filePath} fileName={fileName} />
    case "pdf":
      return <PdfPreview filePath={filePath} content={textContent} />
    case "code":
      if (extension === "mmd" || extension === "mermaid") {
        return <StandaloneMermaidPreview filePath={filePath} content={textContent} />
      }
      if (extension === "svg" && isAgentWorkspacePath(filePath)) {
        return <ImagePreview filePath={filePath} fileName={fileName} />
      }
      if (extension === "html" || extension === "htm") {
        return <HtmlPreview filePath={filePath} fileName={fileName} content={textContent} />
      }
      return <CodePreview filePath={filePath} content={textContent} />
    case "data":
      if (extension === "csv" || extension === "tsv") {
        return <DelimitedTablePreview filePath={filePath} content={textContent} delimiter={extension === "tsv" ? "\t" : ","} />
      }
      return <CodePreview filePath={filePath} content={textContent} />
    case "text":
      return <TextPreview filePath={filePath} content={textContent} label="Text" />
    case "document":
      if (isExtractedTextPreviewFile(filePath)) {
        return <TextPreview filePath={filePath} content={textContent} label={extractedTextLabel(filePath)} />
      }
      return <BinaryPlaceholder filePath={filePath} fileName={fileName} category={category} />
    default:
      return <BinaryPlaceholder filePath={filePath} fileName={fileName} category={category} />
  }
}

function PdfPreview({ filePath, content }: { filePath: string; content: string }) {
  const { t } = useTranslation()
  const [showText, setShowText] = useState(false)
  const [page, setPage] = useState(1)
  const [zoom, setZoom] = useState(100)
  const src = `${convertFileSrc(filePath)}#page=${page}&zoom=${zoom}`
  return <div className="flex h-full min-h-0 flex-col p-4">
    <div className="mb-2 flex items-center gap-1.5 text-xs text-muted-foreground">
      <span className="min-w-0 flex-1 truncate" title={filePath}>{filePath}</span>
      <button type="button" className="rounded border px-2 py-1 hover:bg-muted" onClick={() => setShowText((value) => !value)}>{showText ? t("preview.pdfDocument") : t("preview.pdfText")}</button>
      {!showText && <><button type="button" className="rounded p-1 hover:bg-muted" onClick={() => setZoom((value) => Math.max(50, value - 25))}><Minus className="h-3.5 w-3.5" /></button><span className="w-10 text-center">{zoom}%</span><button type="button" className="rounded p-1 hover:bg-muted" onClick={() => setZoom((value) => Math.min(300, value + 25))}><Plus className="h-3.5 w-3.5" /></button><label className="ml-1 flex items-center gap-1">{t("preview.pdfPage")}<input value={page} min={1} type="number" onChange={(event) => setPage(Math.max(1, Number(event.target.value) || 1))} className="w-14 rounded border bg-background px-1 py-0.5" /></label></>}
    </div>
    <div className="min-h-0 flex-1 overflow-hidden rounded-md border bg-white">
      {showText ? <TextPreview filePath={filePath} content={content} label="PDF text" /> : <object key={src} data={src} type="application/pdf" className="h-full w-full"><iframe title={filePath} src={src} className="h-full w-full" /></object>}
    </div>
  </div>
}

export function parseDelimitedContent(content: string, delimiter: string, maxRows = 500): string[][] {
  const rows: string[][] = []
  let cells: string[] = []
  let current = ""
  let quoted = false
  const normalized = content.replace(/\r\n/g, "\n")
  for (let index = 0; index < normalized.length && rows.length < maxRows; index += 1) {
    const char = normalized[index]
    if (char === '"') {
      if (quoted && normalized[index + 1] === '"') { current += '"'; index += 1 } else quoted = !quoted
    } else if (char === delimiter && !quoted) { cells.push(current); current = "" } else current += char
    if (char === "\n" && !quoted) {
      current = current.slice(0, -1)
      cells.push(current); rows.push(cells); cells = []; current = ""
    }
  }
  if ((current || cells.length > 0) && rows.length < maxRows) { cells.push(current); rows.push(cells) }
  return rows
}

function DelimitedTablePreview({ filePath, content, delimiter }: { filePath: string; content: string; delimiter: string }) {
  const rows = useMemo(() => parseDelimitedContent(content, delimiter), [content, delimiter])
  return <div className="h-full overflow-auto p-4"><div className="mb-2 text-xs text-muted-foreground">{filePath}</div><table className="min-w-full border-collapse text-xs"><thead className="sticky top-0 bg-muted">{rows[0] && <tr>{rows[0].map((cell, index) => <th key={index} className="border px-2 py-1 text-left">{cell}</th>)}</tr>}</thead><tbody>{rows.slice(1).map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, cellIndex) => <td key={cellIndex} className="max-w-80 border px-2 py-1 align-top">{cell}</td>)}</tr>)}</tbody></table></div>
}

function HtmlPreview({
  filePath,
  fileName,
  content,
}: {
  filePath: string
  fileName: string
  content: string
}) {
  const { t } = useTranslation()
  const src = convertFileSrc(filePath)
  const [showSource, setShowSource] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)
  return (
    <div className="flex h-full flex-col p-4" data-preview-kind="html">
      <div className="mb-3 flex items-center gap-1.5 text-xs text-muted-foreground">
        <span className="min-w-0 flex-1 truncate" title={filePath}>{filePath}</span>
        <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase">HTML</span>
        <button
          type="button"
          onClick={() => setShowSource((current) => !current)}
          className="rounded p-1 hover:bg-accent hover:text-foreground"
          title={showSource ? t("preview.showRendered") : t("preview.showSource")}
          aria-label={showSource ? t("preview.showRendered") : t("preview.showSource")}
        >
          <Code2 className="h-3.5 w-3.5" />
        </button>
        {!showSource && (
          <button
            type="button"
            onClick={() => setReloadKey((current) => current + 1)}
            className="rounded p-1 hover:bg-accent hover:text-foreground"
            title={t("preview.reload")}
            aria-label={t("preview.reload")}
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
        )}
        <button
          type="button"
          onClick={() => void openPath(filePath)}
          className="rounded p-1 hover:bg-accent hover:text-foreground"
          title={t("preview.openWithSystem")}
          aria-label={t("preview.openWithSystem")}
        >
          <ExternalLink className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden rounded-lg border border-border bg-background">
        {showSource ? (
          <pre className="h-full overflow-auto whitespace-pre-wrap break-words p-4 font-mono text-xs">
            {content}
          </pre>
        ) : (
          <iframe
            key={reloadKey}
            title={fileName}
            src={src}
            className="h-full w-full bg-white"
            // Generated HTML is untrusted Agent output. Scripts are useful for
            // interactive reports, but same-origin access stays disabled so the
            // document cannot reach the parent DOM or authenticated app APIs.
            sandbox="allow-scripts"
            referrerPolicy="no-referrer"
          />
        )}
      </div>
    </div>
  )
}

function StandaloneMermaidPreview({ filePath, content }: { filePath: string; content: string }) {
  return (
    <div className="flex h-full min-h-0 flex-col overflow-auto p-6" data-preview-kind="mermaid">
      <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
        <span className="min-w-0 flex-1 truncate" title={filePath}>{filePath}</span>
        <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase">Mermaid</span>
      </div>
      <MermaidDiagram code={content} />
    </div>
  )
}

function isAgentWorkspacePath(filePath: string): boolean {
  return normalizePath(filePath).split("/").includes("agent-workspace")
}

function extractedTextLabel(filePath: string): string {
  switch (getFileExtension(filePath)) {
    case "doc":
      return "Word DOC (extracted text)"
    case "docx":
      return "Word DOCX (extracted text)"
    case "pptx":
      return "PowerPoint (extracted text)"
    case "xls":
    case "xlsx":
      return "Spreadsheet (extracted text)"
    case "odt":
    case "ods":
    case "odp":
      return "OpenDocument (extracted text)"
    default:
      return "Extracted text"
  }
}

function ImagePreview({ filePath, fileName }: { filePath: string; fileName: string }) {
  const src = convertFileSrc(filePath)
  const [expanded, setExpanded] = useState(false)
  const [zoom, setZoom] = useState(1)
  return (
    <div className="flex h-full flex-col p-6">
      <div className="mb-4 flex items-center gap-2 text-xs text-muted-foreground"><span className="min-w-0 flex-1 truncate">{filePath}</span><button type="button" onClick={() => setExpanded(true)} className="rounded p-1 hover:bg-muted"><Maximize2 className="h-4 w-4" /></button></div>
      <div className="flex flex-1 items-center justify-center overflow-auto rounded-lg bg-muted/30">
        <img
          src={src}
          alt={fileName}
          className="max-h-full max-w-full object-contain"
        />
      </div>
      {expanded && <div className="fixed inset-0 z-[100] flex flex-col bg-background/95 p-4 backdrop-blur-sm"><div className="flex justify-end gap-1"><button type="button" className="rounded p-2 hover:bg-muted" onClick={() => setZoom((value) => Math.max(.25, value - .25))}><Minus className="h-4 w-4" /></button><button type="button" className="rounded p-2 hover:bg-muted" onClick={() => setZoom((value) => Math.min(5, value + .25))}><Plus className="h-4 w-4" /></button><button type="button" className="rounded p-2 hover:bg-muted" onClick={() => setExpanded(false)}><X className="h-4 w-4" /></button></div><div className="min-h-0 flex-1 overflow-auto text-center"><img src={src} alt={fileName} className="mx-auto max-w-none object-contain" style={{ width: `${zoom * 100}%` }} /></div></div>}
    </div>
  )
}

function VideoPreview({ filePath, fileName }: { filePath: string; fileName: string }) {
  const src = convertFileSrc(filePath)
  return (
    <div className="flex h-full flex-col p-6">
      <div className="mb-4 text-xs text-muted-foreground">{filePath}</div>
      <div className="flex flex-1 items-center justify-center overflow-auto rounded-lg bg-black">
        <video
          src={src}
          controls
          className="max-h-full max-w-full"
        >
          <track kind="captions" label={fileName} />
        </video>
      </div>
    </div>
  )
}

function AudioPreview({ filePath, fileName }: { filePath: string; fileName: string }) {
  const src = convertFileSrc(filePath)
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 p-6">
      <div className="text-xs text-muted-foreground">{filePath}</div>
      <Music className="h-16 w-16 text-muted-foreground/50" />
      <p className="text-sm font-medium">{fileName}</p>
      <audio src={src} controls className="w-full max-w-md">
        <track kind="captions" label={fileName} />
      </audio>
    </div>
  )
}

function CodePreview({ filePath, content }: { filePath: string; content: string }) {
  const lang = getCodeLanguage(filePath)
  return (
    <div className="h-full overflow-auto p-6">
      <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
        <span>{filePath}</span>
        <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase">{lang}</span>
      </div>
      <pre className="whitespace-pre-wrap rounded-lg bg-muted/30 p-4 font-mono text-sm">
        {content}
      </pre>
    </div>
  )
}

function TextPreview({ filePath, content, label }: { filePath: string; content: string; label: string }) {
  const projectPath = useWikiStore((s) => s.project?.path ?? null)
  const pendingScrollImageSrc = useWikiStore((s) => s.pendingScrollImageSrc)
  const setPendingScrollImageSrc = useWikiStore((s) => s.setPendingScrollImageSrc)
  const scrollRootRef = useRef<HTMLDivElement | null>(null)

  const { frontmatter, body } = useMemo(() => parseFrontmatter(content), [content])
  // Rewrite Obsidian image embeds (`![[…]]`) into standard markdown
  // so raw-source previews (e.g. skill-exported docs) actually show
  // their images instead of dumping the embed syntax as text.
  const renderBody = useMemo(() => transformImageEmbeds(body), [body])
  // Directory of this file (project-absolute) so relative image
  // references (`../assets/x.png`) resolve against the file's own
  // location, Obsidian-style.
  const currentFileDir = useMemo(() => {
    const norm = normalizePath(filePath)
    const dir = norm.slice(0, norm.lastIndexOf("/"))
    return dir || null
  }, [filePath])
  const renderLanguage = useMemo(() => detectLanguage(body), [body])
  const direction = getTextDirection(renderLanguage)
  const htmlLang = getHtmlLang(renderLanguage)

  // Consume `pendingScrollImageSrc` once the file has rendered.
  // We re-scan the DOM whenever:
  //   - file content changes (different page just loaded), OR
  //   - the pending target changes (user clicked a different image)
  // Image loading is async, so we also subscribe to `load` events
  // and rescroll once the actual layout settles — the first
  // `scrollIntoView` lands on a 0-height placeholder otherwise.
  useEffect(() => {
    if (!pendingScrollImageSrc) return
    const root = scrollRootRef.current
    if (!root) return
    // Match by `data-mdsrc` (literal markdown URL) — the post-
    // resolver `src` is a tauri:// URL we don't want to bake into
    // the search-result data.
    // Inline-escape `"` and `\` for the attribute-VALUE position
    // of a CSS selector (CSS.escape is for IDENTIFIER context and
    // would over-escape here). Image URLs can in principle contain
    // either, so doing this is correctness, not paranoia.
    const escapedSrc = pendingScrollImageSrc
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
    const target = root.querySelector<HTMLImageElement>(
      `img[data-mdsrc="${escapedSrc}"]`,
    )
    if (!target) {
      // Page may not actually contain this image — clear the
      // pending so a future page-open doesn't get an unexpected
      // scroll. Fail silently: the user navigated, we just don't
      // know where to send them.
      setPendingScrollImageSrc(null)
      return
    }
    // Initial scroll. The image may not have loaded its bytes yet
    // (lazy loading + remote PNG decode) so this lands on a
    // 0-height box. After load, recompute.
    target.scrollIntoView({ behavior: "auto", block: "center" })
    if (!target.complete) {
      const onLoad = () => {
        target.scrollIntoView({ behavior: "smooth", block: "center" })
        target.removeEventListener("load", onLoad)
      }
      target.addEventListener("load", onLoad)
    }
    // Briefly highlight the target so the user sees where they
    // landed — the page might be long and the image might be in
    // a section visually similar to its neighbors.
    target.classList.add("ring-2", "ring-primary", "ring-offset-2")
    const tHighlight = setTimeout(() => {
      target.classList.remove("ring-2", "ring-primary", "ring-offset-2")
    }, 1800)
    setPendingScrollImageSrc(null)
    return () => clearTimeout(tHighlight)
  }, [pendingScrollImageSrc, content, setPendingScrollImageSrc])

  return (
    <div ref={scrollRootRef} className="h-full overflow-auto p-6">
      <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
        <span>{filePath}</span>
        <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase">{label}</span>
      </div>
      {frontmatter && <FrontmatterPanel data={frontmatter} />}
      <div
        className="prose prose-sm max-w-none dark:prose-invert"
        dir={direction}
        lang={htmlLang}
        style={{ textAlign: "start" }}
      >
        <ReactMarkdown
          remarkPlugins={[remarkGfm, remarkMath]}
          rehypePlugins={[rehypeKatex]}
          components={{
            // Resolve `![](media/...)` references generated by the
            // ingest image-extraction step. Without this, the
            // browser tries to load `media/...` relative to the
            // webview origin and silently 404s.
            //
            // `data-mdsrc` preserves the ORIGINAL markdown URL
            // (pre-resolver) so the search-result jump-to-image
            // path can find the rendered <img> by its source-of-
            // truth identifier rather than the resolved tauri://
            // URL (which differs per platform).
            img: ({ src, alt, ...props }) => (
              <img
                src={typeof src === "string" ? resolveMarkdownImageSrc(src, projectPath, currentFileDir) : undefined}
                data-mdsrc={typeof src === "string" ? src : undefined}
                alt={alt ?? ""}
                className="max-w-full rounded border border-border/40 transition-all"
                loading="lazy"
                {...props}
              />
            ),
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
          {renderBody}
        </ReactMarkdown>
      </div>
    </div>
  )
}

function BinaryPlaceholder({
  filePath,
  fileName,
  category,
}: {
  filePath: string
  fileName: string
  category: FileCategory
}) {
  const { t } = useTranslation()
  const [text, setText] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const iconMap: Record<string, typeof FileText> = {
    document: FileSpreadsheet,
    unknown: FileQuestion,
    image: ImageIcon,
    video: Film,
  }
  const Icon = iconMap[category] ?? FileQuestion

  if (text !== null) {
    return <CodePreview filePath={filePath} content={text} />
  }

  const viewAsText = async () => {
    setLoading(true)
    setLoadError(null)
    try {
      // read_file is size-bounded on the Rust side. The explicit user action is
      // the opt-in for long-tail text formats; decoding failures remain visible
      // here instead of being mistaken for an empty file.
      const { readFile } = await import("@/commands/fs")
      setText(await readFile(filePath))
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 p-6 text-center">
      <Icon className="h-16 w-16 text-muted-foreground/30" />
      <div>
        <p className="text-sm font-medium">{fileName}</p>
        <p className="mt-1 text-xs text-muted-foreground">{filePath}</p>
      </div>
      <p className="text-sm text-muted-foreground">
        {t("preview.notAvailable")}
      </p>
      <div className="flex flex-wrap items-center justify-center gap-2">
        <button
          type="button"
          onClick={() => void viewAsText()}
          disabled={loading}
          className="rounded-md border border-border bg-background px-3 py-1.5 text-xs hover:bg-accent disabled:opacity-50"
        >
          {loading ? t("preview.loadingText") : t("preview.viewAsText")}
        </button>
        <button
          type="button"
          onClick={() => void openPath(filePath)}
          className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-3 py-1.5 text-xs hover:bg-accent"
        >
          <ExternalLink className="h-3.5 w-3.5" />
          {t("preview.openWithSystem")}
        </button>
      </div>
      {loadError && <p className="max-w-lg text-xs text-destructive">{loadError}</p>}
    </div>
  )
}

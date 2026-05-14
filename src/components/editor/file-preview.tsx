import { useEffect, useMemo, useRef } from "react"
import { convertFileSrc } from "@tauri-apps/api/core"
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
} from "lucide-react"
import { getFileCategory, getCodeLanguage } from "@/lib/file-types"
import type { FileCategory } from "@/lib/file-types"
import { getFileName } from "@/lib/path-utils"
import { resolveMarkdownImageSrc } from "@/lib/markdown-image-resolver"
import { detectLanguage } from "@/lib/detect-language"
import { getHtmlLang, getTextDirection } from "@/lib/language-metadata"
import { parseFrontmatter } from "@/lib/frontmatter"
import { FrontmatterPanel } from "@/components/editor/frontmatter-panel"
import { useWikiStore } from "@/stores/wiki-store"
import { MermaidDiagram, unwrapMermaidPre } from "@/components/mermaid-diagram"

interface FilePreviewProps {
  filePath: string
  textContent: string
}

export function FilePreview({ filePath, textContent }: FilePreviewProps) {
  const category = getFileCategory(filePath)
  const fileName = getFileName(filePath)

  switch (category) {
    case "image":
      return <ImagePreview filePath={filePath} fileName={fileName} />
    case "video":
      return <VideoPreview filePath={filePath} fileName={fileName} />
    case "audio":
      return <AudioPreview filePath={filePath} fileName={fileName} />
    case "html":
      return <HtmlPreview filePath={filePath} content={textContent} />
    case "pdf":
      return <TextPreview filePath={filePath} content={textContent} label="PDF (extracted text)" />
    case "code":
      return <CodePreview filePath={filePath} content={textContent} />
    case "data":
      return <CodePreview filePath={filePath} content={textContent} />
    case "text":
      return <TextPreview filePath={filePath} content={textContent} label="Text" />
    case "document":
      return <BinaryPlaceholder filePath={filePath} fileName={fileName} category={category} />
    default:
      return <BinaryPlaceholder filePath={filePath} fileName={fileName} category={category} />
  }
}

function ImagePreview({ filePath, fileName }: { filePath: string; fileName: string }) {
  const src = convertFileSrc(filePath)
  return (
    <div className="flex h-full flex-col p-6">
      <div className="mb-4 text-xs text-muted-foreground">{filePath}</div>
      <div className="flex flex-1 items-center justify-center overflow-auto rounded-lg bg-muted/30">
        <img
          src={src}
          alt={fileName}
          className="max-h-full max-w-full object-contain"
        />
      </div>
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
                src={typeof src === "string" ? resolveMarkdownImageSrc(src, projectPath) : undefined}
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
          {body}
        </ReactMarkdown>
      </div>
    </div>
  )
}

function HtmlPreview({ filePath, content }: { filePath: string; content: string }) {
  const iframeRef = useRef<HTMLIFrameElement>(null)

  useEffect(() => {
    const iframe = iframeRef.current
    if (!iframe) return
    const doc = iframe.contentDocument
    if (!doc) return
    doc.open()
    doc.write(content)
    doc.close()
  }, [content])

  return (
    <div className="flex h-full flex-col">
      <div className="shrink-0 border-b px-6 py-2 text-xs text-muted-foreground">
        {filePath}
        <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase">HTML</span>
      </div>
      <iframe
        ref={iframeRef}
        sandbox="allow-same-origin"
        className="flex-1 w-full border-0"
        title="HTML Preview"
      />
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
  const iconMap: Record<string, typeof FileText> = {
    document: FileSpreadsheet,
    unknown: FileQuestion,
    image: ImageIcon,
    video: Film,
  }
  const Icon = iconMap[category] ?? FileQuestion

  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 p-6 text-center">
      <Icon className="h-16 w-16 text-muted-foreground/30" />
      <div>
        <p className="text-sm font-medium">{fileName}</p>
        <p className="mt-1 text-xs text-muted-foreground">{filePath}</p>
      </div>
      <p className="text-sm text-muted-foreground">
        Preview not available for this file type
      </p>
    </div>
  )
}

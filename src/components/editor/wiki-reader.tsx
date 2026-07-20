import { useMemo } from "react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import remarkMath from "remark-math"
import rehypeKatex from "rehype-katex"
import "katex/dist/katex.min.css"
import { transformImageEmbeds, transformWikilinks } from "@/lib/wikilink-transform"
import { resolveRelatedSlug } from "@/lib/wiki-page-resolver"
import { resolveMarkdownImageSrc } from "@/lib/markdown-image-resolver"
import { normalizePath } from "@/lib/path-utils"
import { detectLanguage } from "@/lib/detect-language"
import { getHtmlLang, getTextDirection } from "@/lib/language-metadata"
import { useWikiStore } from "@/stores/wiki-store"
import { MermaidDiagram, unwrapMermaidPre } from "@/components/mermaid-diagram"

interface WikiReaderProps {
  body: string
  /** Original, untransformed Markdown body used for DOM-to-source mapping. */
  sourceBody?: string
  /** Character offset where sourceBody begins in the full Markdown file. */
  sourceOffset?: number
  /**
   * Absolute path of the markdown file being rendered. Used to
   * resolve relative image references against the file's own
   * directory (Obsidian-style), so e.g. `../assets/x.png` works.
   * Optional — when omitted, image paths fall back to wiki-root
   * resolution.
   */
  filePath?: string
}

/**
 * Read-only render of a wiki page body. Distinct from WikiEditor
 * (Milkdown WYSIWYG) because Milkdown round-trips the markdown
 * through prosemirror — applying our wikilink → markdown-link
 * pre-processing there would mean the user's saves overwrite the
 * original `[[…]]` source with `[label](#slug)`. Here, since we
 * never serialize back to disk, transforming for display is safe.
 *
 * Wikilink anchor clicks are intercepted: `#slug` is resolved
 * against the project's wiki tree and routed to the wiki preview,
 * giving the user single-click navigation between pages.
 */
export function WikiReader({ body, sourceBody, sourceOffset = 0, filePath }: WikiReaderProps) {
  const project = useWikiStore((s) => s.project)
  const projectPathIndex = useWikiStore((s) => s.projectPathIndex)
  const openPathInPreview = useWikiStore((s) => s.openPathInPreview)

  // Image embeds (`![[…]]`) must be rewritten BEFORE the generic
  // wikilink pass, otherwise the embed target gets mangled into a
  // `#fragment` link.
  const transformed = useMemo(
    () => transformWikilinks(transformImageEmbeds(body)),
    [body],
  )
  const sourceLineStarts = useMemo(() => {
    if (sourceBody === undefined) return null
    const starts = [0]
    for (let index = 0; index < sourceBody.length; index += 1) {
      if (sourceBody.charCodeAt(index) === 10) starts.push(index + 1)
    }
    return starts
  }, [sourceBody])

  const sourceAttrs = (node: unknown): Record<string, number> => {
    if (!sourceLineStarts) return {}
    const position = (node as { position?: { start?: { line?: number }; end?: { line?: number } } } | undefined)?.position
    const startLine = position?.start?.line
    const endLine = position?.end?.line
    if (!startLine || !endLine) return {}
    const start = sourceLineStarts[startLine - 1]
    const end = sourceLineStarts[endLine] ?? sourceBody?.length
    if (start === undefined || end === undefined) return {}
    return { "data-source-start": sourceOffset + start, "data-source-end": sourceOffset + end }
  }
  const renderLanguage = detectLanguage(body)
  const direction = getTextDirection(renderLanguage)
  const htmlLang = getHtmlLang(renderLanguage)
  const projectPath = project ? normalizePath(project.path) : null
  const wikiRoot = projectPath ? `${projectPath}/wiki` : null
  // Directory of the file being rendered (project-absolute), so
  // relative image srcs resolve against it like Obsidian does.
  const currentFileDir = useMemo(() => {
    if (!filePath) return null
    const norm = normalizePath(filePath)
    const dir = norm.slice(0, norm.lastIndexOf("/"))
    return dir || null
  }, [filePath])

  function handleAnchorClick(e: React.MouseEvent<HTMLAnchorElement>, href: string) {
    if (!href.startsWith("#")) return
    e.preventDefault()
    if (!wikiRoot) return
    const slug = (() => {
      try {
        return decodeURIComponent(href.slice(1))
      } catch {
        return href.slice(1)
      }
    })()
    const path = resolveRelatedSlug(projectPathIndex, slug, wikiRoot)
    if (path) openPathInPreview(path)
  }

  return (
    <div
      className="prose prose-invert min-w-0 max-w-none"
      dir={direction}
      lang={htmlLang}
      style={{ textAlign: "start" }}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex]}
        components={{
          p: ({ node, children, ...props }) => <p {...sourceAttrs(node)} {...props}>{children}</p>,
          li: ({ node, children, ...props }) => <li {...sourceAttrs(node)} {...props}>{children}</li>,
          blockquote: ({ node, children, ...props }) => <blockquote {...sourceAttrs(node)} {...props}>{children}</blockquote>,
          a: ({ href, children, ...props }) => {
            const h = typeof href === "string" ? href : ""
            const isWikilink = h.startsWith("#")
            return (
              <a
                href={h || undefined}
                onClick={(e) => isWikilink && handleAnchorClick(e, h)}
                className={
                  isWikilink
                    ? "cursor-pointer text-primary underline decoration-primary/40 underline-offset-2 hover:decoration-primary"
                    : "text-primary underline underline-offset-2"
                }
                {...props}
              >
                {children}
              </a>
            )
          },
          h1: ({ node, children, ...props }) => (
            <h1
              {...sourceAttrs(node)}
              className="mb-4 mt-0 border-b border-border/60 pb-3 text-3xl font-semibold leading-tight tracking-normal text-foreground"
              {...props}
            >
              {children}
            </h1>
          ),
          h2: ({ node, children, ...props }) => (
            <h2
              {...sourceAttrs(node)}
              className="mb-3 mt-8 border-b border-border/40 pb-2 text-2xl font-semibold leading-tight tracking-normal text-foreground"
              {...props}
            >
              {children}
            </h2>
          ),
          h3: ({ node, children, ...props }) => (
            <h3
              {...sourceAttrs(node)}
              className="mb-2 mt-6 text-xl font-semibold leading-snug tracking-normal text-foreground"
              {...props}
            >
              {children}
            </h3>
          ),
          img: ({ src, alt, ...props }) => (
            <img
              src={
                typeof src === "string"
                  ? resolveMarkdownImageSrc(src, projectPath, currentFileDir)
                  : undefined
              }
              data-mdsrc={typeof src === "string" ? src : undefined}
              alt={alt ?? ""}
              className="max-w-full rounded border border-border/40"
              loading="lazy"
              {...props}
            />
          ),
          table: ({ children, ...props }) => (
            <div className="my-2 overflow-x-auto rounded border border-border">
              <table className="w-full border-collapse text-xs" {...props}>
                {children}
              </table>
            </div>
          ),
          thead: ({ children, ...props }) => (
            <thead className="bg-muted" {...props}>
              {children}
            </thead>
          ),
          th: ({ node, children, ...props }) => (
            <th
              {...sourceAttrs(node)}
              className="border border-border/80 bg-muted px-3 py-1.5 text-start font-semibold"
              {...props}
            >
              {children}
            </th>
          ),
          td: ({ node, children, ...props }) => (
            <td {...sourceAttrs(node)} className="border border-border/60 px-3 py-1.5" {...props}>
              {children}
            </td>
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
        {transformed}
      </ReactMarkdown>
    </div>
  )
}

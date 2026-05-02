import { useMemo } from "react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import remarkMath from "remark-math"
import rehypeKatex from "rehype-katex"
import "katex/dist/katex.min.css"
import { transformWikilinks } from "@/lib/wikilink-transform"
import { resolveRelatedSlug } from "@/lib/wiki-page-resolver"
import { resolveMarkdownImageSrc } from "@/lib/markdown-image-resolver"
import { normalizePath } from "@/lib/path-utils"
import { useWikiStore } from "@/stores/wiki-store"
import { MermaidDiagram } from "@/components/mermaid-diagram"

interface WikiReaderProps {
  body: string
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
 * against the project's wiki tree and routed to setSelectedFile,
 * giving the user single-click navigation between pages.
 */
export function WikiReader({ body }: WikiReaderProps) {
  const project = useWikiStore((s) => s.project)
  const fileTree = useWikiStore((s) => s.fileTree)
  const setSelectedFile = useWikiStore((s) => s.setSelectedFile)

  const transformed = useMemo(() => transformWikilinks(body), [body])
  const projectPath = project ? normalizePath(project.path) : null
  const wikiRoot = projectPath ? `${projectPath}/wiki` : null

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
    const path = resolveRelatedSlug(fileTree, slug, wikiRoot)
    if (path) setSelectedFile(path)
  }

  return (
    <div className="prose prose-invert min-w-0 max-w-none">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex]}
        components={{
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
          img: ({ src, alt, ...props }) => (
            <img
              src={
                typeof src === "string"
                  ? resolveMarkdownImageSrc(src, projectPath)
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
          th: ({ children, ...props }) => (
            <th
              className="border border-border/80 bg-muted px-3 py-1.5 text-left font-semibold"
              {...props}
            >
              {children}
            </th>
          ),
          td: ({ children, ...props }) => (
            <td className="border border-border/60 px-3 py-1.5" {...props}>
              {children}
            </td>
          ),
          code: ({ className, children, ...props }) => {
            const lang = className?.replace("language-", "")
            const codeText = String(children).replace(/\n$/, "")
            if (lang === "mermaid") return <MermaidDiagram code={codeText} />
            return <code className={className} {...props}>{children}</code>
          },
        }}
      >
        {transformed}
      </ReactMarkdown>
    </div>
  )
}

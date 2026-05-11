import { Children, isValidElement, useEffect, useRef, useState, type ReactNode } from "react"
import { X, ZoomIn } from "lucide-react"

interface MermaidDiagramProps {
  code: string
}

export function MermaidDiagram({ code }: MermaidDiagramProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [error, setError] = useState<string | null>(null)
  const [svg, setSvg] = useState<string | null>(null)
  const [visible, setVisible] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [scale, setScale] = useState(1)

  // Only render when the diagram scrolls into view
  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setVisible(true)
          observer.disconnect()
        }
      },
      { rootMargin: "200px" },
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [code])

  // Render mermaid SVG once visible
  useEffect(() => {
    if (!visible) return
    let cancelled = false

    async function render() {
      try {
        const mermaid = (await import("mermaid")).default
        mermaid.initialize({
          startOnLoad: false,
          theme: "default",
          securityLevel: "strict",
        })

        const id = `mermaid-${Math.random().toString(36).slice(2, 10)}`
        const { svg: rendered } = await mermaid.render(id, code)
        if (!cancelled) {
          setSvg(rendered)
          setError(null)
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err))
          setSvg(null)
        }
      }
    }

    render()
    return () => { cancelled = true }
  }, [visible, code])

  // Prevent layout shift: compute a stable min-height from code line count
  const estimatedHeight = Math.max(80, code.split("\n").length * 20)

  // Close overlay on Escape
  useEffect(() => {
    if (!expanded) return
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setExpanded(false)
        setScale(1)
      }
    }
    window.addEventListener("keydown", handleKey)
    return () => window.removeEventListener("keydown", handleKey)
  }, [expanded])

  if (error) {
    return (
      <div className="my-2 rounded border border-red-300/60 bg-red-50/50 dark:bg-red-950/20 p-2 text-xs text-red-700 dark:text-red-400">
        <p className="font-medium mb-1">Mermaid 语法错误</p>
        <pre className="whitespace-pre-wrap text-[11px] opacity-70">{error}</pre>
      </div>
    )
  }

  return (
    <>
      <div
        ref={containerRef}
        className="group/diagram relative my-2 overflow-x-auto rounded border border-border/40 bg-muted/20 [&>svg]:mx-auto [&>svg]:max-w-full [&>svg]:h-auto"
        style={{ minHeight: svg ? undefined : estimatedHeight }}
      >
        {svg ? (
          <>
            <button
              type="button"
              onClick={() => setExpanded(true)}
              className="absolute top-2 right-2 z-10 rounded-md bg-background/80 px-1.5 py-1 text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground group-hover/diagram:opacity-100"
              title="放大图表"
            >
              <ZoomIn className="h-4 w-4" />
            </button>
            <div
              className="cursor-zoom-in p-3"
              onClick={() => setExpanded(true)}
              dangerouslySetInnerHTML={{ __html: svg }}
            />
          </>
        ) : visible ? (
          <div className="flex items-center justify-center h-full p-4">
            <span className="text-xs text-muted-foreground animate-pulse">正在渲染图表...</span>
          </div>
        ) : (
          <div className="flex items-center justify-center h-full p-4">
            <span className="text-xs text-muted-foreground/50">图表</span>
          </div>
        )}
      </div>

      {/* Fullscreen overlay */}
      {expanded && svg && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
          onClick={() => { setExpanded(false); setScale(1) }}
        >
          <div
            className="relative h-[90vh] w-[90vw] overflow-auto rounded-lg bg-background border border-border shadow-2xl p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="absolute top-3 right-3 z-10 flex items-center gap-1">
              <button
                type="button"
                onClick={() => setScale((s) => Math.min(s + 0.3, 5))}
                className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
              >
                +
              </button>
              <span className="text-xs text-muted-foreground tabular-nums min-w-[3rem] text-center">{Math.round(scale * 100)}%</span>
              <button
                type="button"
                onClick={() => setScale((s) => Math.max(s - 0.3, 0.3))}
                className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
              >
                −
              </button>
              <button
                type="button"
                onClick={() => { setExpanded(false); setScale(1) }}
                className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div
              className="origin-top-left transition-transform duration-150"
              style={{ transform: `scale(${scale})` }}
              dangerouslySetInnerHTML={{ __html: svg }}
            />
          </div>
        </div>
      )}
    </>
  )
}

export function unwrapMermaidPre(children: ReactNode): ReactNode | null {
  const childNodes = Children.toArray(children)
  if (childNodes.length !== 1) return null
  const child = childNodes[0]
  if (!isValidElement(child)) return null
  return child.type === MermaidDiagram ? child : null
}

import { useEffect, useRef, useState } from "react"

interface MermaidDiagramProps {
  code: string
}

export function MermaidDiagram({ code }: MermaidDiagramProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [error, setError] = useState<string | null>(null)
  const [svg, setSvg] = useState<string | null>(null)

  useEffect(() => {
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
  }, [code])

  if (error) {
    return (
      <div className="my-2 rounded border border-red-300/60 bg-red-50/50 dark:bg-red-950/20 p-2 text-xs text-red-700 dark:text-red-400">
        <p className="font-medium mb-1">Mermaid syntax error</p>
        <pre className="whitespace-pre-wrap text-[11px] opacity-70">{error}</pre>
      </div>
    )
  }

  if (!svg) {
    return (
      <div className="my-2 flex items-center justify-center rounded border border-border/40 bg-muted/30 p-4">
        <span className="text-xs text-muted-foreground animate-pulse">Rendering diagram...</span>
      </div>
    )
  }

  return (
    <div
      ref={containerRef}
      className="my-2 overflow-x-auto rounded border border-border/40 bg-muted/20 p-3 [&>svg]:mx-auto [&>svg]:max-w-full [&>svg]:h-auto"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  )
}

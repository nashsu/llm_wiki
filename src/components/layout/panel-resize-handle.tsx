import { useEffect, useRef } from "react"

const KEYBOARD_STEP = 32
const HANDLE_WIDTH = 6
/** Room kept for the center content, so a panel's handle stays on screen. */
const MIN_CENTER_WIDTH = 120

/** Horizontal space, beside this panel, taken by `others` plus the center and this handle. */
export function panelReserve(others = 0): number {
  return MIN_CENTER_WIDTH + HANDLE_WIDTH + others
}

/** Space a neighbouring panel of `width` takes, including its handle. */
export function panelOuterWidth(width: number): number {
  return width + HANDLE_WIDTH
}

/** Also applied as CSS so a panel still fits after the window shrinks. */
export function panelMaxWidth(reserve: number): string {
  return `calc(100% - ${reserve}px)`
}

export function nextPanelWidth(options: {
  side: "left" | "right"
  startWidth: number
  deltaX: number
  min: number
  containerWidth: number
  reserve: number
}): number {
  const { side, startWidth, deltaX, min, containerWidth, reserve } = options
  const requested = side === "left" ? startWidth + deltaX : startWidth - deltaX
  return Math.max(min, Math.min(containerWidth - reserve, requested))
}

function setBodyResizing(resizing: boolean) {
  document.body.style.cursor = resizing ? "col-resize" : ""
  document.body.style.userSelect = resizing ? "none" : ""
  // GraphView watches this to pause and remount its canvas around a drag.
  if (resizing) document.body.dataset.panelResizing = "true"
  else delete document.body.dataset.panelResizing
}

/**
 * Drag or arrow-key handle for a side panel. Render it as a direct child of
 * the row holding the panel: `side` says which side of the row the panel is on.
 */
export function PanelResizeHandle({
  side,
  width,
  min,
  reserve,
  label,
  onResize,
}: {
  side: "left" | "right"
  width: number
  min: number
  reserve: number
  label: string
  onResize: (width: number) => void
}) {
  const dragRef = useRef<{ x: number; width: number } | null>(null)

  useEffect(() => () => {
    if (dragRef.current) setBodyResizing(false)
  }, [])

  const resize = (element: HTMLElement, startWidth: number, deltaX: number) => {
    onResize(nextPanelWidth({
      side,
      startWidth,
      deltaX,
      min,
      containerWidth: element.parentElement?.clientWidth ?? 0,
      reserve,
    }))
  }

  const endDrag = () => {
    if (!dragRef.current) return
    dragRef.current = null
    setBodyResizing(false)
  }

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={Math.round(width)}
      aria-valuemin={min}
      tabIndex={0}
      className="w-1.5 shrink-0 cursor-col-resize bg-border/40 transition-colors hover:bg-primary/30 focus-visible:bg-primary/40 focus-visible:outline-none active:bg-primary/40"
      onPointerDown={(event) => {
        if (event.button !== 0) return
        event.preventDefault()
        dragRef.current = { x: event.clientX, width }
        // Capture keeps the drag alive over iframes such as file previews.
        event.currentTarget.setPointerCapture(event.pointerId)
        setBodyResizing(true)
      }}
      onPointerMove={(event) => {
        if (!dragRef.current) return
        resize(event.currentTarget, dragRef.current.width, event.clientX - dragRef.current.x)
      }}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onLostPointerCapture={endDrag}
      onKeyDown={(event) => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return
        event.preventDefault()
        resize(event.currentTarget, width, event.key === "ArrowRight" ? KEYBOARD_STEP : -KEYBOARD_STEP)
      }}
    />
  )
}

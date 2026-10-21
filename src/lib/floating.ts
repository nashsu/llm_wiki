import { getCurrentWindow, currentMonitor, PhysicalSize, PhysicalPosition } from "@tauri-apps/api/window"

export type FloatingMode = "full" | "ball" | "chat" | "preview"

export const FULL_WINDOW_SIZE = { width: 1200, height: 800 }
export const BALL_WINDOW_SIZE = { width: 72, height: 72 }
export const CHAT_WINDOW_SIZE = { width: 360, height: 560 }
export const PREVIEW_WINDOW_SIZE = { width: 280, height: 96 }
const CORNER_MARGIN = 16

/** Resolve the right-edge, vertically-centered position on the monitor the
 *  window currently sits on. Falls back to the current position if no monitor
 *  is reported (e.g. tests / non-Tauri env). */
async function rightMiddlePosition(winW: number, winH: number): Promise<PhysicalPosition> {
  const win = getCurrentWindow()
  const current = await win.outerPosition().catch(() => null)
  const monitor = await currentMonitor().catch(() => null)
  if (monitor) {
    return new PhysicalPosition(
      monitor.position.x + monitor.size.width - winW - CORNER_MARGIN,
      monitor.position.y + Math.round((monitor.size.height - winH) / 2),
    )
  }
  // No monitor info (e.g. dev in a normal browser) — keep roughly centered
  // instead of throwing. The callers guard on the Tauri runtime anyway.
  if (current) return current
  return new PhysicalPosition(120, 120)
}

/** Morph the main window between the full app, the floating ball, and the
 *  expanded read-only chat card. All calls no-op if we're not in the Tauri
 *  runtime (e.g. running the Vite dev server in a browser). */
export async function morphWindow(mode: FloatingMode): Promise<void> {
  const tauri = typeof window !== "undefined" && ("__TAURI_INTERNALS__" in window || "__TAURI__" in window)
  if (!tauri) return
  const win = getCurrentWindow()
  const log = (...args: unknown[]) => console.error("[float]", ...args)
  try {
    if (mode === "full") {
      await win.unmaximize().catch(() => {})
      await win.unminimize().catch(() => {})
      await win.setDecorations(true)
      await win.setAlwaysOnTop(false)
      await win.setSkipTaskbar(false)
      await win.setResizable(true)
      await win.setMinSize(new PhysicalSize(600, 400)).catch(() => {})
      await win.setMaxSize(new PhysicalSize(12000, 12000)).catch(() => {})
      await win.setSize(new PhysicalSize(FULL_WINDOW_SIZE.width, FULL_WINDOW_SIZE.height)).catch(() => {})
      await win.center()
      await win.show()
      await win.setFocus()
      log("full done")
      return
    }

    // ball + chat share the compact, frameless, always-on-top, no-taskbar look.
    await win.unmaximize().catch(() => {})
    await win.unminimize().catch(() => {})
    await win.setDecorations(false)
    await win.setAlwaysOnTop(true)
    await win.setSkipTaskbar(true)
    // Pin the window to a fixed size: min == max removes the OS resize/snap
    // arrows on Windows and forces the exact dimensions even if setSize alone
    // was ignored while the window was maximized.
    const size = mode === "ball" ? BALL_WINDOW_SIZE :
      mode === "chat" ? CHAT_WINDOW_SIZE :
      PREVIEW_WINDOW_SIZE
    await win.setResizable(false)
    await win.setMinSize(new PhysicalSize(size.width, size.height)).catch(() => {})
    await win.setMaxSize(new PhysicalSize(size.width, size.height)).catch(() => {})
    await win.setShadow(true).catch(() => {}) // unsupported on Windows; ignore
    const pos = await rightMiddlePosition(size.width, size.height)
    await win.setSize(new PhysicalSize(size.width, size.height)).catch(() => {})
    await win.setPosition(pos).catch(() => {})
    await win.show()
    if (mode === "chat") await win.setFocus()
    const after = await win.innerSize().catch(() => null)
    const resizable = await win.isResizable().catch(() => "?")
    log(`${mode} done target=${size.width}x${size.height} actual=${after ? `${after.width}x${after.height}` : "?"} resizable=${resizable}`)
  } catch (err) {
    log("ERROR", String(err))
  }
}

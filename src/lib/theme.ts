import { loadTheme } from "@/lib/project-store"
import { getCurrentWindow, type Theme as NativeTheme } from "@tauri-apps/api/window"

export type AppTheme = "light" | "dark" | "system"

let activeTheme: AppTheme = "system"
let mediaQuery: MediaQueryList | null = null
let mediaListenerInstalled = false

function systemPrefersDark(): boolean {
  return window.matchMedia("(prefers-color-scheme: dark)").matches
}

function isTauriRuntime(): boolean {
  return "__TAURI_INTERNALS__" in window || "__TAURI__" in window
}

function syncNativeWindowTheme(resolved: NativeTheme): void {
  if (!isTauriRuntime()) return
  const win = getCurrentWindow()
  const background = resolved === "dark" ? "#27282b" : "#ffffff"
  void win.setTheme(resolved).catch((err) => {
    console.warn("[theme] failed to sync native window theme:", err)
  })
  void win.setBackgroundColor(background).catch((err) => {
    console.warn("[theme] failed to sync native window background:", err)
  })
}

export function applyTheme(theme: AppTheme): void {
  activeTheme = theme
  const root = document.documentElement
  const resolved = theme === "system"
    ? systemPrefersDark()
      ? "dark"
      : "light"
    : theme

  root.classList.remove("light", "dark")
  root.classList.add(resolved)
  root.dataset.theme = theme
  syncNativeWindowTheme(resolved)
}

export function watchSystemTheme(): void {
  if (mediaListenerInstalled) return
  mediaQuery = window.matchMedia("(prefers-color-scheme: dark)")
  mediaQuery.addEventListener("change", () => {
    if (activeTheme === "system") applyTheme("system")
  })
  mediaListenerInstalled = true
}

export async function loadAndApplyTheme(): Promise<AppTheme> {
  try {
    const savedTheme = await loadTheme()
    const theme = savedTheme ?? "system"
    applyTheme(theme)
    return theme
  } catch {
    applyTheme("system")
    return "system"
  }
}

export type UiTheme = "system" | "light" | "dark"

const THEMES: UiTheme[] = ["system", "light", "dark"]
const SYSTEM_DARK_QUERY = "(prefers-color-scheme: dark)"
let stopWatchingSystemTheme: (() => void) | undefined

export function normalizeUiTheme(value: unknown): UiTheme {
  return THEMES.includes(value as UiTheme) ? (value as UiTheme) : "system"
}

function systemPrefersDark(): boolean {
  return window.matchMedia?.(SYSTEM_DARK_QUERY).matches ?? false
}

export function themeUsesDark(theme: UiTheme): boolean {
  return theme === "dark" || (theme === "system" && systemPrefersDark())
}

export function applyUiTheme(theme: UiTheme): void {
  const dark = themeUsesDark(theme)
  document.documentElement.classList.toggle("dark", dark)
  document.documentElement.style.colorScheme = dark ? "dark" : "light"
}

function watchSystemTheme(theme: UiTheme, onChange: () => void): () => void {
  if (theme !== "system" || !window.matchMedia) return () => {}

  const media = window.matchMedia(SYSTEM_DARK_QUERY)
  media.addEventListener("change", onChange)
  return () => media.removeEventListener("change", onChange)
}

export function activateUiTheme(theme: UiTheme): void {
  stopWatchingSystemTheme?.()
  applyUiTheme(theme)
  stopWatchingSystemTheme = watchSystemTheme(theme, () => applyUiTheme(theme))
}

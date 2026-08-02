// Web shim for `@tauri-apps/api/window`.
export type Theme = "light" | "dark" | null

interface WebWindow {
  setTheme(theme: Theme): Promise<void>
  theme(): Promise<Theme>
  setTitle(title: string): Promise<void>
}

function prefersDark(): boolean {
  return typeof window !== "undefined" && !!window.matchMedia?.("(prefers-color-scheme: dark)").matches
}

const currentWindow: WebWindow = {
  async setTheme(_theme: Theme) {
    // The web client themes itself via CSS; nothing native to sync.
  },
  async theme() {
    return prefersDark() ? "dark" : "light"
  },
  async setTitle(title: string) {
    if (typeof document !== "undefined") document.title = title
  },
}

export function getCurrentWindow(): WebWindow {
  return currentWindow
}

export const appWindow = currentWindow

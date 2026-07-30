import os from "node:os"
import path from "node:path"
import fs from "node:fs"

// Central location for server-side persistent state. Override with
// LLM_WIKI_DATA_DIR. Defaults to ~/.llm-wiki-server. This is the FALLBACK
// location for the plugin-store when no shared desktop store is found.
export const DATA_DIR =
  process.env.LLM_WIKI_DATA_DIR || path.join(os.homedir(), ".llm-wiki-server")

export const STORES_DIR = path.join(DATA_DIR, "stores")

// Port the HTTP server listens on. The web client is served from the same
// origin, so there is no CORS friction for normal use.
export const PORT = Number(process.env.LLM_WIKI_PORT || 19828)

// Bind host. Defaults to loopback (local-only) like the desktop app's
// built-in API server. Set LLM_WIKI_HOST=0.0.0.0 to expose on the LAN.
export const HOST = process.env.LLM_WIKI_HOST || "127.0.0.1"

// Where the built web client lives (vite build output). Resolved relative to
// the repo root (this file lives in <root>/packages/server/src) so the server
// finds the web build regardless of the launch cwd.
export const WEB_DIST =
  process.env.LLM_WIKI_WEB_DIST || path.resolve(import.meta.dirname, "..", "..", "..", "dist-web")

// ── Shared desktop store discovery ────────────────────────────────────────
// The desktop (Tauri) app persists its plugin-store (`app-state.json`) inside
// its per-app data directory, keyed by the bundle identifier in
// src-tauri/tauri.conf.json. To give one user a single set of settings across
// the desktop and web clients on the SAME host, the web server can read/write
// that exact file. We discover it by scanning the OS-specific candidate data
// dirs for a file that (a) is named like the store and (b) actually contains
// llm-wiki keys — so an unrelated JSON file never gets adopted.
//
// Overrides:
//   LLM_WIKI_STORE_FILE=/abs/path/app-state.json  → use this file (create if missing)
//   LLM_WIKI_NO_SHARE=1                            → never share; web-only store
export const DESKTOP_IDENTIFIER = "com.llmwiki.app"
export const SHARED_STORE_NAME = "app-state.json"

export const STORE_KEYS = [
  "llmConfig", "providerConfigs", "recentProjects", "projectRegistry",
  "lastProject", "taskModelRouting", "customLlmPresets", "projectLlmOverrides",
  "searchApiConfig", "embeddingConfig", "mineruConfig", "multimodalConfig",
  "outputLanguage", "language", "generalConfig", "apiConfig", "proxyConfig",
  "scheduledImportConfig", "sourceWatchConfig", "zoomLevel", "updateCheckState",
]

function home() { return os.homedir() }

/** OS-specific candidate directories where Tauri may keep the plugin-store. */
export function desktopStoreCandidateDirs() {
  const id = DESKTOP_IDENTIFIER
  const h = home()
  const dirs = []
  switch (process.platform) {
    case "darwin":
      dirs.push(path.join(h, "Library", "Application Support", id))
      dirs.push(path.join(h, "Library", "Application Support", "LLM Wiki"))
      break
    case "win32": {
      const roam = process.env.APPDATA
      const local = process.env.LOCALAPPDATA
      if (roam) dirs.push(path.join(roam, id))
      if (local) dirs.push(path.join(local, id))
      break
    }
    default: { // linux / others
      const xdg = process.env.XDG_DATA_HOME || path.join(h, ".local", "share")
      const xdgConf = process.env.XDG_CONFIG_HOME || path.join(h, ".config")
      dirs.push(path.join(xdg, id))
      dirs.push(path.join(xdgConf, id))
      break
    }
  }
  return dirs
}

export function explicitStoreFile() {
  const v = process.env.LLM_WIKI_STORE_FILE
  return v && v.trim() ? path.resolve(v.trim()) : null
}

export function sharingDisabled() {
  return process.env.LLM_WIKI_NO_SHARE === "1"
}

export function ensureDataDirs() {
  fs.mkdirSync(STORES_DIR, { recursive: true })
}

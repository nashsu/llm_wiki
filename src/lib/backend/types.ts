/**
 * Host backend abstraction.
 *
 * The React app runs in two hosts: the Tauri desktop webview and a plain
 * browser talking to `llm-wiki-server`. Everything the UI needs from the
 * host — command invocation, event subscription, file URLs, outbound HTTP,
 * settings persistence, native dialogs, opening URLs — goes through this
 * interface so feature code never imports `@tauri-apps/*` directly.
 *
 * Runtime selection happens once in `./index.ts`.
 */

export type BackendKind = "tauri" | "web"

export type UnlistenFn = () => void

/** Mirrors `@tauri-apps/api/event` `Event<T>` — callers read `.payload`. */
export interface BackendEvent<T> {
  event: string
  id: number
  payload: T
}

export interface DialogFilter {
  name: string
  extensions: string[]
}

export interface OpenDialogOptions {
  title?: string
  directory?: boolean
  multiple?: boolean
  filters?: DialogFilter[]
  defaultPath?: string
  createDirectories?: boolean
  /** Web only: allow uploading a whole folder from the browser instead of picking a server path. */
  allowUpload?: boolean
}

export interface SaveDialogOptions {
  title?: string
  defaultPath?: string
  filters?: DialogFilter[]
}

export interface MessageDialogOptions {
  title?: string
  kind?: "info" | "warning" | "error"
}

/** Subset of `@tauri-apps/plugin-store` `Store` the app uses. */
export interface KeyValueStore {
  get<T>(key: string): Promise<T | undefined>
  set(key: string, value: unknown): Promise<void>
  delete(key: string): Promise<boolean>
  clear(): Promise<void>
  save(): Promise<void>
  entries<T = unknown>(): Promise<[string, T][]>
}

export interface Backend {
  readonly kind: BackendKind

  /** `invoke()` — call a backend command by name. Rejects with the error string. */
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>

  /** `listen()` — subscribe to backend events. */
  listen<T>(event: string, handler: (event: BackendEvent<T>) => void): Promise<UnlistenFn>

  /** `convertFileSrc()` — URL the webview/browser can load a local file from. */
  fileSrc(absolutePath: string): string

  /** Rust-backed fetch (desktop) or server-proxied fetch (web) for user-configured endpoints. */
  getFetch(): Promise<typeof globalThis.fetch>

  /** Persistent settings store (`app-state.json`). */
  loadStore(name: string): Promise<KeyValueStore>

  dialog: {
    open(options: OpenDialogOptions): Promise<string | string[] | null>
    save(options: SaveDialogOptions): Promise<string | null>
    message(text: string, options?: MessageDialogOptions): Promise<void>
  }

  /** Open a URL in the system browser (desktop) or a new tab (web). */
  openUrl(url: string): Promise<void>

  /** Reveal / open a local path. Rejects on web, where the server's disk is remote. */
  openPath(path: string): Promise<void>

  /**
   * A file was written for the user at `path` (an export they chose a
   * destination for). Desktop: nothing to do. Web: trigger a download.
   */
  deliverFile(path: string): Promise<void>

  autostart: {
    enable(): Promise<void>
    disable(): Promise<void>
    isEnabled(): Promise<boolean>
    readonly supported: boolean
  }
}

/**
 * Host backend entry point. Feature code imports from here instead of
 * `@tauri-apps/*`:
 *
 *   import { invoke, listen, convertFileSrc, backend } from "@/lib/backend"
 *
 * Selection is by runtime: inside the Tauri webview (or in Node, where the
 * unit tests mock `@tauri-apps/api/core`) the Tauri implementation is used;
 * in a plain browser the web implementation talks to `llm-wiki-server`.
 */

import type { Backend, BackendEvent, BackendKind, UnlistenFn } from "./types"
import { tauriBackend } from "./tauri"
import { webBackend } from "./web"

export type { Backend, BackendEvent, BackendKind, KeyValueStore, OpenDialogOptions, SaveDialogOptions, UnlistenFn } from "./types"

export function isTauriRuntime(): boolean {
  if (typeof window === "undefined") return true
  return "__TAURI_INTERNALS__" in window || "__TAURI__" in window
}

export function detectBackendKind(): BackendKind {
  return isTauriRuntime() ? "tauri" : "web"
}

let selected: Backend | null = null

export function getBackend(): Backend {
  if (!selected) {
    selected = detectBackendKind() === "tauri" ? tauriBackend : webBackend
  }
  return selected
}

/** Test hook: force a backend implementation. */
export function __setBackendForTests(backend: Backend | null): void {
  selected = backend
}

export const backend: Backend = new Proxy({} as Backend, {
  get(_target, property: keyof Backend) {
    return getBackend()[property]
  },
})

export function isWebRuntime(): boolean {
  return getBackend().kind === "web"
}

export function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  return getBackend().invoke<T>(command, args)
}

export function listen<T>(
  event: string,
  handler: (event: BackendEvent<T>) => void,
): Promise<UnlistenFn> {
  return getBackend().listen<T>(event, handler)
}

export function convertFileSrc(absolutePath: string): string {
  return getBackend().fileSrc(absolutePath)
}

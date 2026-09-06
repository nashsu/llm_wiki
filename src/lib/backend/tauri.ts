/**
 * Tauri desktop implementation of the host backend — thin pass-throughs to
 * the official `@tauri-apps/*` packages. This module is also what unit
 * tests exercise (they `vi.mock("@tauri-apps/api/core")`), so keep the
 * imports static and the wrappers trivial.
 */

import { convertFileSrc, invoke as tauriInvoke } from "@tauri-apps/api/core"
import { listen as tauriListen } from "@tauri-apps/api/event"
import { load as loadTauriStore } from "@tauri-apps/plugin-store"
import { message as tauriMessage, open as tauriOpen, save as tauriSave } from "@tauri-apps/plugin-dialog"
import { openPath as tauriOpenPath, openUrl as tauriOpenUrl } from "@tauri-apps/plugin-opener"
import {
  disable as disableAutostart,
  enable as enableAutostart,
  isEnabled as isAutostartEnabled,
} from "@tauri-apps/plugin-autostart"

import type { Backend, KeyValueStore } from "./types"

let pluginFetchPromise: Promise<typeof globalThis.fetch> | null = null

/**
 * True when running outside a browser / webview (vitest, SSR, any
 * Node-based tooling). The Tauri HTTP plugin is importable in Node but its
 * internals reach for `window` at call time, so guard BEFORE importing.
 */
const isNodeEnv = typeof window === "undefined"

export const tauriBackend: Backend = {
  kind: "tauri",

  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
    return tauriInvoke<T>(command, args)
  },

  listen(event, handler) {
    return tauriListen(event, handler)
  },

  fileSrc(absolutePath: string): string {
    return convertFileSrc(absolutePath)
  },

  getFetch(): Promise<typeof globalThis.fetch> {
    if (!pluginFetchPromise) {
      if (isNodeEnv) {
        // Bind so `this === globalThis` — Node's fetch requires it.
        pluginFetchPromise = Promise.resolve(globalThis.fetch.bind(globalThis))
      } else {
        pluginFetchPromise = import("@tauri-apps/plugin-http")
          .then((m) => m.fetch as typeof globalThis.fetch)
          .catch(() => globalThis.fetch.bind(globalThis))
      }
    }
    return pluginFetchPromise
  },

  async loadStore(name: string): Promise<KeyValueStore> {
    const store = await loadTauriStore(name, { autoSave: true, defaults: {} })
    return {
      get: <T,>(key: string) => store.get<T>(key),
      set: (key, value) => store.set(key, value),
      delete: (key) => store.delete(key),
      clear: () => store.clear(),
      save: () => store.save(),
      entries: <T,>() => store.entries<T>(),
    }
  },

  dialog: {
    open: (options) => tauriOpen(options),
    save: (options) => tauriSave(options),
    message: async (text, options) => {
      await tauriMessage(text, options)
    },
  },

  openUrl: (url) => tauriOpenUrl(url),
  openPath: (path) => tauriOpenPath(path),
  deliverFile: async () => {
    /* the user picked the destination themselves; nothing to deliver */
  },

  autostart: {
    supported: true,
    enable: () => enableAutostart(),
    disable: () => disableAutostart(),
    isEnabled: () => isAutostartEnabled(),
  },
}

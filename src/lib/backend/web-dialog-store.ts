/**
 * Queue of dialogs the web backend needs the React tree to render
 * (server-side folder picker, message boxes). `requestWebDialog()` is
 * imperative like the Tauri plugin API; `<WebDialogHost/>` renders the
 * head of the queue and resolves the promise.
 */

import { create } from "zustand"
import type { OpenDialogOptions } from "./types"

export type WebDialogRequest =
  | { kind: "directory"; options: OpenDialogOptions }
  | { kind: "message"; text: string; title?: string }

interface PendingDialog {
  id: number
  request: WebDialogRequest
  resolve: (value: string | null) => void
}

interface WebDialogState {
  queue: PendingDialog[]
  enqueue: (request: WebDialogRequest, resolve: (value: string | null) => void) => void
  settle: (id: number, value: string | null) => void
}

let nextId = 1

export const useWebDialogStore = create<WebDialogState>((set, get) => ({
  queue: [],
  enqueue: (request, resolve) =>
    set((state) => ({ queue: [...state.queue, { id: nextId++, request, resolve }] })),
  settle: (id, value) => {
    const pending = get().queue.find((entry) => entry.id === id)
    if (!pending) return
    set((state) => ({ queue: state.queue.filter((entry) => entry.id !== id) }))
    pending.resolve(value)
  },
}))

export function requestWebDialog(request: WebDialogRequest): Promise<string | null> {
  return new Promise((resolve) => {
    useWebDialogStore.getState().enqueue(request, resolve)
  })
}

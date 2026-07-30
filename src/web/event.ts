// Web shim for `@tauri-apps/api/event` backed by the server SSE bus.
import { subscribeEvent } from "./http-api"

export type UnlistenFn = () => void

export interface WebEvent<T> {
  event: string
  id: number
  payload: T
}

type Handler<T> = (event: WebEvent<T>) => void

let nextId = 1

export async function listen<T>(event: string, handler: Handler<T>): Promise<UnlistenFn> {
  return subscribeEvent(event, (payload) => {
    handler({ event, id: nextId++, payload: payload as T })
  })
}

export async function once<T>(event: string, handler: Handler<T>): Promise<UnlistenFn> {
  const unlisten = await listen<T>(event, (evt) => {
    unlisten()
    handler(evt)
  })
  return unlisten
}

// Client-originated events are not used by the app's web features; the SSE
// bus is server→client only. Provided for API compatibility.
export async function emit<T>(_event: string, _payload?: T): Promise<void> {
  return
}

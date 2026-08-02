// Web shim for `@tauri-apps/api/core`.
import { invokeHttp, rawFileUrl } from "./http-api"

export async function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  return invokeHttp<T>(command, args)
}

// In Tauri this returns an asset-protocol URL; in the browser we stream the
// server-side file through /api/raw so <img>/<a> tags can render local files.
export function convertFileSrc(path: string, _protocol?: string): string {
  return rawFileUrl(path)
}

export function transformCallback(_callback: unknown): number {
  // Not used by the web client; present for API compatibility.
  return -1
}

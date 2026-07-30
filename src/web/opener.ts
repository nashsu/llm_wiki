// Web shim for `@tauri-apps/plugin-opener`.
//
// The web server runs on the user's host (the supported same-host topology),
// so "open with the OS default app" and "reveal in file manager" are real
// actions: the shim delegates to the server's web-only `web_open_path` /
// `web_reveal_path` commands (server/src/commands/openerWeb.js → opener.js,
// a faithful port of tauri-plugin-opener). `openPath` keeps a browser-native
// fallback — stream the file in a new tab via /api/raw — for when the server
// cannot open the OS handler (e.g. a headless remote host), so the action
// always does something useful.
import { invokeHttp, rawFileUrl } from "./http-api"

export async function openUrl(url: string, _openWith?: string): Promise<void> {
  window.open(url, "_blank", "noopener,noreferrer")
}

export async function openPath(path: string, _openWith?: string): Promise<void> {
  try {
    await invokeHttp("web_open_path", { path })
  } catch {
    // Headless/remote server: fall back to viewing the file in a browser tab.
    window.open(rawFileUrl(path), "_blank", "noopener,noreferrer")
  }
}

export async function revealItemInDir(path: string): Promise<void> {
  await invokeHttp("web_reveal_path", { path })
}

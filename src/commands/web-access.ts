import { invoke } from "@tauri-apps/api/core"

export interface StartWebAccessProxyResult {
  ok: boolean
  message: string
  scriptPath: string
  pid?: number | null
}

export async function startWebAccessProxy(scriptPath?: string): Promise<StartWebAccessProxyResult> {
  return invoke<StartWebAccessProxyResult>("start_web_access_proxy", {
    scriptPath: scriptPath?.trim() || null,
  })
}

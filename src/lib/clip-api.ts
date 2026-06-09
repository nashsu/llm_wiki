import { useWikiStore } from "@/stores/wiki-store"

/** Auth headers for the local Clip Server (127.0.0.1:19827). */
export function clipAuthHeaders(): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" }
  const token = useWikiStore.getState().apiConfig.token?.trim()
  if (token) {
    headers.Authorization = `Bearer ${token}`
  }
  return headers
}

export async function clipFetch(
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = { ...clipAuthHeaders(), ...(init.headers as Record<string, string> | undefined) }
  return fetch(`http://127.0.0.1:19827${path}`, { ...init, headers })
}

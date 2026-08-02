// Settings — /api/v2/settings

import { request } from "./client"

export type SettingsMap = Record<string, unknown>

/** GET /api/v2/settings — all settings as a key/value map. */
export function getSettings(): Promise<SettingsMap> {
  return request<SettingsMap>("/api/v2/settings")
}

/** GET /api/v2/settings/:key — a single setting value. */
export function getSetting<T = unknown>(key: string): Promise<T> {
  return request<T>(`/api/v2/settings/${encodeURIComponent(key)}`)
}

/** PUT /api/v2/settings/:key — set a single setting. */
export function setSetting<T = unknown>(key: string, value: unknown): Promise<T> {
  return request<T>(`/api/v2/settings/${encodeURIComponent(key)}`, {
    method: "PUT",
    json: { value },
  })
}

/** DELETE /api/v2/settings/:key */
export function deleteSetting(key: string): Promise<void> {
  return request<void>(`/api/v2/settings/${encodeURIComponent(key)}`, {
    method: "DELETE",
  })
}

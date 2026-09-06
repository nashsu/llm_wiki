/**
 * Typed wrappers for the connector commands (`src-tauri/src/connectors/`).
 * Connectors pull documents from external systems (a folder, Google Drive…)
 * into `raw/sources/@<name>/`; the source-folder watcher then ingests them.
 */

import { invoke, listen, type UnlistenFn } from "@/lib/backend"
import { isWebRuntime } from "@/lib/backend"

export type ConnectorFieldKind = "text" | "number" | "boolean" | "secret" | "path"

export interface ConnectorField {
  key: string
  label: string
  kind: ConnectorFieldKind
  required: boolean
  placeholder?: string | null
  help?: string | null
  default?: unknown
}

export type ConnectorAuth =
  | { type: "none" }
  | { type: "oAuth2"; provider: string; scopes: string[] }

export interface ConnectorDescriptor {
  kind: string
  label: string
  description: string
  auth: ConnectorAuth
  fields: ConnectorField[]
  supportsDelta: boolean
}

export interface SyncSummary {
  startedAt: number
  finishedAt: number
  added: number
  updated: number
  deleted: number
  unchanged: number
  skipped: number
  errors: string[]
  ok: boolean
}

export interface ConnectorInstance {
  id: string
  kind: string
  name: string
  enabled: boolean
  intervalMinutes: number
  config: Record<string, unknown>
  maxFileSizeMb: number
  createdAt: number
  lastSync: SyncSummary | null
  /** `raw/sources/@<name>` */
  folder: string
  running: boolean
  auth: {
    hasClientSecret: boolean
    connected: boolean
    connectedAt: number | null
    scope: string | null
  }
}

export interface ConnectorSaveInput {
  id?: string
  kind: string
  name: string
  enabled: boolean
  intervalMinutes: number
  config: Record<string, unknown>
  maxFileSizeMb: number
  /** Values for secret fields; blank keeps what is stored. */
  secrets: Record<string, unknown>
}

export interface SyncSkipped {
  name: string
  reason: "unsupported-type" | "too-large" | "excluded" | "fetch-failed" | "write-failed"
  detail?: string
}

export interface SyncReport {
  summary: SyncSummary
  added: string[]
  updated: string[]
  deleted: string[]
  skipped: SyncSkipped[]
}

export type ConnectorSyncEvent = {
  projectId: string
  instanceId: string
  phase: "started" | "listed" | "progress" | "finished" | "failed"
  name?: string
  total?: number
  done?: number
  delta?: boolean
  report?: SyncReport
  error?: string
}

export const CONNECTOR_SYNC_EVENT = "connectors://sync"
export const CONNECTOR_OAUTH_EVENT = "connectors://oauth"

export function connectorDescriptors(): Promise<ConnectorDescriptor[]> {
  return invoke<ConnectorDescriptor[]>("connector_descriptors")
}

export function connectorList(projectId: string, projectPath: string): Promise<ConnectorInstance[]> {
  return invoke<ConnectorInstance[]>("connector_list", { projectId, projectPath })
}

export function connectorSave(
  projectId: string,
  projectPath: string,
  input: ConnectorSaveInput,
): Promise<ConnectorInstance> {
  return invoke<ConnectorInstance>("connector_save", { projectId, projectPath, input })
}

export function connectorDelete(projectPath: string, id: string, purgeFiles: boolean): Promise<boolean> {
  return invoke<boolean>("connector_delete", { projectPath, id, purgeFiles })
}

export function connectorTest(projectPath: string, id: string): Promise<string> {
  return invoke<string>("connector_test", { projectPath, id })
}

export function connectorSync(projectId: string, projectPath: string, id: string): Promise<{ started: boolean }> {
  return invoke<{ started: boolean }>("connector_sync", { projectId, projectPath, id })
}

export function connectorReset(projectPath: string, id: string): Promise<void> {
  return invoke<void>("connector_reset", { projectPath, id })
}

export function connectorOAuthStart(projectPath: string, id: string, redirectUri: string): Promise<string> {
  return invoke<string>("connector_oauth_start", { projectPath, id, redirectUri })
}

export function connectorOAuthDisconnect(id: string): Promise<void> {
  return invoke<void>("connector_oauth_disconnect", { id })
}

/**
 * Where the OAuth provider must redirect back to. The desktop app listens on
 * the local API port; the web server serves the callback on its own origin.
 */
export function oauthRedirectUri(): string {
  if (isWebRuntime()) {
    return `${window.location.origin}/web/connectors/oauth/callback`
  }
  return "http://127.0.0.1:19828/api/v1/oauth/callback"
}

export function onConnectorSync(handler: (event: ConnectorSyncEvent) => void): Promise<UnlistenFn> {
  return listen<ConnectorSyncEvent>(CONNECTOR_SYNC_EVENT, (event) => handler(event.payload))
}

export function onConnectorOAuth(
  handler: (event: { instanceId: string; status: string }) => void,
): Promise<UnlistenFn> {
  return listen<{ instanceId: string; status: string }>(CONNECTOR_OAUTH_EVENT, (event) =>
    handler(event.payload),
  )
}

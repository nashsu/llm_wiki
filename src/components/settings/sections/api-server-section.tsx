import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  Copy,
  Eye,
  EyeOff,
  ExternalLink,
  Globe,
  RefreshCw,
  Server,
  ShieldAlert,
} from "lucide-react"
import { useTranslation } from "react-i18next"
import { openUrl } from "@tauri-apps/plugin-opener"
import {
  apiServerStatus,
  mcpServerEntryPath,
  remoteMcpStart,
  remoteMcpStatus,
  remoteMcpStop,
} from "@/commands/fs"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { API_SERVER_BASE_URL, API_SERVER_HEALTH_URL } from "@/lib/api-server-constants"
import { generateApiToken } from "@/lib/api-token"
import { saveApiConfig } from "@/lib/project-store"
import { useWikiStore, type ApiConfig } from "@/stores/wiki-store"
import type { SettingsDraft, DraftSetter } from "../settings-types"

interface Props {
  draft: SettingsDraft
  setDraft: DraftSetter
}

interface ApiHealth {
  ok?: boolean
  status?: string
  enabled?: boolean
  mcpEnabled?: boolean
  authRequired?: boolean
  authConfigured?: boolean
  allowUnauthenticated?: boolean
  allowLanAccess?: boolean
  tokenSource?: "env" | "store" | "none"
}

/**
 * Documented endpoint surface. Kept in lock-step with
 * `src-tauri/src/api_server.rs::handle_request`. When you add or remove
 * a route there, update this list — it's the only place users discover
 * the API contract until we ship a proper OpenAPI doc.
 */
export const API_ENDPOINTS: Array<{ method: "GET" | "POST" | "PATCH"; path: string; noteKey: string }> = [
  { method: "GET", path: "/api/v1/health", noteKey: "endpointHealthNote" },
  { method: "GET", path: "/api/v1/projects", noteKey: "endpointProjectsNote" },
  { method: "GET", path: "/api/v1/projects/{id}/files", noteKey: "endpointFilesNote" },
  { method: "GET", path: "/api/v1/projects/{id}/files/content", noteKey: "endpointContentNote" },
  { method: "GET", path: "/api/v1/projects/{id}/reviews", noteKey: "endpointReviewsNote" },
  { method: "PATCH", path: "/api/v1/projects/{id}/reviews/{reviewId}", noteKey: "endpointPatchReviewNote" },
  { method: "POST", path: "/api/v1/projects/{id}/reviews/resolve", noteKey: "endpointBulkResolveNote" },
  { method: "POST", path: "/api/v1/projects/{id}/search", noteKey: "endpointSearchNote" },
  { method: "GET", path: "/api/v1/projects/{id}/graph", noteKey: "endpointGraphNote" },
  { method: "POST", path: "/api/v1/projects/{id}/sources/rescan", noteKey: "endpointRescanNote" },
  { method: "POST", path: "/api/v1/projects/{id}/chat", noteKey: "endpointChatNote" },
  { method: "POST", path: "/api/v1/projects/{id}/chat/{sessionId}/cancel", noteKey: "endpointChatCancelNote" },
]

export function ApiServerSection({ draft, setDraft }: Props) {
  const { t } = useTranslation()
  const [showToken, setShowToken] = useState(false)
  const [copiedField, setCopiedField] = useState<"token" | "curl" | "chat" | "mcp" | "remoteToken" | "remotePassword" | "remoteUrl" | null>(null)
  const [serverStatus, setServerStatus] = useState<string>("...")
  const [health, setHealth] = useState<ApiHealth | null>(null)
  const [mcpEntryPath, setMcpEntryPath] = useState<string | null>(null)
  const [mcpPathError, setMcpPathError] = useState<string | null>(null)
  const persistedApiConfig = useWikiStore((s) => s.apiConfig)
  const [showRemoteToken, setShowRemoteToken] = useState(false)
  const [showRemotePassword, setShowRemotePassword] = useState(false)
  const [remoteMcpRunning, setRemoteMcpRunning] = useState(false)
  const [remoteMcpPublicUrl, setRemoteMcpPublicUrl] = useState<string | null>(null)
  const [remoteMcpBusy, setRemoteMcpBusy] = useState(false)
  const [remoteMcpError, setRemoteMcpError] = useState<string | null>(null)
  const remoteMcpPollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    let alive = true
    apiServerStatus()
      .then((s) => {
        if (alive) setServerStatus(s)
      })
      .catch(() => {
        if (alive) setServerStatus("unknown")
      })
    fetch(API_SERVER_HEALTH_URL)
      .then((res) => res.json() as Promise<ApiHealth>)
      .then((value) => {
        if (alive) setHealth(value)
      })
      .catch(() => {
        if (alive) setHealth(null)
      })
    mcpServerEntryPath()
      .then((path) => {
        if (!alive) return
        setMcpEntryPath(path)
        setMcpPathError(null)
      })
      .catch((err) => {
        if (!alive) return
        setMcpEntryPath(null)
        setMcpPathError(err instanceof Error ? err.message : String(err))
      })
    remoteMcpStatus()
      .then((status) => {
        if (!alive) return
        setRemoteMcpRunning(status.running)
        setRemoteMcpPublicUrl(status.publicUrl)
      })
      .catch(() => {
        // Remote MCP has never been started this session — not an error.
      })
    return () => {
      alive = false
    }
  }, [])

  useEffect(() => {
    return () => {
      if (remoteMcpPollRef.current) clearInterval(remoteMcpPollRef.current)
    }
  }, [])

  const handleGenerate = useCallback(() => {
    setDraft("apiToken", generateApiToken())
    setShowToken(true)
  }, [setDraft])

  const handleCopyToken = useCallback(async () => {
    if (!draft.apiToken) return
    try {
      await navigator.clipboard.writeText(draft.apiToken)
      setCopiedField("token")
      setTimeout(() => setCopiedField(null), 1500)
    } catch (err) {
      console.error("[api-settings] copy token failed:", err)
    }
  }, [draft.apiToken])

  const sampleCurl = useMemo(() => {
    if (draft.apiAllowUnauthenticated) {
      return `curl ${API_SERVER_BASE_URL}/api/v1/projects`
    }
    // Show the user a complete, paste-runnable example. The Bearer
    // header is the recommended auth (never put the token in URL
    // query — it leaks into logs / shell history / Referer).
    const tokenForExample = draft.apiToken || "<your-token>"
    return `curl -H "Authorization: Bearer ${tokenForExample}" ${API_SERVER_BASE_URL}/api/v1/projects`
  }, [draft.apiAllowUnauthenticated, draft.apiToken])

  const sampleChatCurl = useMemo(() => {
    const tokenForExample = health?.tokenSource === "env"
      ? "$LLM_WIKI_API_TOKEN"
      : draft.apiToken || "<your-token>"
    return `curl -N -X POST \\
  -H "Authorization: Bearer ${tokenForExample}" \\
  -H 'Content-Type: application/json' \\
  -H 'Accept: text/event-stream' \\
  ${API_SERVER_BASE_URL}/api/v1/projects/current/chat \\
  -d '{"message":"Summarize this knowledge base.","stream":true}'`
  }, [draft.apiToken, health?.tokenSource])

  const sampleMcpConfig = useMemo(() => {
    if (!mcpEntryPath) return ""
    const env = health?.tokenSource === "env"
      ? { LLM_WIKI_API_TOKEN: "<same value as the LLM Wiki process environment>" }
      : draft.apiToken
        ? { LLM_WIKI_API_TOKEN: draft.apiToken }
        : draft.apiAllowUnauthenticated
          ? {}
          : { LLM_WIKI_API_TOKEN: "<your-token>" }
    return JSON.stringify(
      {
        mcpServers: {
          "llm-wiki": {
            command: "node",
            args: [mcpEntryPath],
            ...(Object.keys(env).length > 0 ? { env } : {}),
          },
        },
      },
      null,
      2,
    )
  }, [draft.apiAllowUnauthenticated, draft.apiToken, health?.tokenSource, mcpEntryPath])

  const hasUnsavedApiConfig =
    persistedApiConfig.enabled !== draft.apiEnabled ||
    persistedApiConfig.allowUnauthenticated !== draft.apiAllowUnauthenticated ||
    persistedApiConfig.allowLanAccess !== draft.apiAllowLanAccess ||
    persistedApiConfig.mcpEnabled !== draft.apiMcpEnabled ||
    persistedApiConfig.token !== draft.apiToken.trim()

  const handleCopyCurl = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(sampleCurl)
      setCopiedField("curl")
      setTimeout(() => setCopiedField(null), 1500)
    } catch (err) {
      console.error("[api-settings] copy curl failed:", err)
    }
  }, [sampleCurl])

  const handleCopyChatCurl = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(sampleChatCurl)
      setCopiedField("chat")
      setTimeout(() => setCopiedField(null), 1500)
    } catch (err) {
      console.error("[api-settings] copy streaming chat curl failed:", err)
    }
  }, [sampleChatCurl])

  const handleCopyMcpConfig = useCallback(async () => {
    if (!mcpEntryPath) return
    try {
      await navigator.clipboard.writeText(sampleMcpConfig)
      setCopiedField("mcp")
      setTimeout(() => setCopiedField(null), 1500)
    } catch (err) {
      console.error("[api-settings] copy MCP config failed:", err)
    }
  }, [mcpEntryPath, sampleMcpConfig])

  const handleGenerateRemoteToken = useCallback(() => {
    setDraft("remoteMcpToken", generateApiToken())
    setShowRemoteToken(true)
  }, [setDraft])

  const handleGenerateRemotePassword = useCallback(() => {
    setDraft("remoteMcpApprovalPassword", generateApiToken())
    setShowRemotePassword(true)
  }, [setDraft])

  const handleCopyRemoteToken = useCallback(async () => {
    if (!draft.remoteMcpToken) return
    await navigator.clipboard.writeText(draft.remoteMcpToken)
    setCopiedField("remoteToken")
    setTimeout(() => setCopiedField(null), 1500)
  }, [draft.remoteMcpToken])

  const handleCopyRemotePassword = useCallback(async () => {
    if (!draft.remoteMcpApprovalPassword) return
    await navigator.clipboard.writeText(draft.remoteMcpApprovalPassword)
    setCopiedField("remotePassword")
    setTimeout(() => setCopiedField(null), 1500)
  }, [draft.remoteMcpApprovalPassword])

  const handleCopyRemoteUrl = useCallback(async () => {
    if (!remoteMcpPublicUrl) return
    await navigator.clipboard.writeText(`${remoteMcpPublicUrl}/mcp`)
    setCopiedField("remoteUrl")
    setTimeout(() => setCopiedField(null), 1500)
  }, [remoteMcpPublicUrl])

  const pollRemoteMcpUrl = useCallback(() => {
    if (remoteMcpPollRef.current) clearInterval(remoteMcpPollRef.current)
    let elapsedMs = 0
    remoteMcpPollRef.current = setInterval(() => {
      elapsedMs += 1500
      remoteMcpStatus()
        .then((status) => {
          setRemoteMcpRunning(status.running)
          if (status.publicUrl) setRemoteMcpPublicUrl(status.publicUrl)
          if (status.publicUrl || elapsedMs >= 20_000) {
            if (remoteMcpPollRef.current) clearInterval(remoteMcpPollRef.current)
          }
        })
        .catch(() => {
          if (remoteMcpPollRef.current) clearInterval(remoteMcpPollRef.current)
        })
    }, 1500)
  }, [])

  // Persists straight to disk immediately (not gated behind the page's Save
  // button, unlike the rest of this screen) — this is what makes
  // autostart_if_enabled on the Rust side correct: it can trust
  // app-state.json to already match whatever's actually running.
  //
  // Deliberately does NOT call the Zustand setApiConfig() setter here.
  // settings-view.tsx has a resync effect that rebuilds the ENTIRE draft
  // from the store whenever apiConfig changes (see the comment above it,
  // "Resync draft from store if it changes out-of-band") — it already had
  // to special-case uiLanguage/theme/zoomLevel to stop that from
  // clobbering in-flight edits to those specific fields. Calling
  // setApiConfig from here, outside the page's unified Save flow, would
  // trigger that same resync and silently discard ANY other field the user
  // has edited-but-not-saved elsewhere on this page (an LLM key just
  // pasted, a MinerU token, etc.) — merged from a snapshot of the store
  // that hasn't seen those edits. Writing only to disk avoids that; the
  // in-memory store (and the "Save settings to apply changes" banner
  // elsewhere on this page) simply catches up next time the user does a
  // normal Save, which is harmless since draft.remoteMcp* is already kept
  // correct locally via setDraft below.
  const persistRemoteMcpConfig = useCallback(
    async (patch: Partial<ApiConfig>) => {
      const next: ApiConfig = { ...persistedApiConfig, ...patch }
      await saveApiConfig(next)
    },
    [persistedApiConfig],
  )

  // The checkbox itself is the on/off control — no separate Start/Stop
  // step and no need to hit the page-level Save button. Checking it
  // starts the bridge (auto-generating the token/password if either is
  // still empty) and persists immediately; unchecking stops it and
  // persists immediately, so a relaunch resumes exactly this state.
  const handleToggleRemoteMcp = useCallback(
    async (checked: boolean) => {
      setDraft("remoteMcpEnabled", checked)
      setRemoteMcpError(null)
      setRemoteMcpBusy(true)
      try {
        if (checked) {
          const token = draft.remoteMcpToken.trim() || generateApiToken()
          const password = draft.remoteMcpApprovalPassword.trim() || generateApiToken()
          setDraft("remoteMcpToken", token)
          setDraft("remoteMcpApprovalPassword", password)
          await remoteMcpStart({
            httpToken: token,
            approvalPassword: password,
            port: draft.remoteMcpPort,
            publicHostname: draft.remoteMcpPublicHostname.trim() || undefined,
            vaultRoot: draft.remoteMcpVaultRoot.trim() || undefined,
            llmWikiApiToken: draft.apiAllowUnauthenticated ? undefined : draft.apiToken.trim() || undefined,
          })
          setRemoteMcpRunning(true)
          pollRemoteMcpUrl()
          await persistRemoteMcpConfig({
            remoteMcpEnabled: true,
            remoteMcpToken: token,
            remoteMcpApprovalPassword: password,
            remoteMcpPort: draft.remoteMcpPort,
            remoteMcpPublicHostname: draft.remoteMcpPublicHostname.trim(),
            remoteMcpVaultRoot: draft.remoteMcpVaultRoot.trim(),
          })
        } else {
          await remoteMcpStop()
          setRemoteMcpRunning(false)
          setRemoteMcpPublicUrl(null)
          if (remoteMcpPollRef.current) clearInterval(remoteMcpPollRef.current)
          await persistRemoteMcpConfig({ remoteMcpEnabled: false })
        }
      } catch (err) {
        setRemoteMcpError(err instanceof Error ? err.message : String(err))
        setDraft("remoteMcpEnabled", !checked) // revert the checkbox — the action didn't actually happen
      } finally {
        setRemoteMcpBusy(false)
      }
    },
    [
      draft.apiAllowUnauthenticated,
      draft.apiToken,
      draft.remoteMcpApprovalPassword,
      draft.remoteMcpPort,
      draft.remoteMcpPublicHostname,
      draft.remoteMcpToken,
      draft.remoteMcpVaultRoot,
      persistRemoteMcpConfig,
      pollRemoteMcpUrl,
      setDraft,
    ],
  )

  const handleOpenHealth = useCallback(() => {
    void openUrl(API_SERVER_HEALTH_URL).catch((err) => {
      console.error("[api-settings] open health failed:", err)
    })
  }, [])

  const statusLabel = useMemo(() => {
    if (!draft.apiEnabled) {
      return t("settings.sections.apiServer.statusDisabled", { defaultValue: "Disabled" })
    }
    if (health?.allowUnauthenticated || draft.apiAllowUnauthenticated) {
      return t("settings.sections.apiServer.statusOpen", { defaultValue: "Running, no auth" })
    }
    if (serverStatus === "running" && health?.authConfigured === false && !draft.apiToken) {
      return t("settings.sections.apiServer.statusNoToken", { defaultValue: "Running, no token" })
    }
    switch (serverStatus) {
      case "running":
        return t("settings.sections.apiServer.statusRunning", { defaultValue: "Running" })
      case "starting":
        return t("settings.sections.apiServer.statusStarting", { defaultValue: "Starting…" })
      case "port_conflict":
        return t("settings.sections.apiServer.statusPortConflict", {
          defaultValue: "Port 19828 in use",
        })
      case "error":
        return t("settings.sections.apiServer.statusError", { defaultValue: "Error" })
      case "unknown":
        return t("settings.sections.apiServer.statusUnknown", { defaultValue: "Unknown" })
      default:
        return serverStatus
    }
  }, [draft.apiAllowUnauthenticated, draft.apiEnabled, draft.apiToken, health, serverStatus, t])

  const statusToneClass =
    !draft.apiEnabled
      ? "text-muted-foreground"
      : (health?.allowUnauthenticated || draft.apiAllowUnauthenticated)
        ? "text-amber-700 dark:text-amber-400"
        : serverStatus === "running"
      ? "text-emerald-600 dark:text-emerald-400"
      : serverStatus === "starting"
        ? "text-muted-foreground"
        : serverStatus === "unknown"
          ? "text-muted-foreground"
          : "text-destructive"

  const tokenStrength: "unused" | "missing" | "weak" | "ok" = draft.apiAllowUnauthenticated
    ? "unused"
    : !draft.apiToken
      ? "missing"
      : draft.apiToken.length < 16
        ? "weak"
        : "ok"

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold">
          {t("settings.sections.apiServer.title", { defaultValue: "API + MCP" })}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("settings.sections.apiServer.description", {
            defaultValue:
              "Expose LLM Wiki to your own tools through the local HTTP API, and optionally through the bundled MCP server for agent clients.",
          })}
        </p>
      </div>

      {/* ── Enable + status ───────────────────────────────────────── */}
      <div className="space-y-4 rounded-lg border border-border/60 bg-muted/20 p-4">
        <label className="flex items-start gap-3">
          <input
            type="checkbox"
            checked={draft.apiEnabled}
            onChange={(event) => setDraft("apiEnabled", event.target.checked)}
            className="mt-1 h-4 w-4"
          />
          <div className="space-y-1">
            <div className="flex items-center gap-2 text-sm font-semibold">
              <Server className="h-4 w-4 text-muted-foreground" />
              {t("settings.sections.apiServer.enable", {
                defaultValue: "Enable local HTTP API",
              })}
            </div>
            <p className="text-xs leading-relaxed text-muted-foreground">
              {t("settings.sections.apiServer.enableHint", {
                defaultValue:
                  "Disable to make every non-/health endpoint return 503 even if a token is configured. Useful as a kill-switch without unsetting the token.",
              })}
            </p>
          </div>
        </label>

        <label className="flex items-start gap-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 dark:border-amber-900/50 dark:bg-amber-950/30">
          <input
            type="checkbox"
            checked={draft.apiAllowUnauthenticated}
            onChange={(event) => setDraft("apiAllowUnauthenticated", event.target.checked)}
            className="mt-1 h-4 w-4"
          />
          <div className="space-y-1">
            <div className="text-sm font-semibold text-amber-900 dark:text-amber-200">
              {t("settings.sections.apiServer.allowUnauthenticated", {
                defaultValue: "Allow access without a token",
              })}
            </div>
            <p className="text-xs leading-relaxed text-amber-900 dark:text-amber-200">
              {t("settings.sections.apiServer.allowUnauthenticatedHint", {
                defaultValue:
                  "Use only for trusted local agents. Any process or browser page on this machine can call the API while this is enabled.",
              })}
            </p>
          </div>
        </label>

        <label className="flex items-start gap-3 rounded-md border border-border/60 bg-background/40 px-3 py-2">
          <input
            type="checkbox"
            checked={draft.apiAllowLanAccess}
            onChange={(event) => setDraft("apiAllowLanAccess", event.target.checked)}
            className="mt-1 h-4 w-4"
          />
          <div className="space-y-1">
            <div className="text-sm font-semibold">
              {t("settings.sections.apiServer.allowLanAccess", {
                defaultValue: "Allow API and Clip server access from the local network",
              })}
            </div>
            <p className="text-xs leading-relaxed text-muted-foreground">
              {t("settings.sections.apiServer.allowLanAccessHint", {
                defaultValue:
                  "After restarting the app, the API and Clip server listen on 0.0.0.0 instead of 127.0.0.1. Use only on trusted networks, and keep token auth enabled unless you fully trust the LAN.",
              })}
            </p>
          </div>
        </label>

        <div className="grid grid-cols-1 gap-3 rounded-md border border-border/60 bg-background/40 p-3 text-sm sm:grid-cols-2">
          <div className="space-y-0.5">
            <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
              {t("settings.sections.apiServer.status", { defaultValue: "Status" })}
            </div>
            <div className={`font-mono text-xs ${statusToneClass}`}>{statusLabel}</div>
          </div>
          <div className="space-y-0.5">
            <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
              {t("settings.sections.apiServer.baseUrl", { defaultValue: "Base URL" })}
            </div>
            <div className="font-mono text-xs">{API_SERVER_BASE_URL}</div>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={handleOpenHealth} className="gap-1.5">
            <ExternalLink className="h-3.5 w-3.5" />
            {t("settings.sections.apiServer.openHealth", { defaultValue: "Open /health" })}
          </Button>
          <span className="text-[11px] text-muted-foreground">
            {t("settings.sections.apiServer.openHealthHint", {
              defaultValue: "/health never requires authentication. Other endpoints follow the access mode below, except Agent chat, which always requires a token.",
            })}
          </span>
        </div>
      </div>

      {/* ── Token ─────────────────────────────────────────────────── */}
      <div className="space-y-3 rounded-lg border border-border/60 bg-muted/20 p-4">
        <div>
          <h3 className="text-sm font-semibold">
            {t("settings.sections.apiServer.token", { defaultValue: "Access token" })}
          </h3>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            {t("settings.sections.apiServer.tokenHint", {
              defaultValue:
                "Send as `Authorization: Bearer <token>` or `X-LLM-Wiki-Token: <token>`. Read-oriented endpoints may omit it when unauthenticated access is enabled, but Agent chat and cancellation always require it. The environment variable LLM_WIKI_API_TOKEN overrides this field if set.",
            })}
          </p>
        </div>

        <Label htmlFor="api-token-input" className="sr-only">
          {t("settings.sections.apiServer.token", { defaultValue: "Access token" })}
        </Label>
        <div className="flex gap-2">
          <Input
            id="api-token-input"
            type={showToken ? "text" : "password"}
            value={draft.apiToken}
            onChange={(event) => setDraft("apiToken", event.target.value)}
            placeholder={t("settings.sections.apiServer.tokenPlaceholder", {
              defaultValue: "Paste an existing token or click Generate",
            })}
            className="font-mono"
            autoComplete="off"
            spellCheck={false}
          />
          <Button
            type="button"
            variant="outline"
            size="icon"
            onClick={() => setShowToken((value) => !value)}
            title={
              showToken
                ? t("settings.sections.apiServer.hide", { defaultValue: "Hide" })
                : t("settings.sections.apiServer.show", { defaultValue: "Show" })
            }
            aria-label={
              showToken
                ? t("settings.sections.apiServer.hide", { defaultValue: "Hide" })
                : t("settings.sections.apiServer.show", { defaultValue: "Show" })
            }
          >
            {showToken ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="icon"
            onClick={handleCopyToken}
            disabled={!draft.apiToken}
            title={t("settings.sections.apiServer.copy", { defaultValue: "Copy" })}
            aria-label={t("settings.sections.apiServer.copy", { defaultValue: "Copy" })}
          >
            <Copy className="h-4 w-4" />
          </Button>
        </div>

        <div className="flex items-center gap-2">
          <Button type="button" variant="outline" size="sm" onClick={handleGenerate} className="gap-1.5">
            <RefreshCw className="h-3.5 w-3.5" />
            {t("settings.sections.apiServer.generate", { defaultValue: "Generate new token" })}
          </Button>
          {copiedField === "token" && (
            <span className="text-xs text-emerald-600 dark:text-emerald-400">
              {t("settings.sections.apiServer.copied", { defaultValue: "Copied" })}
            </span>
          )}
          {tokenStrength === "missing" && (
            <span className="text-xs text-amber-700 dark:text-amber-400">
              {t("settings.sections.apiServer.tokenMissing", {
                defaultValue: "No token — Agent chat is unavailable and protected endpoints return 401",
              })}
            </span>
          )}
          {tokenStrength === "unused" && health?.tokenSource !== "env" && (
            <span className="text-xs text-amber-700 dark:text-amber-400">
              {t("settings.sections.apiServer.tokenUnused", {
                defaultValue: "Read endpoints are open, but Agent chat still uses this token",
              })}
            </span>
          )}
          {health?.tokenSource === "env" && (
            <span className="text-xs text-amber-700 dark:text-amber-400">
              {t("settings.sections.apiServer.envTokenActive", {
                defaultValue: "LLM_WIKI_API_TOKEN is active and overrides this field",
              })}
            </span>
          )}
          {hasUnsavedApiConfig && (
            <span className="text-xs text-muted-foreground">
              {t("settings.sections.apiServer.saveFirst", {
                defaultValue: "Save settings to apply API changes",
              })}
            </span>
          )}
          {tokenStrength === "weak" && (
            <span className="text-xs text-amber-700 dark:text-amber-400">
              {t("settings.sections.apiServer.tokenWeak", {
                defaultValue: "Token is short — consider Generate for 256-bit entropy",
              })}
            </span>
          )}
        </div>

        <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-200">
          <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <div className="space-y-1">
            <div>
              {t("settings.sections.apiServer.tokenWarning", {
                defaultValue:
                  "Keep this token secret. Anyone with the token on this machine can read your project files via localhost.",
              })}
            </div>
            <div>
              {t("settings.sections.apiServer.tokenQueryWarning", {
                defaultValue:
                  "Prefer the Authorization header — passing ?token=… via URL leaks the value into shell history, logs, and Referer headers.",
              })}
            </div>
          </div>
        </div>
      </div>

      {/* ── Sample curl ───────────────────────────────────────────── */}
      <div className="space-y-3 rounded-lg border border-border/60 bg-muted/20 p-4">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-semibold">
            {t("settings.sections.apiServer.sample", { defaultValue: "Example request" })}
          </h3>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleCopyCurl}
            disabled={hasUnsavedApiConfig}
            className="gap-1.5"
          >
            <Copy className="h-3.5 w-3.5" />
            {copiedField === "curl"
              ? t("settings.sections.apiServer.copied", { defaultValue: "Copied" })
              : t("settings.sections.apiServer.copy", { defaultValue: "Copy" })}
          </Button>
        </div>
        <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded-md bg-background/60 px-3 py-2 text-[11px] font-mono leading-relaxed">
          {hasUnsavedApiConfig
            ? t("settings.sections.apiServer.saveFirstExample", {
                defaultValue: "Save settings first, then copy an example request.",
              })
            : sampleCurl}
        </pre>
      </div>

      {/* ── Endpoint catalog ──────────────────────────────────────── */}
      <div className="space-y-3 rounded-lg border border-border/60 bg-muted/20 p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold">
              {t("settings.sections.apiServer.chatTitle", { defaultValue: "Agent chat and streaming" })}
            </h3>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              {t("settings.sections.apiServer.chatHint", {
                defaultValue:
                  "POST a message to /chat. The default response is one JSON document. Set stream: true or send Accept: text/event-stream to receive SSE frames while the Agent works.",
              })}
            </p>
          </div>
          <Button type="button" variant="outline" size="sm" onClick={handleCopyChatCurl} disabled={hasUnsavedApiConfig} className="shrink-0 gap-1.5">
            <Copy className="h-3.5 w-3.5" />
            {copiedField === "chat"
              ? t("settings.sections.apiServer.copied", { defaultValue: "Copied" })
              : t("settings.sections.apiServer.copy", { defaultValue: "Copy" })}
          </Button>
        </div>
        <div className="grid gap-2 text-xs sm:grid-cols-2">
          <div className="rounded-md border border-border/60 bg-background/40 px-3 py-2">
            <div className="font-medium">{t("settings.sections.apiServer.chatJsonTitle", { defaultValue: "JSON mode" })}</div>
            <p className="mt-1 leading-relaxed text-muted-foreground">
              {t("settings.sections.apiServer.chatJsonHint", { defaultValue: "Omit stream or set it to false. The request returns after the complete Agent turn." })}
            </p>
          </div>
          <div className="rounded-md border border-border/60 bg-background/40 px-3 py-2">
            <div className="font-medium">{t("settings.sections.apiServer.chatSseTitle", { defaultValue: "SSE mode" })}</div>
            <p className="mt-1 leading-relaxed text-muted-foreground">
              {t("settings.sections.apiServer.chatSseHint", { defaultValue: "Frames: meta, incremental agent events, then done, cancelled, or error. done contains the complete aggregate response." })}
            </p>
          </div>
        </div>
        <div className="flex items-start gap-2 text-xs leading-relaxed text-amber-700 dark:text-amber-400">
          <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            {t("settings.sections.apiServer.chatTokenRequired", { defaultValue: "Agent chat and its cancellation endpoint always require a token, even when read endpoints allow unauthenticated access." })}
          </span>
        </div>
        <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded-md bg-background/60 px-3 py-2 text-[11px] font-mono leading-relaxed">
          {hasUnsavedApiConfig
            ? t("settings.sections.apiServer.saveFirstExample", { defaultValue: "Save settings first, then copy an example request." })
            : sampleChatCurl}
        </pre>
      </div>

      <div className="space-y-2 rounded-lg border border-border/60 bg-muted/20 p-4">
        <h3 className="text-sm font-semibold">
          {t("settings.sections.apiServer.endpoints", { defaultValue: "Endpoints" })}
        </h3>
        <p className="text-xs leading-relaxed text-muted-foreground">
          {t("settings.sections.apiServer.endpointsHint", {
            defaultValue: "Replace {id} with a project UUID, a project filesystem path, or the literal 'current'.",
          })}
        </p>
        <div className="space-y-1 text-xs">
          {API_ENDPOINTS.map((endpoint) => {
            const note = t(`settings.sections.apiServer.${endpoint.noteKey}`, {
              defaultValue: "",
            })
            const methodClass =
              endpoint.method === "GET"
                ? "bg-blue-500/10 text-blue-700 dark:text-blue-400"
                : endpoint.method === "PATCH"
                  ? "bg-amber-500/10 text-amber-700 dark:text-amber-400"
                  : "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
            return (
              <div
                key={`${endpoint.method} ${endpoint.path}`}
                className="flex flex-wrap items-baseline gap-2 rounded border border-border/40 bg-background/50 px-2 py-1"
              >
                <span
                  className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-semibold ${methodClass}`}
                >
                  {endpoint.method}
                </span>
                <span className="font-mono">{endpoint.path}</span>
                {note && <span className="text-muted-foreground">— {note}</span>}
              </div>
            )
          })}
        </div>
      </div>

      {/* ── MCP ──────────────────────────────────────────────────── */}
      <div className="space-y-3 rounded-lg border border-border/60 bg-muted/20 p-4">
        <label className="flex items-start gap-3">
          <input
            type="checkbox"
            checked={draft.apiMcpEnabled}
            onChange={(event) => setDraft("apiMcpEnabled", event.target.checked)}
            className="mt-1 h-4 w-4"
          />
          <div className="space-y-1">
            <div className="text-sm font-semibold">
              {t("settings.sections.apiServer.mcpEnable", {
                defaultValue: "Enable MCP access",
              })}
            </div>
            <p className="text-xs leading-relaxed text-muted-foreground">
              {t("settings.sections.apiServer.mcpEnableHint", {
                defaultValue:
                  "MCP uses the local API and the same token rules. Keep the HTTP API enabled, then connect an MCP client to the bundled Node server.",
              })}
            </p>
          </div>
        </label>

        <div className="rounded-md border border-border/50 bg-background/50 p-3">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-semibold">
              {t("settings.sections.apiServer.mcpUsage", { defaultValue: "MCP usage" })}
            </h3>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleCopyMcpConfig}
              disabled={hasUnsavedApiConfig || !draft.apiMcpEnabled || !mcpEntryPath}
              className="gap-1.5"
            >
              <Copy className="h-3.5 w-3.5" />
              {copiedField === "mcp"
                ? t("settings.sections.apiServer.copied", { defaultValue: "Copied" })
                : t("settings.sections.apiServer.copy", { defaultValue: "Copy" })}
            </Button>
          </div>
          <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
            {t("settings.sections.apiServer.mcpUsageHint", {
              defaultValue:
                "Build once with `npm run mcp:build`, then configure your MCP client to run the server below. Use LLM_WIKI_API_TOKEN unless unauthenticated access is enabled.",
            })}
          </p>
          {mcpPathError && (
            <p className="mt-2 text-xs leading-relaxed text-amber-700 dark:text-amber-400">
              {mcpPathError}
            </p>
          )}
          <pre className="mt-3 overflow-x-auto whitespace-pre-wrap break-all rounded-md bg-background/60 px-3 py-2 text-[11px] font-mono leading-relaxed">
            {hasUnsavedApiConfig
              ? t("settings.sections.apiServer.saveFirstExample", {
                  defaultValue: "Save settings first, then copy an example request.",
                })
              : !mcpEntryPath
                ? t("settings.sections.apiServer.mcpPathUnavailable", {
                    defaultValue:
                      "MCP server entry was not found. Run `npm run mcp:build` from the LLM Wiki repository, then reopen Settings.",
                  })
              : sampleMcpConfig}
          </pre>
        </div>
      </div>

      {/* ── Remote MCP access ────────────────────────────────────── */}
      <div className="space-y-3 rounded-lg border border-border/60 bg-muted/20 p-4">
        <label className="flex items-start gap-3">
          <input
            type="checkbox"
            checked={draft.remoteMcpEnabled}
            onChange={(event) => void handleToggleRemoteMcp(event.target.checked)}
            disabled={remoteMcpBusy}
            className="mt-1 h-4 w-4"
          />
          <div className="space-y-1">
            <div className="flex items-center gap-2 text-sm font-semibold">
              <Globe className="h-4 w-4 text-muted-foreground" />
              {t("settings.sections.apiServer.remoteMcpEnable", {
                defaultValue: "Enable remote MCP access",
              })}
              {remoteMcpBusy && (
                <RefreshCw className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
              )}
            </div>
            <p className="text-xs leading-relaxed text-muted-foreground">
              {t("settings.sections.apiServer.remoteMcpEnableHint", {
                defaultValue:
                  "Runs a separate HTTP+OAuth bridge so agents outside this machine (ChatGPT, Codex, Claude.ai) can reach this project over the internet — unlike the local API above, which only Codex/Claude CLI on this machine can use. Starts and stops immediately with this checkbox, and resumes automatically the next time you open the app. If Node.js isn't found on your system, it's downloaded automatically the first time (one-off, a few dozen MB).",
              })}
            </p>
          </div>
        </label>

        {(
          <>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="remote-mcp-port" className="text-xs">
                  {t("settings.sections.apiServer.remoteMcpPort", { defaultValue: "Local port" })}
                </Label>
                <Input
                  id="remote-mcp-port"
                  type="number"
                  min={1}
                  max={65535}
                  value={draft.remoteMcpPort}
                  disabled={remoteMcpRunning}
                  onChange={(event) => setDraft("remoteMcpPort", Number(event.target.value) || 8931)}
                  className="font-mono"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="remote-mcp-hostname" className="text-xs">
                  {t("settings.sections.apiServer.remoteMcpHostname", { defaultValue: "Your own domain (optional)" })}
                </Label>
                <Input
                  id="remote-mcp-hostname"
                  type="text"
                  value={draft.remoteMcpPublicHostname}
                  disabled={remoteMcpRunning}
                  onChange={(event) => setDraft("remoteMcpPublicHostname", event.target.value)}
                  placeholder={t("settings.sections.apiServer.remoteMcpHostnamePlaceholder", {
                    defaultValue: "e.g. mcp.example.com — leave empty for an auto-generated link",
                  })}
                  className="font-mono"
                  autoComplete="off"
                  spellCheck={false}
                />
              </div>
            </div>
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              {t("settings.sections.apiServer.remoteMcpHostnameHint", {
                defaultValue:
                  "Empty = a Cloudflare Quick Tunnel generates a free https://…trycloudflare.com link automatically (changes every time you start it — fine for testing, not for a permanent integration). Set your own domain here only if you already run a reverse proxy/tunnel pointed at the port above.",
              })}
            </p>

            <div className="space-y-1">
              <Label htmlFor="remote-mcp-vault-root" className="text-xs">
                {t("settings.sections.apiServer.remoteMcpVaultRoot", { defaultValue: "Linked vault folder (optional)" })}
              </Label>
              <Input
                id="remote-mcp-vault-root"
                type="text"
                value={draft.remoteMcpVaultRoot}
                disabled={remoteMcpRunning}
                onChange={(event) => setDraft("remoteMcpVaultRoot", event.target.value)}
                placeholder={t("settings.sections.apiServer.remoteMcpVaultRootPlaceholder", {
                  defaultValue: "Absolute path to an Obsidian-style vault — leave empty to skip",
                })}
                className="font-mono"
                autoComplete="off"
                spellCheck={false}
              />
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                {t("settings.sections.apiServer.remoteMcpVaultRootHint", {
                  defaultValue:
                    "When set, the bridge also exposes vault_read_note / vault_list_notes / vault_search_notes / vault_write_note / vault_append_note, plus vault_get_conventions (reads the vault's own CLAUDE.md or README.md so the connecting agent learns the vault's writing rules before it writes anything).",
                })}
              </p>
            </div>

            {/* Token */}
            <div className="space-y-1">
              <Label htmlFor="remote-mcp-token" className="text-xs">
                {t("settings.sections.apiServer.remoteMcpToken", { defaultValue: "Static API key" })}
              </Label>
              <div className="flex gap-2">
                <Input
                  id="remote-mcp-token"
                  type={showRemoteToken ? "text" : "password"}
                  value={draft.remoteMcpToken}
                  disabled={remoteMcpRunning}
                  onChange={(event) => setDraft("remoteMcpToken", event.target.value)}
                  placeholder={t("settings.sections.apiServer.remoteMcpTokenPlaceholder", {
                    defaultValue: "For clients without OAuth support — click Generate",
                  })}
                  className="font-mono"
                  autoComplete="off"
                  spellCheck={false}
                />
                <Button type="button" variant="outline" size="icon" onClick={() => setShowRemoteToken((v) => !v)}>
                  {showRemoteToken ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </Button>
                <Button type="button" variant="outline" size="icon" onClick={handleCopyRemoteToken} disabled={!draft.remoteMcpToken}>
                  <Copy className="h-4 w-4" />
                </Button>
              </div>
              <Button type="button" variant="outline" size="sm" onClick={handleGenerateRemoteToken} disabled={remoteMcpRunning} className="gap-1.5">
                <RefreshCw className="h-3.5 w-3.5" />
                {t("settings.sections.apiServer.generate", { defaultValue: "Generate new token" })}
              </Button>
              {copiedField === "remoteToken" && (
                <span className="ml-2 text-xs text-emerald-600 dark:text-emerald-400">
                  {t("settings.sections.apiServer.copied", { defaultValue: "Copied" })}
                </span>
              )}
            </div>

            {/* OAuth approval password */}
            <div className="space-y-1">
              <Label htmlFor="remote-mcp-password" className="text-xs">
                {t("settings.sections.apiServer.remoteMcpPassword", { defaultValue: "OAuth approval password" })}
              </Label>
              <div className="flex gap-2">
                <Input
                  id="remote-mcp-password"
                  type={showRemotePassword ? "text" : "password"}
                  value={draft.remoteMcpApprovalPassword}
                  disabled={remoteMcpRunning}
                  onChange={(event) => setDraft("remoteMcpApprovalPassword", event.target.value)}
                  placeholder={t("settings.sections.apiServer.remoteMcpPasswordPlaceholder", {
                    defaultValue: "Required for any client that self-registers via OAuth",
                  })}
                  className="font-mono"
                  autoComplete="off"
                  spellCheck={false}
                />
                <Button type="button" variant="outline" size="icon" onClick={() => setShowRemotePassword((v) => !v)}>
                  {showRemotePassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </Button>
                <Button type="button" variant="outline" size="icon" onClick={handleCopyRemotePassword} disabled={!draft.remoteMcpApprovalPassword}>
                  <Copy className="h-4 w-4" />
                </Button>
              </div>
              <Button type="button" variant="outline" size="sm" onClick={handleGenerateRemotePassword} disabled={remoteMcpRunning} className="gap-1.5">
                <RefreshCw className="h-3.5 w-3.5" />
                {t("settings.sections.apiServer.generate", { defaultValue: "Generate new password" })}
              </Button>
              {copiedField === "remotePassword" && (
                <span className="ml-2 text-xs text-emerald-600 dark:text-emerald-400">
                  {t("settings.sections.apiServer.copied", { defaultValue: "Copied" })}
                </span>
              )}
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                {t("settings.sections.apiServer.remoteMcpPasswordHint", {
                  defaultValue:
                    "Any MCP client can self-register (OAuth Dynamic Client Registration) — registering alone grants no access. This password is the actual gate: it's asked once, in a browser page, before a registered client gets a working token.",
                })}
              </p>
            </div>

            <div className="flex items-center gap-2 pt-1">
              <span className={`text-xs font-mono ${remoteMcpRunning ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground"}`}>
                {remoteMcpBusy
                  ? t("settings.sections.apiServer.remoteMcpBusy", { defaultValue: "Working…" })
                  : remoteMcpRunning
                    ? t("settings.sections.apiServer.remoteMcpRunning", { defaultValue: "Running" })
                    : t("settings.sections.apiServer.remoteMcpStopped", { defaultValue: "Stopped" })}
              </span>
            </div>

            {remoteMcpError && (
              <p className="text-xs leading-relaxed text-destructive">{remoteMcpError}</p>
            )}

            {remoteMcpRunning && (
              <div className="rounded-md border border-border/50 bg-background/50 p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-semibold">
                    {t("settings.sections.apiServer.remoteMcpUrl", { defaultValue: "Connect at" })}
                  </span>
                  {remoteMcpPublicUrl && (
                    <Button type="button" variant="outline" size="sm" onClick={handleCopyRemoteUrl} className="gap-1.5">
                      <Copy className="h-3.5 w-3.5" />
                      {copiedField === "remoteUrl"
                        ? t("settings.sections.apiServer.copied", { defaultValue: "Copied" })
                        : t("settings.sections.apiServer.copy", { defaultValue: "Copy" })}
                    </Button>
                  )}
                </div>
                <div className="mt-1 font-mono text-xs">
                  {remoteMcpPublicUrl
                    ? `${remoteMcpPublicUrl}/mcp`
                    : t("settings.sections.apiServer.remoteMcpUrlPending", {
                        defaultValue: "Waiting for the tunnel URL…",
                      })}
                </div>
              </div>
            )}

            <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-200">
              <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>
                {t("settings.sections.apiServer.remoteMcpWarning", {
                  defaultValue:
                    "Anyone with the static API key, or anyone who completes the OAuth approval step, gets the same access as a local MCP client — including write access if a vault folder is linked. Treat both secrets like passwords.",
                })}
              </span>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

import { useCallback, useEffect, useMemo, useState } from "react"
import {
  Copy,
  Eye,
  EyeOff,
  ExternalLink,
  RefreshCw,
  Server,
  ShieldAlert,
} from "lucide-react"
import { useTranslation } from "react-i18next"
import { openUrl } from "@tauri-apps/plugin-opener"
import { apiServerStatus, mcpServerEntryPath } from "@/commands/fs"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { API_SERVER_BASE_URL, API_SERVER_HEALTH_URL } from "@/lib/api-server-constants"
import { generateApiToken } from "@/lib/api-token"
import { useWikiStore } from "@/stores/wiki-store"
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
]

export function ApiServerSection({ draft, setDraft }: Props) {
  const { t } = useTranslation()
  const [showToken, setShowToken] = useState(false)
  const [copiedField, setCopiedField] = useState<"token" | "curl" | "mcp" | null>(null)
  const [serverStatus, setServerStatus] = useState<string>("...")
  const [health, setHealth] = useState<ApiHealth | null>(null)
  const [mcpEntryPath, setMcpEntryPath] = useState<string | null>(null)
  const [mcpPathError, setMcpPathError] = useState<string | null>(null)
  const persistedApiConfig = useWikiStore((s) => s.apiConfig)

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
    return () => {
      alive = false
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
    return `curl -H 'Authorization: Bearer ${tokenForExample}' ${API_SERVER_BASE_URL}/api/v1/projects`
  }, [draft.apiAllowUnauthenticated, draft.apiToken])

  const sampleMcpConfig = useMemo(() => {
    if (!mcpEntryPath) return ""
    const env = draft.apiAllowUnauthenticated
      ? {}
      : { LLM_WIKI_API_TOKEN: draft.apiToken || "<your-token>" }
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
  }, [draft.apiAllowUnauthenticated, draft.apiToken, mcpEntryPath])

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
              defaultValue: "Opens in your system browser. /health is the only unauthenticated endpoint.",
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
                "Required unless unauthenticated access is enabled. Send as `Authorization: Bearer <token>` or `X-LLM-Wiki-Token: <token>`. The environment variable LLM_WIKI_API_TOKEN overrides this field if set.",
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
                defaultValue: "No token — every endpoint will return 401",
              })}
            </span>
          )}
          {tokenStrength === "unused" && (
            <span className="text-xs text-amber-700 dark:text-amber-400">
              {t("settings.sections.apiServer.tokenUnused", {
                defaultValue: "Token is not used while unauthenticated access is enabled",
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
    </div>
  )
}

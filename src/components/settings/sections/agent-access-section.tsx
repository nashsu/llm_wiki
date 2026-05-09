import { useCallback, useEffect, useState } from "react"
import { AlertTriangle, Check, Copy } from "lucide-react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import { clipServerStatus, mcpServerConfig, type McpServerConfig } from "@/commands/fs"
import { saveMcpAccessEnabled } from "@/lib/project-store"
import { useWikiStore } from "@/stores/wiki-store"

type CopyTarget = "codex" | "json"

export function AgentAccessSection() {
  const { t } = useTranslation()
  const project = useWikiStore((s) => s.project)
  const mcpAccessEnabled = useWikiStore((s) => s.mcpAccessEnabled)
  const setMcpAccessEnabled = useWikiStore((s) => s.setMcpAccessEnabled)
  const [clipStatus, setClipStatus] = useState("...")
  const [config, setConfig] = useState<McpServerConfig | null>(null)
  const [configError, setConfigError] = useState("")
  const [saving, setSaving] = useState(false)
  const [copied, setCopied] = useState<CopyTarget | null>(null)

  useEffect(() => {
    let alive = true

    clipServerStatus()
      .then((status) => {
        if (alive) setClipStatus(status)
      })
      .catch(() => {
        if (alive) setClipStatus("unknown")
      })

    mcpServerConfig()
      .then((next) => {
        if (!alive) return
        setConfig(next)
        setConfigError("")
      })
      .catch((err) => {
        if (!alive) return
        const message = err instanceof Error ? err.message : String(err)
        setConfigError(message)
      })

    return () => {
      alive = false
    }
  }, [])

  const handleToggle = useCallback(
    async (enabled: boolean) => {
      const previous = useWikiStore.getState().mcpAccessEnabled
      setSaving(true)
      setMcpAccessEnabled(enabled)
      try {
        await saveMcpAccessEnabled(enabled)
      } catch (err) {
        setMcpAccessEnabled(previous)
        setConfigError(err instanceof Error ? err.message : String(err))
      } finally {
        setSaving(false)
      }
    },
    [setMcpAccessEnabled],
  )

  const handleCopy = useCallback(async (target: CopyTarget, value: string) => {
    await navigator.clipboard.writeText(value)
    setCopied(target)
    setTimeout(() => setCopied(null), 1800)
  }, [])

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold">
          {t("settings.sections.agentAccess.title", { defaultValue: "Agent Access" })}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("settings.sections.agentAccess.description", {
            defaultValue:
              "Allow local agents to use this app through the LLM Wiki MCP server.",
          })}
        </p>
      </div>

      <label className="flex items-start gap-2">
        <input
          type="checkbox"
          checked={mcpAccessEnabled}
          disabled={saving}
          onChange={(e) => handleToggle(e.target.checked)}
          className="mt-0.5 h-4 w-4"
        />
        <div className="space-y-1">
          <span className="text-sm">
            {t("settings.sections.agentAccess.enable", {
              defaultValue: "Enable MCP access for local agents",
            })}
          </span>
          <p className="text-xs text-muted-foreground">
            {mcpAccessEnabled
              ? t("settings.sections.agentAccess.enabledHint", {
                  defaultValue:
                    "Agents can call the local LLM Wiki API after you add the MCP server to the agent client.",
                })
              : t("settings.sections.agentAccess.disabledHint", {
                  defaultValue:
                    "Agent API requests will get a clear disabled error instead of waiting for a timeout.",
                })}
          </p>
        </div>
      </label>

      <div className="rounded-md border divide-y">
        <StatusRow
          label={t("settings.sections.agentAccess.clipServer", { defaultValue: "Clip server" })}
          value={`${clipStatus}  @  127.0.0.1:19827`}
          mono
        />
        <StatusRow
          label={t("settings.sections.agentAccess.mcpAccess", { defaultValue: "MCP access" })}
          value={
            mcpAccessEnabled
              ? t("settings.sections.agentAccess.enabled", { defaultValue: "Enabled" })
              : t("settings.sections.agentAccess.disabled", { defaultValue: "Disabled" })
          }
        />
        <StatusRow
          label={t("settings.sections.agentAccess.currentProject", { defaultValue: "Current project" })}
          value={
            project?.path ??
            t("settings.sections.agentAccess.noProject", {
              defaultValue: "Open a project first.",
            })
          }
          mono={!!project?.path}
        />
      </div>

      {!mcpAccessEnabled && (
        <div className="flex items-start gap-2 rounded-md border bg-muted/30 p-3 text-sm text-muted-foreground">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <p>
            {t("settings.sections.agentAccess.disabledNotice", {
              defaultValue:
                "Turn this on before using the MCP tools from Codex or another local agent.",
            })}
          </p>
        </div>
      )}

      {mcpAccessEnabled && configError && (
        <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <p>{configError}</p>
        </div>
      )}

      {mcpAccessEnabled && config && (
        <div className="space-y-4">
          <CopyBlock
            title={t("settings.sections.agentAccess.codexCommand", {
              defaultValue: "Codex command",
            })}
            value={config.codexCommand}
            copied={copied === "codex"}
            onCopy={() => handleCopy("codex", config.codexCommand)}
          />
          <CopyBlock
            title={t("settings.sections.agentAccess.jsonConfig", {
              defaultValue: "MCP JSON config",
            })}
            value={config.jsonConfig}
            copied={copied === "json"}
            onCopy={() => handleCopy("json", config.jsonConfig)}
          />
          <p className="text-xs text-muted-foreground">
            {t("settings.sections.agentAccess.restartHint", {
              defaultValue:
                "After adding the MCP server to an agent client, start a new agent session so the tools are discovered.",
            })}
          </p>
        </div>
      )}
    </div>
  )
}

function StatusRow({
  label,
  value,
  mono = false,
}: {
  label: string
  value: string
  mono?: boolean
}) {
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-2.5">
      <span className="shrink-0 text-sm text-muted-foreground">{label}</span>
      <span className={`min-w-0 truncate text-right text-sm ${mono ? "font-mono" : ""}`}>
        {value}
      </span>
    </div>
  )
}

function CopyBlock({
  title,
  value,
  copied,
  onCopy,
}: {
  title: string
  value: string
  copied: boolean
  onCopy: () => void
}) {
  const { t } = useTranslation()

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-medium">{title}</h3>
        <Button variant="outline" size="sm" onClick={onCopy} className="h-8 gap-1.5">
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          {copied
            ? t("settings.sections.agentAccess.copied", { defaultValue: "Copied" })
            : t("settings.sections.agentAccess.copy", { defaultValue: "Copy" })}
        </Button>
      </div>
      <pre className="max-h-48 overflow-auto rounded-md border bg-muted/30 p-3 text-xs font-mono leading-relaxed">
        {value}
      </pre>
    </div>
  )
}

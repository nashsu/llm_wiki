import { useTranslation } from "react-i18next"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { AlertTriangle } from "lucide-react"
import { validateProxyUrl } from "@/lib/proxy-config"
import type { SettingsDraft, DraftSetter } from "../settings-types"

interface Props {
  draft: SettingsDraft
  setDraft: DraftSetter
}

export function NetworkSection({ draft, setDraft }: Props) {
  const { t } = useTranslation()

  // Live URL validation — only flag the user when they've actually
  // typed something. Empty + enabled is "form not yet finished",
  // not a hard error.
  const trimmed = draft.proxyUrl.trim()
  const validation = trimmed === "" ? null : validateProxyUrl(trimmed)
  const showError = draft.proxyEnabled && validation && !validation.ok

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold">
          {t("settings.sections.network.title", { defaultValue: "Network" })}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("settings.sections.network.description", {
            defaultValue:
              "Route all outbound HTTP requests (LLM, embedding, search, update check) through a proxy. Changes apply on Save — no restart needed.",
          })}
        </p>
      </div>

      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={draft.proxyEnabled}
          onChange={(e) => setDraft("proxyEnabled", e.target.checked)}
          className="h-4 w-4"
        />
        <span className="text-sm">
          {t("settings.sections.network.enable", {
            defaultValue: "Enable proxy",
          })}
        </span>
      </label>

      <div className="space-y-2">
        <Label htmlFor="proxy-url">
          {t("settings.sections.network.url", { defaultValue: "Proxy URL" })}
        </Label>
        <Input
          id="proxy-url"
          value={draft.proxyUrl}
          onChange={(e) => setDraft("proxyUrl", e.target.value)}
          placeholder="http://127.0.0.1:7890"
          disabled={!draft.proxyEnabled}
          className={showError ? "border-destructive" : ""}
        />
        <p className="text-xs text-muted-foreground">
          {t("settings.sections.network.urlHelp", {
            defaultValue:
              "Full URL with scheme. Supported: http://, https://. (SOCKS5 not supported in this version.)",
          })}
        </p>
        {showError && validation && !validation.ok && (
          <p className="flex items-center gap-1 text-xs text-destructive">
            <AlertTriangle className="h-3 w-3" />
            {validation.error}
          </p>
        )}
      </div>

      <label className="flex items-start gap-2">
        <input
          type="checkbox"
          checked={draft.proxyBypassLocal}
          onChange={(e) => setDraft("proxyBypassLocal", e.target.checked)}
          disabled={!draft.proxyEnabled}
          className="mt-0.5 h-4 w-4"
        />
        <div className="space-y-1">
          <span className="text-sm">
            {t("settings.sections.network.bypassLocal", {
              defaultValue: "Bypass proxy for local addresses (recommended)",
            })}
          </span>
          <p className="text-xs text-muted-foreground">
            {t("settings.sections.network.bypassLocalHelp", {
              defaultValue:
                "Requests to localhost, 127.0.0.0/8, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, and *.local don't go through the proxy. Keep this on if you use Ollama / LM Studio / other local or LAN-deployed LLMs.",
            })}
          </p>
        </div>
      </label>

    </div>
  )
}

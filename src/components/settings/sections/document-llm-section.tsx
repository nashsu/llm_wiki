import { useTranslation } from "react-i18next"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { ContextSizeSelector } from "../context-size-selector"
import type { SettingsDraft, DraftSetter } from "../settings-types"

interface Props {
  draft: SettingsDraft
  setDraft: DraftSetter
}

const PROVIDER_OPTIONS: Array<{ value: SettingsDraft["documentProvider"]; label: string }> = [
  { value: "custom", label: "Custom (OpenAI-compat)" },
  { value: "openai", label: "OpenAI" },
  { value: "anthropic", label: "Anthropic" },
  { value: "google", label: "Google (Gemini)" },
  { value: "ollama", label: "Ollama" },
  { value: "claude-code", label: "Claude Code CLI" },
  { value: "minimax", label: "MiniMax" },
]

const REASONING_OPTIONS = [
  { value: "auto", label: "Auto" },
  { value: "off", label: "Off" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "max", label: "Max" },
  { value: "custom", label: "Custom" },
] as const

export function DocumentLlmSection({ draft, setDraft }: Props) {
  const { t } = useTranslation()
  const reasoning = draft.documentReasoning ?? { mode: "auto" as const }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold">{t("settings.sections.document.title")}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("settings.sections.document.description")}
        </p>
      </div>

      <div className="flex items-center justify-between gap-3 rounded-md border p-3">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium">
            {t("settings.sections.document.useMainLabel")}
          </div>
          <div className="text-xs text-muted-foreground">
            {t("settings.sections.document.useMainHint")}
          </div>
        </div>
        <button
          type="button"
          onClick={() => setDraft("documentUseMainLlm", !draft.documentUseMainLlm)}
          role="switch"
          aria-checked={draft.documentUseMainLlm}
          aria-label={t("settings.sections.document.useMainLabel")}
          className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${
            draft.documentUseMainLlm ? "bg-primary" : "bg-muted"
          }`}
        >
          <span
            className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform ${
              draft.documentUseMainLlm ? "translate-x-4.5" : "translate-x-0.5"
            }`}
          />
        </button>
      </div>

      {!draft.documentUseMainLlm && (
        <div className="space-y-4 rounded-md border p-3">
          <div className="text-sm font-medium">
            {t("settings.sections.document.dedicatedHeading")}
          </div>

          <div className="space-y-2">
            <Label>{t("settings.sections.document.provider")}</Label>
            <select
              className="w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              value={draft.documentProvider}
              onChange={(e) => setDraft("documentProvider", e.target.value as SettingsDraft["documentProvider"])}
            >
              {PROVIDER_OPTIONS.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </select>
          </div>

          {draft.documentProvider === "ollama" && (
            <div className="space-y-2">
              <Label>{t("settings.sections.document.ollamaUrl")}</Label>
              <Input
                value={draft.documentOllamaUrl}
                onChange={(e) => setDraft("documentOllamaUrl", e.target.value)}
                placeholder="http://localhost:11434"
              />
            </div>
          )}

          {draft.documentProvider === "custom" && (
            <div className="space-y-2">
              <Label>{t("settings.sections.document.customEndpoint")}</Label>
              <Input
                value={draft.documentCustomEndpoint}
                onChange={(e) => setDraft("documentCustomEndpoint", e.target.value)}
                placeholder="http://localhost:1234/v1"
              />
              <p className="text-xs text-muted-foreground">
                {t("settings.sections.document.customEndpointHint")}
              </p>
            </div>
          )}

          {draft.documentProvider !== "ollama" && draft.documentProvider !== "claude-code" && (
            <div className="space-y-2">
              <Label>{t("settings.sections.document.apiKey")}</Label>
              <Input
                type="password"
                value={draft.documentApiKey}
                onChange={(e) => setDraft("documentApiKey", e.target.value)}
                placeholder={t("settings.sections.document.apiKeyPlaceholder")}
              />
            </div>
          )}

          <div className="space-y-2">
            <Label>{t("settings.sections.document.model")}</Label>
            <Input
              value={draft.documentModel}
              onChange={(e) => setDraft("documentModel", e.target.value)}
              placeholder={t("settings.sections.document.modelPlaceholder")}
            />
            <p className="text-xs text-muted-foreground">
              {t("settings.sections.document.modelHint")}
            </p>
          </div>

          <div className="space-y-2">
            <Label>{t("settings.sections.document.contextWindow")}</Label>
            <ContextSizeSelector
              value={draft.documentMaxContextSize}
              onChange={(v) => setDraft("documentMaxContextSize", v)}
            />
          </div>

          <div className="space-y-2">
            <Label>{t("settings.sections.document.reasoning")}</Label>
            <div className="flex flex-wrap gap-1.5">
              {REASONING_OPTIONS.map((m) => {
                const active = reasoning.mode === m.value
                return (
                  <button
                    key={m.value}
                    type="button"
                    onClick={() => setDraft("documentReasoning", { ...reasoning, mode: m.value })}
                    className={`rounded-md border px-2.5 py-1 text-xs transition-colors ${
                      active
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-border hover:bg-accent"
                    }`}
                  >
                    {m.label}
                  </button>
                )
              })}
            </div>
            {reasoning.mode === "custom" && (
              <div className="flex items-center gap-2">
                <Input
                  type="number"
                  min={0}
                  className="w-28"
                  value={reasoning.budgetTokens ?? ""}
                  onChange={(e) => {
                    const raw = e.target.value.trim()
                    const n = Number(raw)
                    setDraft("documentReasoning", {
                      ...reasoning,
                      budgetTokens: raw === "" || !Number.isFinite(n) ? undefined : Math.max(0, n),
                    })
                  }}
                  placeholder="1024"
                />
                <span className="text-xs text-muted-foreground">
                  {t("settings.sections.document.reasoningBudget")}
                </span>
              </div>
            )}
            <p className="text-xs text-muted-foreground">
              {t("settings.sections.document.reasoningHint")}
            </p>
          </div>
        </div>
      )}
    </div>
  )
}

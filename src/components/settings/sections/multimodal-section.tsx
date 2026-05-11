import { useTranslation } from "react-i18next"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import type { SettingsDraft, DraftSetter } from "../settings-types"

interface Props {
  draft: SettingsDraft
  setDraft: DraftSetter
}

const PROVIDER_OPTIONS: Array<{ value: SettingsDraft["multimodalProvider"]; label: string }> = [
  { value: "custom", label: "自定义（OpenAI 兼容）" },
  { value: "openai", label: "OpenAI" },
  { value: "anthropic", label: "Anthropic" },
  { value: "google", label: "Google (Gemini)" },
  { value: "ollama", label: "Ollama" },
]

export function MultimodalSection({ draft, setDraft }: Props) {
  const { t } = useTranslation()

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold">{t("settings.sections.multimodal.title", "Image captioning")}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t(
            "settings.sections.multimodal.description",
            "Generate factual captions for images extracted from PDFs / DOCX / PPTX during ingest. Captions are inserted as alt text inside the source markdown — they're what semantic search matches when you search for image content. Cached by image hash so duplicate logos / charts only call the LLM once.",
          )}
        </p>
      </div>

      {/* Master toggle. Off by default — captioning is a non-trivial
          token spend (one VLM call per image), and silently turning
          it on for every user the first time they import a PDF
          would surprise the budget.

          Note: the toggle row deliberately uses a 2-tier border +
          a textual ON/OFF state next to the pill switch. An earlier
          version had only the small pill and several users missed
          it entirely — pills are subtle when surrounded by long
          help text. The textual ON/OFF and the matching colored
          ring make the current state unambiguous at a glance. */}
      <div
        className={`flex items-center justify-between rounded-md border-2 p-3 transition-colors ${
          draft.multimodalEnabled
            ? "border-primary/40 bg-primary/5"
            : "border-border bg-background"
        }`}
      >
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium">
            {t("settings.sections.multimodal.enableLabel", "Enable captioning at ingest")}
          </div>
          <div className="text-xs text-muted-foreground">
            {t(
              "settings.sections.multimodal.enableHint",
              "Off: images still get extracted, just no captions. Search won't find them by visual content. On: each new image triggers one vision-LLM call (cached by hash).",
            )}
          </div>
        </div>
        <button
          type="button"
          onClick={() => setDraft("multimodalEnabled", !draft.multimodalEnabled)}
          role="switch"
          aria-checked={draft.multimodalEnabled}
          aria-label={t("settings.sections.multimodal.enableLabel", "Enable captioning at ingest")}
          className="ml-3 flex shrink-0 items-center gap-2"
        >
          <span
            className={`text-xs font-semibold ${
              draft.multimodalEnabled ? "text-primary" : "text-muted-foreground"
            }`}
          >
            {draft.multimodalEnabled
              ? t("settings.sections.multimodal.stateOn", "ON")
              : t("settings.sections.multimodal.stateOff", "OFF")}
          </span>
          <span
            className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
              draft.multimodalEnabled ? "bg-primary" : "bg-muted"
            }`}
          >
            <span
              className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform ${
                draft.multimodalEnabled ? "translate-x-4.5" : "translate-x-0.5"
              }`}
            />
          </span>
        </button>
      </div>

      {draft.multimodalEnabled && (
        <>
          {/* "Use main LLM" toggle. Lets users with a single VL-capable
              model in their main config save the trouble of typing
              everything twice. The dedicated fields below show only
              when this is OFF.

              Layout: the text column needs `min-w-0 flex-1` so a
              long help text wraps inside its column instead of
              shoving the toggle off to the right (or worse,
              forcing the row's intrinsic width past the parent).
              Without this the row visibly broke in English where
              the multi-clause hint sentence is much longer than
              the equivalent CJK text. The toggle gets `shrink-0`
              for the symmetric reason — never lose the toggle to
              the text column. */}
          <div className="flex items-center justify-between gap-3 rounded-md border p-3">
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium">
                {t("settings.sections.multimodal.useMainLabel", "Use main LLM for captions")}
              </div>
              <div className="text-xs text-muted-foreground">
                {t(
                  "settings.sections.multimodal.useMainHint",
                  "Reuse the model picked under Settings → LLM provider. Only enable this if that model accepts image input — text-only models will return a 400.",
                )}
              </div>
            </div>
            <button
              type="button"
              onClick={() => setDraft("multimodalUseMainLlm", !draft.multimodalUseMainLlm)}
              role="switch"
              aria-checked={draft.multimodalUseMainLlm}
              aria-label={t(
                "settings.sections.multimodal.useMainLabel",
                "Use main LLM for captions",
              )}
              className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${
                draft.multimodalUseMainLlm ? "bg-primary" : "bg-muted"
              }`}
            >
              <span
                className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform ${
                  draft.multimodalUseMainLlm ? "translate-x-4.5" : "translate-x-0.5"
                }`}
              />
            </button>
          </div>

          {!draft.multimodalUseMainLlm && (
            <div className="space-y-4 rounded-md border p-3">
              <div className="text-sm font-medium">
                {t("settings.sections.multimodal.dedicatedHeading", "Dedicated vision endpoint")}
              </div>

              <div className="space-y-2">
                <Label>{t("settings.sections.multimodal.provider", "Provider")}</Label>
                <select
                  className="w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                  value={draft.multimodalProvider}
                  onChange={(e) =>
                    setDraft("multimodalProvider", e.target.value as SettingsDraft["multimodalProvider"])
                  }
                >
                  {PROVIDER_OPTIONS.map((p) => (
                    <option key={p.value} value={p.value}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </div>

              {draft.multimodalProvider === "ollama" && (
                <div className="space-y-2">
                  <Label>{t("settings.sections.multimodal.ollamaUrl", "Ollama URL")}</Label>
                  <Input
                    value={draft.multimodalOllamaUrl}
                    onChange={(e) => setDraft("multimodalOllamaUrl", e.target.value)}
                    placeholder="http://localhost:11434"
                  />
                </div>
              )}

              {draft.multimodalProvider === "custom" && (
                <div className="space-y-2">
                  <Label>{t("settings.sections.multimodal.customEndpoint", "Endpoint URL")}</Label>
                  <Input
                    value={draft.multimodalCustomEndpoint}
                    onChange={(e) => setDraft("multimodalCustomEndpoint", e.target.value)}
                    placeholder="http://localhost:1234/v1"
                  />
                  <p className="text-xs text-muted-foreground">
                    {t(
                      "settings.sections.multimodal.customEndpointHint",
                      "OpenAI-compatible /v1 base. LM Studio, llama.cpp server, vLLM, LocalAI all work.",
                    )}
                  </p>
                </div>
              )}

              <div className="space-y-2">
                <Label>{t("settings.sections.multimodal.apiKey", "API key")}</Label>
                <Input
                  type="password"
                  value={draft.multimodalApiKey}
                  onChange={(e) => setDraft("multimodalApiKey", e.target.value)}
                  placeholder={t(
                    "settings.sections.multimodal.apiKeyPlaceholder",
                    "Leave blank for local / no-auth endpoints",
                  )}
                />
              </div>

              <div className="space-y-2">
                <Label>{t("settings.sections.multimodal.model", "Model")}</Label>
                <Input
                  value={draft.multimodalModel}
                  onChange={(e) => setDraft("multimodalModel", e.target.value)}
                  placeholder="e.g. Qwen2.5-VL-7B-Instruct, claude-3-5-sonnet-latest, gemini-2.5-flash"
                />
                <p className="text-xs text-muted-foreground">
                  {t(
                    "settings.sections.multimodal.modelHint",
                    "Must be a vision-capable model. Text-only models will fail with a 400 / image-not-supported error at first ingest.",
                  )}
                </p>
              </div>
            </div>
          )}

          {/* Concurrency knob — practical impact: a 30-image PDF at
              concurrency=1 with a 10s/image VLM is 5 minutes of
              ingest wall time; concurrency=4 makes it ~75s. Going
              wider than ~8 is rarely a win on a single-GPU server
              that batches under the hood anyway. */}
          <div className="space-y-2 rounded-md border p-3">
            <Label>{t("settings.sections.multimodal.concurrency", "Concurrent caption requests")}</Label>
            <Input
              type="number"
              min={1}
              max={16}
              step={1}
              value={draft.multimodalConcurrency}
              onChange={(e) => {
                const n = Number(e.target.value)
                setDraft("multimodalConcurrency", Number.isFinite(n) ? n : 4)
              }}
            />
            <p className="text-xs text-muted-foreground">
              {t(
                "settings.sections.multimodal.concurrencyHint",
                "How many caption requests run in parallel. 1 = strictly sequential. 4 is a good default for most setups; raise to 8+ only on a beefy GPU or hosted endpoint.",
              )}
            </p>
          </div>

          {/* Cost guardrail panel — mostly informational for now. */}
          <div className="space-y-1 rounded-md border border-amber-500/40 bg-amber-500/5 p-3">
            <div className="text-sm font-medium text-amber-700 dark:text-amber-400">
              {t("settings.sections.multimodal.costHeading", "Cost guardrails")}
            </div>
            <ul className="ml-4 list-disc space-y-1 text-xs text-muted-foreground">
              <li>
                {t(
                  "settings.sections.multimodal.costPoint1",
                  "Each new image triggers one vision-LLM call (~500-2000 tokens depending on model + thinking mode).",
                )}
              </li>
              <li>
                {t(
                  "settings.sections.multimodal.costPoint2",
                  "Captions are cached by SHA-256 of image bytes. Duplicate logos / shared chart templates across documents only ever incur ONE call.",
                )}
              </li>
              <li>
                {t(
                  "settings.sections.multimodal.costPoint3",
                  "Rust-side filter drops images smaller than 100×100 px and caps at 500 images per source — pathological PDFs can't blow up the bill.",
                )}
              </li>
              <li>
                {t(
                  "settings.sections.multimodal.costPoint4",
                  "Prefer a local vision model (Qwen2.5-VL via LM Studio / Ollama) for bulk ingestion; reserve hosted vision APIs for one-off high-stakes documents.",
                )}
              </li>
            </ul>
          </div>
        </>
      )}
    </div>
  )
}

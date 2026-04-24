import { useEffect, useMemo, useState } from "react"
import { ChevronDown, ChevronRight, AlertCircle, CheckCircle2, Loader2, XCircle } from "lucide-react"
import { useTranslation } from "react-i18next"
import { invoke } from "@tauri-apps/api/core"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { useWikiStore, type ProviderOverride } from "@/stores/wiki-store"
import { LLM_PRESETS, type LlmPreset } from "../llm-presets"
import { ContextSizeSelector } from "../context-size-selector"
import { resolveConfig } from "../preset-resolver"
import { normalizeEndpoint } from "@/lib/endpoint-normalizer"

export function LlmProviderSection() {
  const { t } = useTranslation()
  const providerConfigs = useWikiStore((s) => s.providerConfigs)
  const setProviderConfigs = useWikiStore((s) => s.setProviderConfigs)
  const activePresetId = useWikiStore((s) => s.activePresetId)
  const setActivePresetId = useWikiStore((s) => s.setActivePresetId)
  const setLlmConfig = useWikiStore((s) => s.setLlmConfig)
  const llmConfig = useWikiStore((s) => s.llmConfig)

  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [savedId, setSavedId] = useState<string | null>(null)

  function toggleExpand(id: string) {
    setExpanded((prev) => ({ ...prev, [id]: !prev[id] }))
  }

  async function persist(newConfigs: typeof providerConfigs, newActive: string | null) {
    const { saveProviderConfigs, saveActivePresetId, saveLlmConfig } = await import(
      "@/lib/project-store"
    )
    await saveProviderConfigs(newConfigs)
    await saveActivePresetId(newActive)
    if (newActive) {
      const preset = LLM_PRESETS.find((p) => p.id === newActive)
      if (preset) {
        const resolved = resolveConfig(preset, newConfigs[newActive], llmConfig)
        setLlmConfig(resolved)
        await saveLlmConfig(resolved)
      }
    }
  }

  function updateOverride(id: string, patch: ProviderOverride) {
    const merged: ProviderOverride = { ...(providerConfigs[id] ?? {}), ...patch }
    const next = { ...providerConfigs, [id]: merged }
    setProviderConfigs(next)
    persist(next, activePresetId).catch(() => {})
    // If this preset is active, refresh the resolved LlmConfig live.
    if (id === activePresetId) {
      const preset = LLM_PRESETS.find((p) => p.id === id)
      if (preset) setLlmConfig(resolveConfig(preset, merged, llmConfig))
    }
    setSavedId(id)
    setTimeout(() => setSavedId((cur) => (cur === id ? null : cur)), 1500)
  }

  function toggleActive(id: string) {
    const next = id === activePresetId ? null : id
    setActivePresetId(next)
    persist(providerConfigs, next).catch(() => {})
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-xl font-semibold">{t("settings.sections.llm.title")}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("settings.sections.llm.description")}
        </p>
      </div>

      <div className="space-y-2">
        {LLM_PRESETS.map((preset) => (
          <PresetRow
            key={preset.id}
            preset={preset}
            override={providerConfigs[preset.id]}
            isActive={activePresetId === preset.id}
            isExpanded={!!expanded[preset.id]}
            savedHere={savedId === preset.id}
            onToggleActive={() => toggleActive(preset.id)}
            onToggleExpand={() => toggleExpand(preset.id)}
            onChange={(patch) => updateOverride(preset.id, patch)}
          />
        ))}
      </div>
    </div>
  )
}

interface PresetRowProps {
  preset: LlmPreset
  override: ProviderOverride | undefined
  isActive: boolean
  isExpanded: boolean
  savedHere: boolean
  onToggleActive: () => void
  onToggleExpand: () => void
  onChange: (patch: ProviderOverride) => void
}

function PresetRow({
  preset,
  override,
  isActive,
  isExpanded,
  savedHere,
  onToggleActive,
  onToggleExpand,
  onChange,
}: PresetRowProps) {
  const ov = override ?? {}
  const model = ov.model ?? preset.defaultModel ?? ""
  const apiKey = ov.apiKey ?? ""
  const apiMode = ov.apiMode ?? preset.apiMode ?? "chat_completions"
  const baseUrl = ov.baseUrl ?? preset.baseUrl ?? ""
  const context = ov.maxContextSize ?? preset.suggestedContextSize ?? 131072
  const hasConfig = !!apiKey || !!ov.baseUrl || !!ov.model
  // Claude Code CLI authenticates via the user's existing ~/.claude OAuth
  // (inherited from the spawned subprocess), so no API key field is
  // shown. Ollama ditto for its local-only model.
  const needsApiKey = preset.provider !== "ollama" && preset.provider !== "claude-code"

  return (
    <div
      className={`rounded-lg border transition-colors ${
        isActive ? "border-primary/60 bg-primary/5" : "border-border"
      }`}
    >
      {/* Outer row — always visible */}
      <div className="flex items-center gap-3 px-3 py-2.5">
        <button
          type="button"
          onClick={onToggleExpand}
          className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-accent"
          title={isExpanded ? "收起" : "展开配置"}
        >
          {isExpanded ? (
            <ChevronDown className="h-4 w-4" />
          ) : (
            <ChevronRight className="h-4 w-4" />
          )}
        </button>

        <button
          type="button"
          onClick={onToggleExpand}
          className="min-w-0 flex-1 text-left"
        >
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium">{preset.label}</span>
            {hasConfig && !isActive && (
              <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                已配置
              </span>
            )}
            {isActive && (
              <span className="shrink-0 rounded-full bg-primary/20 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                ● 活跃
              </span>
            )}
            {savedHere && (
              <span className="shrink-0 text-[10px] text-emerald-600">已保存</span>
            )}
          </div>
          {preset.hint && (
            <div className="mt-0.5 truncate text-xs text-muted-foreground">
              {preset.hint}
            </div>
          )}
        </button>

        {/* Toggle switch */}
        <button
          type="button"
          onClick={onToggleActive}
          className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors ${
            isActive
              ? "border-primary bg-primary"
              : "border-muted-foreground/30 bg-muted-foreground/20 hover:bg-muted-foreground/30"
          }`}
          title={isActive ? "点击关闭" : "点击启用(会关闭其他 provider)"}
          aria-label={isActive ? "Deactivate" : "Activate"}
        >
          <span
            className={`inline-block h-3.5 w-3.5 rounded-full bg-white shadow-sm ring-1 ring-black/10 transition-transform ${
              isActive ? "translate-x-4" : "translate-x-0.5"
            }`}
          />
        </button>
      </div>

      {/* Expanded config panel */}
      {isExpanded && (
        <div className="space-y-4 border-t bg-background/50 px-4 py-3">
          {preset.provider === "custom" && (
            <div className="space-y-2">
              <Label>API 模式</Label>
              <div className="flex flex-wrap gap-2">
                {(
                  [
                    { value: "chat_completions", label: "OpenAI 兼容" },
                    { value: "anthropic_messages", label: "Anthropic 兼容" },
                  ] as const
                ).map((m) => {
                  const active = apiMode === m.value
                  return (
                    <button
                      key={m.value}
                      type="button"
                      onClick={() => {
                        // When a preset declares different base URLs for
                        // each wire (e.g. Bailian Coding Plan: /v1 for
                        // OpenAI, /apps/anthropic for Anthropic), flip
                        // the URL alongside the mode so users don't have
                        // to know both URLs or edit manually.
                        const patch: ProviderOverride = { apiMode: m.value }
                        const nextBaseUrl = preset.baseUrlByMode?.[m.value]
                        if (nextBaseUrl) patch.baseUrl = nextBaseUrl
                        onChange(patch)
                      }}
                      className={`rounded-md border px-3 py-1.5 text-sm transition-colors ${
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
            </div>
          )}

          {(preset.provider === "custom" || preset.provider === "ollama") && (
            <EndpointField
              value={baseUrl}
              mode={apiMode}
              placeholder={preset.baseUrl ?? "https://your-api.example.com/v1"}
              onChange={(v) => onChange({ baseUrl: v })}
            />
          )}

          {preset.provider === "claude-code" && <ClaudeCliStatusPill />}

          {needsApiKey && (
            <div className="space-y-2">
              <Label>API Key</Label>
              <Input
                type="password"
                value={apiKey}
                onChange={(e) => onChange({ apiKey: e.target.value })}
                placeholder={
                  preset.provider === "custom"
                    ? "无 Key 可留空(本地模型)"
                    : "Enter your API key"
                }
              />
            </div>
          )}

          <div className="space-y-2">
            <Label>Model</Label>
            <ModelPicker
              value={model}
              suggestions={preset.suggestedModels ?? []}
              placeholder={preset.defaultModel ?? "e.g. gpt-4o"}
              onChange={(v) => onChange({ model: v })}
            />
          </div>

          <div className="space-y-2">
            <Label>Context window</Label>
            <ContextSizeSelector
              value={context}
              onChange={(v) => onChange({ maxContextSize: v })}
            />
          </div>
        </div>
      )}
    </div>
  )
}

interface EndpointFieldProps {
  value: string
  mode: "chat_completions" | "anthropic_messages"
  placeholder: string
  onChange: (value: string) => void
}

/**
 * Endpoint input with live feedback + auto-fix on blur. The hint line
 * below the field tells the user what we'd normalize to (and why) while
 * they're typing; the input doesn't nag — it just shows the preview. On
 * blur, if normalization would change the value, we apply it.
 */
function EndpointField({ value, mode, placeholder, onChange }: EndpointFieldProps) {
  const preview = useMemo(() => normalizeEndpoint(value, mode), [value, mode])

  function handleBlur() {
    if (preview.changed && preview.normalized !== value.trim()) {
      onChange(preview.normalized)
    }
  }

  const showHint = value.trim().length > 0 && (preview.changed || preview.warning)

  return (
    <div className="space-y-1.5">
      <Label>Endpoint</Label>
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={handleBlur}
        placeholder={placeholder}
      />
      {showHint && (
        <div
          className={`flex items-start gap-1.5 rounded-md border px-2 py-1.5 text-xs ${
            preview.changed
              ? "border-amber-500/40 bg-amber-500/5 text-amber-700 dark:text-amber-400"
              : "border-blue-500/40 bg-blue-500/5 text-blue-700 dark:text-blue-400"
          }`}
        >
          {preview.changed ? (
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          ) : (
            <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          )}
          <div className="min-w-0 flex-1 space-y-0.5">
            {preview.changed && (
              <div>
                将使用 <code className="break-all rounded bg-background/60 px-1 py-0.5 font-mono">{preview.normalized || "(empty)"}</code>
                <span className="ml-1 text-muted-foreground">(离开输入框时自动套用)</span>
              </div>
            )}
            {preview.warning && <div>{preview.warning}</div>}
          </div>
        </div>
      )}
    </div>
  )
}

interface ModelPickerProps {
  value: string
  suggestions: string[]
  placeholder: string
  onChange: (value: string) => void
}

/**
 * Model input with a chip-based suggestion row above it. The input stays
 * free-text so users can always type unlisted models (fine-tunes, preview
 * IDs, local Ollama tags, etc.). Clicking a chip just fills the input.
 *
 * The currently-selected chip (if the value matches one of the suggestions)
 * gets the accent highlight so users can see at a glance which preset
 * model is active without reading the text field. Presets with no
 * `suggestedModels` render the input alone.
 */
function ModelPicker({ value, suggestions, placeholder, onChange }: ModelPickerProps) {
  const hasSuggestions = suggestions.length > 0
  const isCustom = hasSuggestions && value.length > 0 && !suggestions.includes(value)

  return (
    <div className="space-y-2">
      {hasSuggestions && (
        <div className="flex flex-wrap gap-1.5">
          {suggestions.map((m) => {
            const active = m === value
            return (
              <button
                key={m}
                type="button"
                onClick={() => onChange(m)}
                className={`rounded-md border px-2 py-0.5 text-xs font-mono transition-colors ${
                  active
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border bg-background hover:bg-accent hover:text-accent-foreground"
                }`}
                title={`Use ${m}`}
              >
                {m}
              </button>
            )
          })}
          <button
            type="button"
            onClick={() => onChange("")}
            className={`rounded-md border px-2 py-0.5 text-xs transition-colors ${
              isCustom
                ? "border-primary/60 bg-primary/10 text-primary"
                : "border-dashed border-muted-foreground/40 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
            }`}
            title="Type a custom model id"
          >
            {isCustom ? `Custom: ${value}` : "Custom…"}
          </button>
        </div>
      )}
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
      />
    </div>
  )
}

interface DetectResult {
  installed: boolean
  version: string | null
  path: string | null
  error: string | null
}

/**
 * Health-check pill for the Claude Code CLI provider. Auto-runs
 * `claude --version` on mount, with a refresh button for when the user
 * just installed the binary and wants to re-check without reopening the
 * panel. The error message comes straight from the Rust side — it
 * already tailors the hint (macOS quarantine, missing binary, etc).
 */
function ClaudeCliStatusPill() {
  const [state, setState] = useState<"loading" | "ok" | "err">("loading")
  const [result, setResult] = useState<DetectResult | null>(null)

  async function detect() {
    setState("loading")
    try {
      const r = await invoke<DetectResult>("claude_cli_detect")
      setResult(r)
      setState(r.installed ? "ok" : "err")
    } catch (e) {
      setResult({
        installed: false,
        version: null,
        path: null,
        error: e instanceof Error ? e.message : String(e),
      })
      setState("err")
    }
  }

  useEffect(() => {
    void detect()
  }, [])

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <Label className="m-0">CLI status</Label>
        <button
          type="button"
          onClick={() => void detect()}
          className="rounded border border-border px-2 py-0.5 text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground"
          disabled={state === "loading"}
        >
          {state === "loading" ? "Checking…" : "Re-check"}
        </button>
      </div>
      <div
        className={`flex items-start gap-1.5 rounded-md border px-2 py-1.5 text-xs ${
          state === "ok"
            ? "border-emerald-500/40 bg-emerald-500/5 text-emerald-700 dark:text-emerald-400"
            : state === "err"
              ? "border-rose-500/40 bg-rose-500/5 text-rose-700 dark:text-rose-400"
              : "border-border bg-background/50 text-muted-foreground"
        }`}
      >
        {state === "loading" && <Loader2 className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin" />}
        {state === "ok" && <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />}
        {state === "err" && <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />}
        <div className="min-w-0 flex-1 space-y-0.5">
          {state === "loading" && <div>Detecting local claude binary…</div>}
          {state === "ok" && (
            <>
              <div>
                Detected{result?.version ? ` ${result.version}` : ""}. Ready to use your local
                subscription — no API key needed.
              </div>
              {result?.path && (
                <div className="truncate font-mono text-[10px] text-muted-foreground">
                  {result.path}
                </div>
              )}
            </>
          )}
          {state === "err" && (
            <>
              <div>{result?.error ?? "claude CLI not available."}</div>
              <div className="text-muted-foreground">
                Install from{" "}
                <code className="rounded bg-background/60 px-1 py-0.5 font-mono text-[10px]">
                  npm i -g @anthropic-ai/claude-code
                </code>{" "}
                then re-check.
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

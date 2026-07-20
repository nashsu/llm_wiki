import { useEffect, useMemo, useState } from "react"
import { ChevronDown, ChevronRight, AlertCircle, CheckCircle2, Loader2, XCircle, Plus, Trash2 } from "lucide-react"
import { useTranslation } from "react-i18next"
import { invoke } from "@tauri-apps/api/core"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { useWikiStore, type ProviderOverride, type ReasoningConfig, type ReasoningMode } from "@/stores/wiki-store"
import { availableLlmPresets, findLlmPreset, type LlmPreset } from "../llm-presets"
import { ContextSizeSelector } from "../context-size-selector"
import { disabledLlmConfig, resolveConfig } from "../preset-resolver"
import { normalizeEndpoint } from "@/lib/endpoint-normalizer"
import { AZURE_OPENAI_API_VERSION } from "@/lib/azure-openai"
import { testLlmConnection, testLlmFunction, type ProviderTestResult } from "@/lib/connection-tests"
import { projectLlmProfile, resolveProjectLlmConfig } from "@/lib/llm-task-routing"
import { saveProjectLlmOverride } from "@/lib/project-store"

const HTTP_HEADER_NAME_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/

export function llmHeadersToText(headers: Record<string, string> | undefined): string {
  return Object.entries(headers ?? {}).map(([name, value]) => `${name}: ${value}`).join("\n")
}

export function parseLlmHeadersText(text: string): Record<string, string> {
  const headers: Record<string, string> = {}
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith("#")) continue
    const separator = line.indexOf(":")
    if (separator <= 0) continue
    const name = line.slice(0, separator).trim()
    const value = line.slice(separator + 1).trim()
    if (HTTP_HEADER_NAME_RE.test(name) && value && !/[\r\n]/.test(value)) headers[name] = value
  }
  return headers
}

export function LlmProviderSection() {
  const { t } = useTranslation()
  const providerConfigs = useWikiStore((s) => s.providerConfigs)
  const setProviderConfigs = useWikiStore((s) => s.setProviderConfigs)
  const customLlmPresets = useWikiStore((s) => s.customLlmPresets)
  const setCustomLlmPresets = useWikiStore((s) => s.setCustomLlmPresets)
  const activePresetId = useWikiStore((s) => s.activePresetId)
  const setActivePresetId = useWikiStore((s) => s.setActivePresetId)
  const setLlmConfig = useWikiStore((s) => s.setLlmConfig)
  const globalLlmConfig = useWikiStore((s) => s.globalLlmConfig)
  const setGlobalLlmConfig = useWikiStore((s) => s.setGlobalLlmConfig)
  const project = useWikiStore((s) => s.project)
  const projectLlmOverride = useWikiStore((s) => s.projectLlmOverride)
  const setProjectLlmOverride = useWikiStore((s) => s.setProjectLlmOverride)
  const taskModelRouting = useWikiStore((s) => s.taskModelRouting)
  const setTaskModelRouting = useWikiStore((s) => s.setTaskModelRouting)

  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [savedId, setSavedId] = useState<string | null>(null)
  const presets = useMemo(() => availableLlmPresets(customLlmPresets), [customLlmPresets])

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
      const preset = findLlmPreset(newActive, customLlmPresets)
      if (preset) {
        const resolved = resolveConfig(preset, newConfigs[newActive], globalLlmConfig)
        setGlobalLlmConfig(resolved)
        setLlmConfig(resolveProjectLlmConfig(resolved, newConfigs, projectLlmOverride, customLlmPresets))
        await saveLlmConfig(resolved)
      }
    } else {
      // All presets disabled: write llmConfig into a state where hasUsableLlm()
      // returns false so ingest, dedup, and sweep queues pause immediately.
      // Clearing provider to "openai" (a keyed provider) + empty apiKey covers
      // the case where the previous provider was a keyless local CLI.
      // resolveConfig() on re-enable reads from providerConfigs[], not llmConfig,
      // so the cleared values here do not affect the user's saved settings.
      const cleared = disabledLlmConfig(globalLlmConfig)
      setGlobalLlmConfig(cleared)
      setLlmConfig(resolveProjectLlmConfig(cleared, newConfigs, projectLlmOverride, customLlmPresets))
      await saveLlmConfig(cleared)
    }
  }

  function updateOverride(id: string, patch: ProviderOverride) {
    const currentConfigs = useWikiStore.getState().providerConfigs
    const merged: ProviderOverride = { ...(currentConfigs[id] ?? {}), ...patch }
    const next = { ...currentConfigs, [id]: merged }
    setProviderConfigs(next)
    persist(next, activePresetId).catch(() => {})
    // If this preset is active, refresh the resolved LlmConfig live.
    if (id === activePresetId) {
      const preset = findLlmPreset(id, customLlmPresets)
      if (preset) {
        const resolved = resolveConfig(preset, merged, globalLlmConfig)
        setGlobalLlmConfig(resolved)
        setLlmConfig(resolveProjectLlmConfig(resolved, next, projectLlmOverride, customLlmPresets))
      }
    }
    setSavedId(id)
    setTimeout(() => setSavedId((cur) => (cur === id ? null : cur)), 1500)
  }

  function toggleActive(id: string) {
    const state = useWikiStore.getState()
    const next = id === state.activePresetId ? null : id
    setActivePresetId(next)
    persist(state.providerConfigs, next).catch(() => {})
  }

  async function updateTaskRouting(task: "chat" | "ingest", value: string) {
    const next = {
      ...taskModelRouting,
      [task === "chat" ? "chatPresetId" : "ingestPresetId"]: value || null,
    }
    setTaskModelRouting(next)
    const { saveTaskModelRouting } = await import("@/lib/project-store")
    await saveTaskModelRouting(next)
  }

  async function addCustomPreset() {
    const current = useWikiStore.getState().customLlmPresets
    if (current.length >= 50) return
    const id = `custom-${crypto.randomUUID()}`
    const next = [...current, {
      id,
      label: t("settings.sections.llm.customProfiles.defaultName", {
        number: current.length + 1,
      }),
    }]
    setCustomLlmPresets(next)
    setExpanded((current) => ({ ...current, [id]: true }))
    const { saveCustomLlmPresets } = await import("@/lib/project-store")
    await saveCustomLlmPresets(next)
  }

  async function renameCustomPreset(id: string, label: string) {
    const trimmed = label.trim()
    if (!trimmed) return
    const next = useWikiStore.getState().customLlmPresets
      .map((preset) => preset.id === id ? { ...preset, label: trimmed.slice(0, 80) } : preset)
    setCustomLlmPresets(next)
    const { saveCustomLlmPresets } = await import("@/lib/project-store")
    await saveCustomLlmPresets(next)
  }

  async function deleteCustomPreset(id: string) {
    const state = useWikiStore.getState()
    if (state.activePresetId === id) return
    const nextPresets = state.customLlmPresets.filter((preset) => preset.id !== id)
    const { [id]: _removed, ...nextConfigs } = state.providerConfigs
    const nextRouting = {
      chatPresetId: state.taskModelRouting.chatPresetId === id ? null : state.taskModelRouting.chatPresetId,
      ingestPresetId: state.taskModelRouting.ingestPresetId === id ? null : state.taskModelRouting.ingestPresetId,
    }
    setCustomLlmPresets(nextPresets)
    setProviderConfigs(nextConfigs)
    setTaskModelRouting(nextRouting)
    const { saveCustomLlmPresets, saveProviderConfigs, saveTaskModelRouting } = await import("@/lib/project-store")
    await Promise.all([
      saveCustomLlmPresets(nextPresets),
      saveProviderConfigs(nextConfigs),
      saveTaskModelRouting(nextRouting),
    ])
    if (project && state.projectLlmOverride.presetId === id) {
      await updateProjectOverride({ enabled: false, presetId: null, model: "" })
    }
  }

  async function updateProjectOverride(patch: Partial<typeof projectLlmOverride>) {
    if (!project) return
    // Read the latest snapshot synchronously. Multiple input events can arrive
    // before React re-renders this closure; using the captured value would
    // discard fields changed by the preceding event.
    const state = useWikiStore.getState()
    const current = state.projectLlmOverride
    const draft = { ...current, ...patch }
    const resolved = resolveProjectLlmConfig(
      state.globalLlmConfig,
      state.providerConfigs,
      draft,
      state.customLlmPresets,
    )
    const next = { ...draft, profile: draft.enabled ? projectLlmProfile(resolved) : undefined }
    setProjectLlmOverride(next)
    setLlmConfig(resolved)
    await saveProjectLlmOverride(project.id, next)
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-xl font-semibold">{t("settings.sections.llm.title")}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("settings.sections.llm.description")}
        </p>
      </div>

      {project && (
        <div className="space-y-3 rounded-md border bg-muted/20 p-3">
          <label className="flex items-center gap-2 text-sm font-medium">
            <input
              type="checkbox"
              checked={projectLlmOverride.enabled}
              onChange={(event) => void updateProjectOverride({ enabled: event.target.checked }).catch((error) => {
                console.error("Failed to save project model override:", error)
              })}
            />
            {t("settings.sections.llm.projectOverride.enabled")}
          </label>
          {projectLlmOverride.enabled && (
            <div className="grid gap-3 sm:grid-cols-2">
              <TaskModelSelect
                id="project-llm-preset"
                label={t("settings.sections.llm.projectOverride.provider")}
                value={projectLlmOverride.presetId ?? ""}
                onChange={(value) => void updateProjectOverride({ presetId: value || null }).catch((error) => {
                  console.error("Failed to save project provider:", error)
                })}
                fallbackLabel={t("settings.sections.llm.projectOverride.selectProvider")}
                presets={presets}
              />
              <div className="space-y-1.5">
                <Label htmlFor="project-llm-model">{t("settings.sections.llm.projectOverride.model")}</Label>
                <Input
                  id="project-llm-model"
                  value={projectLlmOverride.model}
                  placeholder={t("settings.sections.llm.projectOverride.modelPlaceholder")}
                  onChange={(event) => void updateProjectOverride({ model: event.target.value }).catch((error) => {
                    console.error("Failed to save project model:", error)
                  })}
                />
              </div>
            </div>
          )}
          <p className="text-xs text-muted-foreground">
            {t("settings.sections.llm.projectOverride.hint")}
          </p>
        </div>
      )}

      <div className="grid gap-3 rounded-md border bg-muted/20 p-3 sm:grid-cols-2">
        <TaskModelSelect
          id="chat-task-model"
          label={t("settings.sections.llm.taskRouting.chat")}
          value={taskModelRouting.chatPresetId ?? ""}
          onChange={(value) => void updateTaskRouting("chat", value).catch((error) => {
            console.error("Failed to save chat model routing:", error)
          })}
          fallbackLabel={t("settings.sections.llm.taskRouting.activeDefault")}
          presets={presets}
        />
        <TaskModelSelect
          id="ingest-task-model"
          label={t("settings.sections.llm.taskRouting.ingest")}
          value={taskModelRouting.ingestPresetId ?? ""}
          onChange={(value) => void updateTaskRouting("ingest", value).catch((error) => {
            console.error("Failed to save ingest model routing:", error)
          })}
          fallbackLabel={t("settings.sections.llm.taskRouting.activeDefault")}
          presets={presets}
        />
        <p className="text-xs text-muted-foreground sm:col-span-2">
          {t("settings.sections.llm.taskRouting.hint")}
        </p>
      </div>

      <div className="space-y-2">
        <div className="flex justify-end">
          <Button
            variant="outline"
            size="sm"
            onClick={() => void addCustomPreset()}
            disabled={customLlmPresets.length >= 50}
          >
            <Plus className="mr-1 h-4 w-4" />
            {t("settings.sections.llm.customProfiles.add")}
          </Button>
        </div>
        {presets.map((preset) => (
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
            isUserCustom={preset.id.startsWith("custom-")}
            onRename={(label) => void renameCustomPreset(preset.id, label)}
            onDelete={() => void deleteCustomPreset(preset.id)}
          />
        ))}
      </div>
    </div>
  )
}

function TaskModelSelect({
  id,
  label,
  value,
  onChange,
  fallbackLabel,
  presets,
}: {
  id: string
  label: string
  value: string
  onChange: (value: string) => void
  fallbackLabel: string
  presets: LlmPreset[]
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <select
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
      >
        <option value="">{fallbackLabel}</option>
        {presets.map((preset) => (
          <option key={preset.id} value={preset.id}>{preset.label}</option>
        ))}
      </select>
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
  isUserCustom: boolean
  onRename: (label: string) => void
  onDelete: () => void
}

type ProviderTestState =
  | { kind: "idle" }
  | { kind: "running"; label: string }
  | { kind: "done"; result: ProviderTestResult }

function PresetRow({
  preset,
  override,
  isActive,
  isExpanded,
  savedHere,
  onToggleActive,
  onToggleExpand,
  onChange,
  isUserCustom,
  onRename,
  onDelete,
}: PresetRowProps) {
  const { t } = useTranslation()
  const ov = override ?? {}
  const model = ov.model ?? preset.defaultModel ?? ""
  const apiKey = ov.apiKey ?? ""
  const apiMode = ov.apiMode ?? preset.apiMode ?? "chat_completions"
  const baseUrl = ov.baseUrl ?? preset.baseUrl ?? ""
  const azureApiVersion = ov.azureApiVersion ?? preset.azureApiVersion ?? AZURE_OPENAI_API_VERSION
  const azureModelFamily = ov.azureModelFamily ?? preset.azureModelFamily ?? "auto"
  const context = ov.maxContextSize ?? preset.suggestedContextSize ?? 131072
  const reasoning = ov.reasoning ?? { mode: "auto" as const }
  const localCliIsolation = ov.localCliIsolation === true
  const codexCliTimeoutMinutes = Math.max(1, Math.min(240, ov.codexCliTimeoutMinutes ?? 10))
  const requestTimeoutMinutes = Math.max(1, Math.min(1440, ov.requestTimeoutMinutes ?? 30))
  const streamingEnabled = ov.streamingEnabled !== false
  const [headersText, setHeadersText] = useState(() => llmHeadersToText(ov.customHeaders))
  const isLocalCliProvider = preset.provider === "claude-code" || preset.provider === "codex-cli"
  const [testState, setTestState] = useState<ProviderTestState>({ kind: "idle" })
  const hasConfig = !!apiKey || !!ov.baseUrl || !!ov.model || !!ov.azureApiVersion || !!ov.azureModelFamily
    || Object.keys(ov.customHeaders ?? {}).length > 0 || ov.streamingEnabled === false
  // Local CLI providers authenticate via their own existing login state
  // (inherited by the spawned subprocess), so no API key field is shown.
  // Ollama ditto for its local-only model.
  const needsApiKey =
    preset.provider !== "ollama" &&
    preset.provider !== "claude-code" &&
    preset.provider !== "codex-cli"

  const resolvedConfig = useMemo(
    () => resolveConfig(preset, ov, useWikiStore.getState().globalLlmConfig),
    [apiKey, apiMode, azureApiVersion, azureModelFamily, baseUrl, context, model, preset, reasoning, ov],
  )

  async function runProviderTest(kind: "connection" | "function") {
    setTestState({
      kind: "running",
      label: kind === "connection"
        ? t("settings.sections.llm.testingConnection")
        : t("settings.sections.llm.testingFunction"),
    })
    const result = kind === "connection"
      ? await testLlmConnection(resolvedConfig)
      : await testLlmFunction(resolvedConfig)
    setTestState({ kind: "done", result })
  }

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
          title={isExpanded ? t("settings.sections.llm.collapse") : t("settings.sections.llm.expand")}
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
                {t("settings.sections.llm.configuredBadge")}
              </span>
            )}
            {isActive && (
              <span className="shrink-0 rounded-full bg-primary/20 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                {t("settings.sections.llm.activeBadge")}
              </span>
            )}
            {savedHere && (
              <span className="shrink-0 text-[10px] text-emerald-600">{t("settings.sections.llm.savedBadge")}</span>
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
          title={isActive ? t("settings.sections.llm.toggleOff") : t("settings.sections.llm.toggleOn")}
          aria-label={isActive ? t("settings.sections.llm.deactivate") : t("settings.sections.llm.activate")}
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
          {isUserCustom && (
            <div className="space-y-2">
              <Label>{t("settings.sections.llm.customProfiles.name")}</Label>
              <Input
                defaultValue={preset.label}
                maxLength={80}
                onBlur={(event) => {
                  if (!event.target.value.trim()) event.target.value = preset.label
                  else onRename(event.target.value)
                }}
              />
            </div>
          )}
          {preset.provider === "custom" && (
            <div className="space-y-2">
              <Label>{t("settings.sections.llm.apiMode")}</Label>
              <div className="flex flex-wrap gap-2">
                {(
                  [
                    { value: "chat_completions", labelKey: "settings.sections.llm.wireOpenAi" },
                    { value: "anthropic_messages", labelKey: "settings.sections.llm.wireAnthropic" },
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
                      {t(m.labelKey)}
                    </button>
                  )
                })}
              </div>
            </div>
          )}

          {(preset.provider === "custom" || preset.provider === "ollama" || preset.provider === "azure") && (
            <EndpointField
              value={baseUrl}
              mode={preset.provider === "azure" ? "azure" : apiMode}
              placeholder={preset.baseUrl ?? "https://your-api.example.com/v1"}
              onChange={(v) => onChange({ baseUrl: v })}
            />
          )}

          {preset.provider === "azure" && (
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <Label>{t("settings.sections.llm.azureApiVersion")}</Label>
                <Input
                  value={azureApiVersion}
                  onChange={(e) => onChange({ azureApiVersion: e.target.value })}
                  placeholder="2024-10-21"
                />
                <p className="text-xs text-muted-foreground">
                  {t("settings.sections.llm.azureApiVersionHint")}
                </p>
              </div>
              <div className="space-y-2">
                <Label>{t("settings.sections.llm.azureModelFamily")}</Label>
                <select
                  className="w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                  value={azureModelFamily}
                  onChange={(e) => onChange({ azureModelFamily: e.target.value as typeof azureModelFamily })}
                >
                  <option value="auto">{t("settings.sections.llm.azureModelFamilyAuto")}</option>
                  <option value="gpt5">{t("settings.sections.llm.azureModelFamilyGpt5")}</option>
                </select>
                <p className="text-xs text-muted-foreground">
                  {t("settings.sections.llm.azureModelFamilyHint")}
                </p>
              </div>
            </div>
          )}

          {preset.provider === "claude-code" && <ClaudeCliStatusPill />}
          {preset.provider === "codex-cli" && <CodexCliStatusPill />}

          {isLocalCliProvider && (
            <div className="space-y-2 rounded-md border p-3">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-sm font-medium">
                    {t("settings.sections.llm.localCliIsolation")}
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {t("settings.sections.llm.localCliIsolationHint")}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => onChange({ localCliIsolation: !localCliIsolation })}
                  className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors ${
                    localCliIsolation
                      ? "border-primary bg-primary"
                      : "border-muted-foreground/30 bg-muted-foreground/20 hover:bg-muted-foreground/30"
                  }`}
                  title={
                    localCliIsolation
                      ? t("settings.sections.llm.localCliIsolationOn")
                      : t("settings.sections.llm.localCliIsolationOff")
                  }
                  aria-label={t("settings.sections.llm.localCliIsolation")}
                >
                  <span
                    className={`inline-block h-3.5 w-3.5 rounded-full bg-white shadow-sm ring-1 ring-black/10 transition-transform ${
                      localCliIsolation ? "translate-x-4" : "translate-x-0.5"
                    }`}
                  />
                </button>
              </div>
              <div className="rounded-md bg-muted/50 px-2 py-1.5 text-xs text-muted-foreground">
                {localCliIsolation
                  ? t("settings.sections.llm.localCliIsolationOn")
                  : t("settings.sections.llm.localCliIsolationOff")}
              </div>
            </div>
          )}

          {preset.provider === "codex-cli" && (
            <div className="space-y-2 rounded-md border p-3">
              <Label>{t("settings.sections.llm.codexCliTimeout")}</Label>
              <div className="flex items-center gap-2">
                <Input
                  type="number"
                  min={1}
                  max={240}
                  className="w-28"
                  value={codexCliTimeoutMinutes}
                  onChange={(e) => {
                    const n = Number(e.target.value)
                    onChange({
                      codexCliTimeoutMinutes: Number.isFinite(n)
                        ? Math.max(1, Math.min(240, Math.floor(n)))
                        : undefined,
                    })
                  }}
                />
                <span className="text-xs text-muted-foreground">
                  {t("settings.sections.llm.codexCliTimeoutUnit")}
                </span>
              </div>
              <p className="text-xs text-muted-foreground">
                {t("settings.sections.llm.codexCliTimeoutHint")}
              </p>
            </div>
          )}

          {needsApiKey && (
            <div className="space-y-2">
              <Label>{t("settings.apiKey")}</Label>
              <Input
                type="password"
                value={apiKey}
                onChange={(e) => onChange({ apiKey: e.target.value })}
                placeholder={
                  preset.provider === "custom"
                    ? t("settings.sections.llm.apiKeyPlaceholderCustom")
                    : t("settings.sections.llm.apiKeyPlaceholder")
                }
              />
            </div>
          )}

          <div className="space-y-2">
            <Label>
              {preset.provider === "azure"
                ? t("settings.sections.llm.deploymentName", "Deployment name")
                : t("settings.model")}
            </Label>
            <ModelPicker
              value={model}
              suggestions={preset.suggestedModels ?? []}
              placeholder={preset.defaultModel ?? "e.g. gpt-4o"}
              onChange={(v) => onChange({ model: v })}
            />
          </div>

          <div className="space-y-2">
            <Label>{t("settings.sections.llm.contextWindow")}</Label>
            <ContextSizeSelector
              value={context}
              onChange={(v) => onChange({ maxContextSize: v })}
            />
          </div>

          <div className="space-y-2 rounded-md border p-3">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-sm font-medium">
                  {t("settings.sections.llm.streamingOutput")}
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {t("settings.sections.llm.streamingOutputHint")}
                </p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={streamingEnabled}
                onClick={() => onChange({ streamingEnabled: !streamingEnabled })}
                className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors ${
                  streamingEnabled
                    ? "border-primary bg-primary"
                    : "border-muted-foreground/30 bg-muted-foreground/20 hover:bg-muted-foreground/30"
                }`}
                title={streamingEnabled
                  ? t("settings.sections.llm.streamingOutputOn")
                  : t("settings.sections.llm.streamingOutputOff")}
                aria-label={t("settings.sections.llm.streamingOutput")}
              >
                <span
                  className={`inline-block h-3.5 w-3.5 rounded-full bg-white shadow-sm ring-1 ring-black/10 transition-transform ${
                    streamingEnabled ? "translate-x-4" : "translate-x-0.5"
                  }`}
                />
              </button>
            </div>
            <div className="rounded-md bg-muted/50 px-2 py-1.5 text-xs text-muted-foreground">
              {streamingEnabled
                ? t("settings.sections.llm.streamingOutputOn")
                : t("settings.sections.llm.streamingOutputOff")}
            </div>
          </div>

          {!isLocalCliProvider && (
            <>
            <div className="space-y-2">
              <Label>{t("settings.sections.llm.customHeaders")}</Label>
              <textarea
                value={headersText}
                onChange={(event) => setHeadersText(event.target.value)}
                onBlur={() => onChange({ customHeaders: parseLlmHeadersText(headersText) })}
                rows={3}
                spellCheck={false}
                placeholder="X-Tenant-ID: team-a"
                className="w-full resize-y rounded-md border bg-background px-3 py-2 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              />
              <p className="text-xs text-muted-foreground">
                {t("settings.sections.llm.customHeadersHint")}
              </p>
            </div>
            <div className="space-y-2">
              <Label>{t("settings.sections.llm.requestTimeout", "Request timeout (minutes)")}</Label>
              <Input
                type="number"
                min={1}
                max={1440}
                value={requestTimeoutMinutes}
                onChange={(e) => onChange({
                  requestTimeoutMinutes: Math.max(1, Math.min(1440, Number(e.target.value) || 30)),
                })}
              />
              <p className="text-xs text-muted-foreground">
                {t("settings.sections.llm.requestTimeoutHint", "Increase this for slow local CPU models. The default is 30 minutes.")}
              </p>
            </div>
            </>
          )}

          <ReasoningControls
            value={reasoning}
            onChange={(reasoning) => onChange({ reasoning })}
          />

          <div className="space-y-2 rounded-md border p-3">
            <div>
              <div className="text-sm font-medium">
                {t("settings.sections.llm.providerTests")}
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                {t("settings.sections.llm.providerTestsHint")}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => void runProviderTest("connection")}
                disabled={testState.kind === "running"}
                className="rounded-md border px-3 py-1.5 text-xs hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60"
              >
                {t("settings.sections.llm.testConnection")}
              </button>
              <button
                type="button"
                onClick={() => void runProviderTest("function")}
                disabled={testState.kind === "running"}
                className="rounded-md border px-3 py-1.5 text-xs hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60"
              >
                {t("settings.sections.llm.testFunction")}
              </button>
            </div>
            {testState.kind === "running" && (
              <p className="text-xs text-muted-foreground">{testState.label}</p>
            )}
            {testState.kind === "done" && (
              <div
                className={`rounded-md border px-3 py-2 text-xs ${
                  testState.result.ok
                    ? "border-emerald-500/40 bg-emerald-500/5 text-emerald-700 dark:text-emerald-400"
                    : "border-destructive/40 bg-destructive/5 text-destructive"
                }`}
              >
                {testState.result.message}
              </div>
            )}
          </div>
          {isUserCustom && (
            <div className="flex justify-end border-t pt-3">
              <Button variant="outline" size="sm" onClick={onDelete} disabled={isActive}>
                <Trash2 className="mr-1 h-4 w-4" />
                {t("settings.sections.llm.customProfiles.delete")}
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function ReasoningControls({
  value,
  onChange,
}: {
  value: ReasoningConfig
  onChange: (value: ReasoningConfig) => void
}) {
  const { t } = useTranslation()
  const modes: { value: ReasoningMode; label: string }[] = [
    { value: "auto", label: t("settings.sections.llm.reasoning.auto") },
    { value: "off", label: t("settings.sections.llm.reasoning.off") },
    { value: "low", label: t("settings.sections.llm.reasoning.low") },
    { value: "medium", label: t("settings.sections.llm.reasoning.medium") },
    { value: "high", label: t("settings.sections.llm.reasoning.high") },
    { value: "max", label: t("settings.sections.llm.reasoning.max") },
    { value: "custom", label: t("settings.sections.llm.reasoning.custom") },
  ]

  return (
    <div className="space-y-2">
      <Label>{t("settings.sections.llm.reasoning.title")}</Label>
      <div className="flex flex-wrap gap-1.5">
        {modes.map((m) => {
          const active = value.mode === m.value
          return (
            <button
              key={m.value}
              type="button"
              onClick={() => onChange({ ...value, mode: m.value })}
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
      {value.mode === "custom" && (
        <div className="flex items-center gap-2">
          <Input
            type="number"
            min={0}
            className="w-28"
            value={value.budgetTokens ?? ""}
            onChange={(e) => {
              const raw = e.target.value.trim()
              const n = Number(raw)
              onChange({
                ...value,
                budgetTokens: raw === "" || !Number.isFinite(n) ? undefined : Math.max(0, n),
              })
            }}
            placeholder="1024"
          />
          <span className="text-xs text-muted-foreground">
            {t("settings.sections.llm.reasoning.budgetTokens")}
          </span>
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        {t("settings.sections.llm.reasoning.hint")}
      </p>
    </div>
  )
}

interface EndpointFieldProps {
  value: string
  mode: "chat_completions" | "anthropic_messages" | "azure"
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
  const { t } = useTranslation()
  const preview = useMemo(() => normalizeEndpoint(value, mode), [value, mode])

  function handleBlur() {
    if (preview.changed && preview.normalized !== value.trim()) {
      onChange(preview.normalized)
    }
  }

  const showHint = value.trim().length > 0 && (preview.changed || preview.warning)

  return (
    <div className="space-y-1.5">
      <Label>{t("settings.sections.llm.endpoint")}</Label>
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
                {t("settings.sections.llm.endpointPreviewWillUse")}{" "}
                <code className="break-all rounded bg-background/60 px-1 py-0.5 font-mono">
                  {preview.normalized || "(empty)"}
                </code>
                <span className="ml-1 text-muted-foreground">
                  {t("settings.sections.llm.endpointPreviewAutoApply")}
                </span>
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
  const { t } = useTranslation()
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
                title={t("settings.sections.llm.useModel", { model: m })}
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
            title={t("settings.sections.llm.typeCustomModel")}
          >
            {isCustom
              ? t("settings.sections.llm.customModelBadge", { model: value })
              : t("settings.sections.llm.customModel")}
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
  const { t } = useTranslation()
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
        <Label className="m-0">{t("settings.sections.llm.cliStatus")}</Label>
        <button
          type="button"
          onClick={() => void detect()}
          className="rounded border border-border px-2 py-0.5 text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground"
          disabled={state === "loading"}
        >
          {state === "loading" ? t("settings.sections.llm.checkingCli") : t("settings.sections.llm.recheckCli")}
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
          {state === "loading" && <div>{t("settings.sections.llm.detectingCli", { name: "Claude" })}</div>}
          {state === "ok" && (
            <>
              <div>
                {t("settings.sections.llm.cliDetected", { version: result?.version ? ` ${result.version}` : "", login: t("settings.sections.llm.claudeSubscription") })}
              </div>
              {result?.path && (
                <div className="truncate font-mono text-[10px] text-muted-foreground">
                  {result.path}
                </div>
              )}
              {/* `claude --version` doesn't validate OAuth, so even a
                  green pill can hide an expired login. Surface the
                  remediation up front so users don't mis-diagnose
                  the resulting "Unauthenticated" exit-1 as a LLM
                  Wiki bug. */}
              <div className="text-muted-foreground">
                {t("settings.sections.llm.cliAuthBefore")}{" "}
                <code className="rounded bg-background/60 px-1 py-0.5 font-mono text-[10px]">
                  claude
                </code>{" "}
                {" "}{t("settings.sections.llm.cliAuthAfter")}
              </div>
            </>
          )}
          {state === "err" && (
            <>
              <div>{result?.error ?? t("settings.sections.llm.cliUnavailable", { name: "Claude" })}</div>
              <div className="text-muted-foreground">
                {t("settings.sections.llm.cliInstallBefore")}{" "}
                <code className="rounded bg-background/60 px-1 py-0.5 font-mono text-[10px]">
                  npm i -g @anthropic-ai/claude-code
                </code>{" "}
                {" "}{t("settings.sections.llm.cliInstallAfter")}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function CodexCliStatusPill() {
  const { t } = useTranslation()
  const [state, setState] = useState<"loading" | "ok" | "err">("loading")
  const [result, setResult] = useState<DetectResult | null>(null)

  async function detect() {
    setState("loading")
    try {
      const r = await invoke<DetectResult>("codex_cli_detect")
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
        <Label className="m-0">{t("settings.sections.llm.cliStatus")}</Label>
        <button
          type="button"
          onClick={() => void detect()}
          className="rounded border border-border px-2 py-0.5 text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground"
          disabled={state === "loading"}
        >
          {state === "loading" ? t("settings.sections.llm.checkingCli") : t("settings.sections.llm.recheckCli")}
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
          {state === "loading" && <div>{t("settings.sections.llm.detectingCli", { name: "Codex" })}</div>}
          {state === "ok" && (
            <>
              <div>
                {t("settings.sections.llm.cliDetected", { version: result?.version ? ` ${result.version}` : "", login: t("settings.sections.llm.codexLogin") })}
              </div>
              {result?.path && (
                <div className="truncate font-mono text-[10px] text-muted-foreground">
                  {result.path}
                </div>
              )}
              <div className="text-muted-foreground">
                {t("settings.sections.llm.cliAuthBefore")}{" "}
                <code className="rounded bg-background/60 px-1 py-0.5 font-mono text-[10px]">
                  codex
                </code>{" "}
                {" "}{t("settings.sections.llm.cliAuthAfter")}
              </div>
            </>
          )}
          {state === "err" && (
            <>
              <div>{result?.error ?? t("settings.sections.llm.cliUnavailable", { name: "Codex" })}</div>
              <div className="text-muted-foreground">
                {t("settings.sections.llm.cliInstallBefore")}{" "}
                <code className="rounded bg-background/60 px-1 py-0.5 font-mono text-[10px]">
                  npm install -g @openai/codex
                </code>{" "}
                {" "}{t("settings.sections.llm.cliInstallAfter")}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

import { load } from "@tauri-apps/plugin-store"
import type { WikiProject } from "@/types/wiki"
import type { LlmConfig, SearchApiConfig, EmbeddingConfig, MultimodalConfig, OutputLanguage, ProviderConfigs, ProviderOverride, ProxyConfig, ScheduledImportConfig, SourceWatchConfig } from "@/stores/wiki-store"
import { normalizeSourceWatchConfig } from "@/lib/source-watch-config"
import { normalizePath } from "@/lib/path-utils"

const STORE_NAME = "app-state.json"
const RECENT_PROJECTS_KEY = "recentProjects"
const LAST_PROJECT_KEY = "lastProject"

async function getStore() {
  return load(STORE_NAME, { autoSave: true, defaults: {} })
}

export async function getRecentProjects(): Promise<WikiProject[]> {
  const store = await getStore()
  const projects = await store.get<WikiProject[]>(RECENT_PROJECTS_KEY)
  return projects ?? []
}

export async function getLastProject(): Promise<WikiProject | null> {
  const store = await getStore()
  const project = await store.get<WikiProject>(LAST_PROJECT_KEY)
  return project ?? null
}

export async function saveLastProject(project: WikiProject): Promise<void> {
  const store = await getStore()
  await store.set(LAST_PROJECT_KEY, project)
  await addToRecentProjects(project)
}

export async function addToRecentProjects(
  project: WikiProject
): Promise<void> {
  const store = await getStore()
  const existing = (await store.get<WikiProject[]>(RECENT_PROJECTS_KEY)) ?? []
  const filtered = existing.filter((p) => p.path !== project.path)
  const updated = [project, ...filtered].slice(0, 10)
  await store.set(RECENT_PROJECTS_KEY, updated)
}

const LLM_CONFIG_KEY = "llmConfig"
const PROVIDER_CONFIGS_KEY = "providerConfigs"
const ACTIVE_PRESET_KEY = "activePresetId"

const PROVIDERS = new Set<LlmConfig["provider"]>([
  "openai",
  "anthropic",
  "google",
  "azure",
  "ollama",
  "custom",
  "minimax",
  "claude-code",
  "codex-cli",
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback
}

function normalizeProvider(value: unknown): LlmConfig["provider"] {
  return typeof value === "string" && PROVIDERS.has(value as LlmConfig["provider"])
    ? (value as LlmConfig["provider"])
    : "openai"
}

function normalizeReasoning(value: unknown): LlmConfig["reasoning"] {
  if (!isRecord(value) || typeof value.mode !== "string") return { mode: "auto" }
  const modes = new Set(["auto", "off", "low", "medium", "high", "max", "custom"])
  if (!modes.has(value.mode)) return { mode: "auto" }
  return {
    mode: value.mode as NonNullable<LlmConfig["reasoning"]>["mode"],
    ...(typeof value.budgetTokens === "number" && Number.isFinite(value.budgetTokens)
      ? { budgetTokens: value.budgetTokens }
      : {}),
  }
}

function normalizeApiMode(value: unknown): LlmConfig["apiMode"] {
  return value === "anthropic_messages" ? "anthropic_messages" : "chat_completions"
}

function normalizeLlmConfig(raw: unknown): LlmConfig | null {
  if (!isRecord(raw)) return null
  const provider = normalizeProvider(raw.provider)
  return {
    provider,
    apiKey: stringValue(raw.apiKey),
    model: stringValue(raw.model),
    ollamaUrl: stringValue(raw.ollamaUrl, "http://localhost:11434"),
    customEndpoint: stringValue(raw.customEndpoint),
    azureApiVersion: provider === "azure" ? stringValue(raw.azureApiVersion, "2024-10-21") : undefined,
    maxContextSize: numberValue(raw.maxContextSize, 204800),
    apiMode: provider === "custom" ? normalizeApiMode(raw.apiMode) : undefined,
    reasoning: normalizeReasoning(raw.reasoning),
  }
}

function normalizeProviderOverride(raw: unknown): ProviderOverride {
  if (!isRecord(raw)) return {}
  return {
    ...(typeof raw.apiKey === "string" ? { apiKey: raw.apiKey } : {}),
    ...(typeof raw.model === "string" ? { model: raw.model } : {}),
    ...(typeof raw.baseUrl === "string" ? { baseUrl: raw.baseUrl } : {}),
    ...(typeof raw.azureApiVersion === "string" ? { azureApiVersion: raw.azureApiVersion } : {}),
    ...(raw.apiMode === "anthropic_messages" || raw.apiMode === "chat_completions"
      ? { apiMode: raw.apiMode }
      : {}),
    ...(typeof raw.maxContextSize === "number" && Number.isFinite(raw.maxContextSize)
      ? { maxContextSize: raw.maxContextSize }
      : {}),
    reasoning: normalizeReasoning(raw.reasoning),
  }
}

function normalizeProviderConfigs(raw: unknown): ProviderConfigs | null {
  if (!isRecord(raw)) return null
  const next: ProviderConfigs = {}
  for (const [rawId, value] of Object.entries(raw)) {
    const id = rawId === "azure-openai" ? "azure" : rawId
    next[id] = { ...(next[id] ?? {}), ...normalizeProviderOverride(value) }
  }
  return next
}

function normalizeActivePresetId(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null
  if (typeof raw !== "string") return null
  return raw === "azure-openai" ? "azure" : raw
}

function normalizeMultimodalConfig(raw: unknown): MultimodalConfig | null {
  if (!isRecord(raw)) return null
  const provider = normalizeProvider(raw.provider)
  return {
    enabled: raw.enabled === true,
    useMainLlm: raw.useMainLlm !== false,
    provider,
    apiKey: stringValue(raw.apiKey),
    model: stringValue(raw.model),
    ollamaUrl: stringValue(raw.ollamaUrl, "http://localhost:11434"),
    customEndpoint: stringValue(raw.customEndpoint),
    azureApiVersion: provider === "azure" ? stringValue(raw.azureApiVersion, "2024-10-21") : undefined,
    apiMode: provider === "custom" ? normalizeApiMode(raw.apiMode) : undefined,
    concurrency: Math.max(1, Math.min(16, numberValue(raw.concurrency, 4))),
  }
}

function changed(raw: unknown, normalized: unknown): boolean {
  return JSON.stringify(raw) !== JSON.stringify(normalized)
}

export async function saveLlmConfig(config: LlmConfig): Promise<void> {
  const store = await getStore()
  await store.set(LLM_CONFIG_KEY, config)
}

export async function loadLlmConfig(): Promise<LlmConfig | null> {
  const store = await getStore()
  const raw = await store.get<unknown>(LLM_CONFIG_KEY)
  const normalized = normalizeLlmConfig(raw)
  if (normalized && changed(raw, normalized)) {
    await store.set(LLM_CONFIG_KEY, normalized)
  }
  return normalized
}

export async function saveProviderConfigs(configs: ProviderConfigs): Promise<void> {
  const store = await getStore()
  await store.set(PROVIDER_CONFIGS_KEY, configs)
}

export async function loadProviderConfigs(): Promise<ProviderConfigs | null> {
  const store = await getStore()
  const raw = await store.get<unknown>(PROVIDER_CONFIGS_KEY)
  const normalized = normalizeProviderConfigs(raw)
  if (normalized && changed(raw, normalized)) {
    await store.set(PROVIDER_CONFIGS_KEY, normalized)
  }
  return normalized
}

export async function saveActivePresetId(id: string | null): Promise<void> {
  const store = await getStore()
  await store.set(ACTIVE_PRESET_KEY, id)
}

export async function loadActivePresetId(): Promise<string | null> {
  const store = await getStore()
  const raw = await store.get<unknown>(ACTIVE_PRESET_KEY)
  const normalized = normalizeActivePresetId(raw)
  if (changed(raw, normalized)) {
    await store.set(ACTIVE_PRESET_KEY, normalized)
  }
  return normalized
}

const SEARCH_API_KEY = "searchApiConfig"

export async function saveSearchApiConfig(config: SearchApiConfig): Promise<void> {
  const store = await getStore()
  await store.set(SEARCH_API_KEY, config)
}

export async function loadSearchApiConfig(): Promise<SearchApiConfig | null> {
  const store = await getStore()
  return (await store.get<SearchApiConfig>(SEARCH_API_KEY)) ?? null
}

const EMBEDDING_KEY = "embeddingConfig"

export async function saveEmbeddingConfig(config: EmbeddingConfig): Promise<void> {
  const store = await getStore()
  await store.set(EMBEDDING_KEY, config)
}

export async function loadEmbeddingConfig(): Promise<EmbeddingConfig | null> {
  const store = await getStore()
  return (await store.get<EmbeddingConfig>(EMBEDDING_KEY)) ?? null
}

const MULTIMODAL_KEY = "multimodalConfig"

export async function saveMultimodalConfig(config: MultimodalConfig): Promise<void> {
  const store = await getStore()
  await store.set(MULTIMODAL_KEY, config)
}

export async function loadMultimodalConfig(): Promise<MultimodalConfig | null> {
  const store = await getStore()
  const raw = await store.get<unknown>(MULTIMODAL_KEY)
  const normalized = normalizeMultimodalConfig(raw)
  if (normalized && changed(raw, normalized)) {
    await store.set(MULTIMODAL_KEY, normalized)
  }
  return normalized
}

// IMPORTANT: Keep this key in sync with the Rust setup hook
// (src-tauri/src/proxy.rs), which reads this exact field name from
// the same `app-state.json` store at app launch to translate the
// config into HTTP_PROXY / HTTPS_PROXY / NO_PROXY env vars.
const PROXY_CONFIG_KEY = "proxyConfig"

export async function saveProxyConfig(config: ProxyConfig): Promise<void> {
  const store = await getStore()
  await store.set(PROXY_CONFIG_KEY, config)
  // Force-flush to disk. The store is opened with `autoSave: true`,
  // which is a 100ms debounce — not an immediate write. For most
  // settings that's fine, but the proxy config is on the startup
  // critical path: the Rust setup hook reads `app-state.json` on
  // launch to apply HTTP_PROXY / HTTPS_PROXY / NO_PROXY. If the
  // user saves and quits within the debounce window the disk
  // value would lag behind in-memory, and the next launch would
  // boot with the wrong proxy.
  await store.save()
}

export async function loadProxyConfig(): Promise<ProxyConfig | null> {
  const store = await getStore()
  return (await store.get<ProxyConfig>(PROXY_CONFIG_KEY)) ?? null
}

const SCHEDULED_IMPORT_KEY_PREFIX = "scheduledImportConfig:"

function scheduledImportKey(projectPath: string): string {
  return `${SCHEDULED_IMPORT_KEY_PREFIX}${normalizePath(projectPath)}`
}

const SCHEDULED_IMPORT_GLOBAL_KEY = "scheduledImportConfig"

export async function saveScheduledImportConfig(projectPath: string, config: ScheduledImportConfig): Promise<void> {
  const store = await getStore()
  await store.set(scheduledImportKey(projectPath), config)
  await store.save()
}

export async function loadScheduledImportConfig(projectPath: string): Promise<ScheduledImportConfig | null> {
  const store = await getStore()
  const perProject = await store.get<ScheduledImportConfig>(scheduledImportKey(projectPath))
  if (perProject) return perProject
  // Migrate from legacy global key (pre-0.4.8)
  const legacy = await store.get<ScheduledImportConfig>(SCHEDULED_IMPORT_GLOBAL_KEY)
  if (legacy) {
    await store.set(scheduledImportKey(projectPath), legacy)
    await store.delete(SCHEDULED_IMPORT_GLOBAL_KEY)
    await store.save()
    return legacy
  }
  return null
}

export async function removeFromRecentProjects(
  path: string
): Promise<void> {
  const store = await getStore()
  const existing = (await store.get<WikiProject[]>(RECENT_PROJECTS_KEY)) ?? []
  const updated = existing.filter((p) => p.path !== path)
  await store.set(RECENT_PROJECTS_KEY, updated)
  // ALSO clear the last-project pointer if it points at the project
  // we just removed. Without this, App.tsx's startup auto-open
  // (`getLastProject()` → `openProject()` → `saveLastProject()`)
  // re-adds the removed entry back to recents on the next launch,
  // making the delete look like it didn't take. Reported by user
  // as "deleted project comes back after restart."
  const last = await store.get<WikiProject>(LAST_PROJECT_KEY)
  if (last && last.path === path) {
    await store.delete(LAST_PROJECT_KEY)
  }
}

const LANGUAGE_KEY = "language"

export async function saveLanguage(lang: string): Promise<void> {
  const store = await getStore()
  await store.set(LANGUAGE_KEY, lang)
}

export async function loadLanguage(): Promise<string | null> {
  const store = await getStore()
  return (await store.get<string>(LANGUAGE_KEY)) ?? null
}

const OUTPUT_LANGUAGE_KEY = "outputLanguage"
const PROJECT_OUTPUT_LANGUAGE_KEY = "projectOutputLanguages"
const PROJECT_FILE_SYNC_KEY = "projectFileSyncEnabled"
const SOURCE_WATCH_CONFIG_KEY = "sourceWatchConfig"

export async function saveOutputLanguage(lang: OutputLanguage, projectId?: string): Promise<void> {
  const store = await getStore()
  if (projectId) {
    const existing = (await store.get<Record<string, OutputLanguage>>(PROJECT_OUTPUT_LANGUAGE_KEY)) ?? {}
    await store.set(PROJECT_OUTPUT_LANGUAGE_KEY, { ...existing, [projectId]: lang })
  }
  await store.set(OUTPUT_LANGUAGE_KEY, lang)
}

export async function loadOutputLanguage(projectId?: string): Promise<OutputLanguage | null> {
  const store = await getStore()
  if (projectId) {
    const projectLanguages = await store.get<Record<string, OutputLanguage>>(PROJECT_OUTPUT_LANGUAGE_KEY)
    return projectLanguages?.[projectId] ?? null
  }
  return (await store.get<OutputLanguage>(OUTPUT_LANGUAGE_KEY)) ?? null
}

export async function saveProjectFileSyncEnabled(enabled: boolean, projectId?: string): Promise<void> {
  const store = await getStore()
  if (projectId) {
    const existing = (await store.get<Record<string, boolean>>(PROJECT_FILE_SYNC_KEY)) ?? {}
    await store.set(PROJECT_FILE_SYNC_KEY, { ...existing, [projectId]: enabled })
    return
  }
  const existing = (await store.get<Record<string, boolean>>(PROJECT_FILE_SYNC_KEY)) ?? {}
  await store.set(PROJECT_FILE_SYNC_KEY, { ...existing, default: enabled })
}

export async function loadProjectFileSyncEnabled(projectId?: string): Promise<boolean> {
  const store = await getStore()
  const settings = await store.get<Record<string, boolean>>(PROJECT_FILE_SYNC_KEY)
  if (projectId && settings && typeof settings[projectId] === "boolean") {
    return settings[projectId]
  }
  if (settings && typeof settings.default === "boolean") {
    return settings.default
  }
  return true
}

export async function saveSourceWatchConfig(config: SourceWatchConfig, projectId?: string): Promise<void> {
  const store = await getStore()
  const normalized = normalizeSourceWatchConfig(config)
  const existing = (await store.get<Record<string, SourceWatchConfig>>(SOURCE_WATCH_CONFIG_KEY)) ?? {}
  await store.set(SOURCE_WATCH_CONFIG_KEY, {
    ...existing,
    [projectId ?? "default"]: normalized,
  })
  await store.save()
}

export async function loadSourceWatchConfig(projectId?: string): Promise<SourceWatchConfig> {
  const store = await getStore()
  const settings = await store.get<Record<string, SourceWatchConfig>>(SOURCE_WATCH_CONFIG_KEY)
  const config = projectId ? settings?.[projectId] : undefined
  if (config) return normalizeSourceWatchConfig(config)
  if (settings?.default) return normalizeSourceWatchConfig(settings.default)

  const legacyEnabled = await loadProjectFileSyncEnabled(projectId)
  return normalizeSourceWatchConfig({ enabled: legacyEnabled })
}

// ── Update-check persistence ──────────────────────────────────────────────
// Small slice of state the UI-layer update store hydrates from on boot.
// Only fields that should persist across launches: the user's "enable
// auto-check" toggle, the timestamp we last checked (so the 6-hour cache
// survives restarts), and the version the user explicitly dismissed
// (so we don't re-nag on every restart until a newer version is out).

const UPDATE_CHECK_STATE_KEY = "updateCheckState"

export interface PersistedUpdateCheckState {
  enabled: boolean
  lastCheckedAt: number | null
  dismissedVersion: string | null
}

export async function saveUpdateCheckState(
  state: PersistedUpdateCheckState,
): Promise<void> {
  const store = await getStore()
  await store.set(UPDATE_CHECK_STATE_KEY, state)
}

export async function loadUpdateCheckState(): Promise<PersistedUpdateCheckState | null> {
  const store = await getStore()
  return (
    (await store.get<PersistedUpdateCheckState>(UPDATE_CHECK_STATE_KEY)) ?? null
  )
}

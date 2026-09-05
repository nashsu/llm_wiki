import { load } from "@tauri-apps/plugin-store"
import { invoke } from "@tauri-apps/api/core"
import type { WikiProject } from "@/types/wiki"
import type { ApiConfig, CustomLlmPreset, GeneralConfig, LlmConfig, SearchApiConfig, EmbeddingConfig, MineruConfig, MultimodalConfig, OutputLanguage, ProjectLlmOverride, ProviderConfigs, ProxyConfig, ScheduledImportConfig, SourceWatchConfig, TaskModelRoutingConfig } from "@/stores/wiki-store"
import { normalizeSourceWatchConfig } from "@/lib/source-watch-config"
import { normalizePath } from "@/lib/path-utils"
import { DEFAULT_ZOOM_LEVEL, clampZoomLevel } from "@/stores/zoom-store"

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
const TASK_MODEL_ROUTING_KEY = "taskModelRouting"
const PROJECT_LLM_OVERRIDES_KEY = "projectLlmOverrides"
const CUSTOM_LLM_PRESETS_KEY = "customLlmPresets"
let projectLlmOverrideWrite = Promise.resolve()
let customLlmPresetWrite = Promise.resolve()
let providerConfigsWrite = Promise.resolve()

type ApiKeyConfig = Pick<LlmConfig, "apiKey">
const API_KEY_FIELD: "apiKey" = "apiKey"
const unavailableCredentialSlots = new Set<string>()

async function readSecureCredentialStrict(slot: string): Promise<string | null> {
  const secret = await invoke<string | null>("secure_credential_get", { slot })
  unavailableCredentialSlots.delete(slot)
  return secret
}

async function writeSecureCredential(slot: string, secret: string): Promise<void> {
  if (secret) {
    await invoke("secure_credential_set", { slot, secret })
  } else {
    await invoke("secure_credential_delete", { slot })
  }
  unavailableCredentialSlots.delete(slot)
}

async function readSecureCredential(slot: string): Promise<string> {
  try {
    return (await readSecureCredentialStrict(slot)) ?? ""
  } catch {
    // Keep the application usable for keyless local providers when the OS
    // credential service is locked or unavailable. Saves still fail loudly so
    // a newly entered key is never discarded or downgraded to plaintext.
    unavailableCredentialSlots.add(slot)
    return ""
  }
}

async function restoreSecureCredential(slot: string, secret: string | null): Promise<void> {
  await writeSecureCredential(slot, secret ?? "")
}

async function saveCredentialBackedConfig<T extends ApiKeyConfig>(
  storeKey: string,
  credentialSlot: string,
  config: T,
): Promise<void> {
  const store = await getStore()
  const previousConfig = await store.get<T>(storeKey)
  const skipCredentialWrite = !config.apiKey && unavailableCredentialSlots.has(credentialSlot)
  const previousSecret = skipCredentialWrite
    ? null
    : await readSecureCredentialStrict(credentialSlot)
  if (!skipCredentialWrite) {
    await writeSecureCredential(credentialSlot, config.apiKey)
  }
  try {
    await store.set(storeKey, { ...config, [API_KEY_FIELD]: "" })
    await store.save()
  } catch (error) {
    if (!skipCredentialWrite) {
      await restoreSecureCredential(credentialSlot, previousSecret).catch(() => {})
    }
    if (previousConfig) {
      await store.set(storeKey, previousConfig).catch(() => {})
    } else {
      await store.delete(storeKey).catch(() => {})
    }
    await store.save().catch(() => {})
    throw error
  }
}

async function loadCredentialBackedConfig<T extends ApiKeyConfig>(
  storeKey: string,
  credentialSlot: string,
): Promise<T | null> {
  const store = await getStore()
  const saved = await store.get<T>(storeKey)
  if (!saved) return null

  // One-time migration from releases that persisted credentials in
  // app-state.json. Write the secret first; plaintext is removed only after
  // secure storage confirms the write succeeded.
  if (saved.apiKey) {
    await writeSecureCredential(credentialSlot, saved.apiKey)
    await store.set(storeKey, { ...saved, apiKey: "" })
    await store.save()
    return saved
  }

  const apiKey = await readSecureCredential(credentialSlot)
  return { ...saved, apiKey }
}

export async function saveLlmConfig(config: LlmConfig): Promise<void> {
  await saveCredentialBackedConfig(LLM_CONFIG_KEY, "llm", config)
}

export async function loadLlmConfig(): Promise<LlmConfig | null> {
  return loadCredentialBackedConfig<LlmConfig>(LLM_CONFIG_KEY, "llm")
}

export async function saveProviderConfigs(configs: ProviderConfigs): Promise<void> {
  const write = providerConfigsWrite.then(async () => {
    const store = await getStore()
    const previous = (await store.get<ProviderConfigs>(PROVIDER_CONFIGS_KEY)) ?? {}
    const desiredCredentials = [
      ...Object.entries(configs).map(([id, config]) => [
        `provider:${id}`,
        config.apiKey ?? "",
      ] as const),
      ...Object.keys(previous)
        .filter((id) => !(id in configs))
        .map((id) => [`provider:${id}`, ""] as const),
    ]
    const snapshots: Array<{ slot: string; previous: string | null; desired: string }> = []
    for (const [slot, desired] of desiredCredentials) {
      if (!desired && unavailableCredentialSlots.has(slot)) continue
      snapshots.push({ slot, previous: await readSecureCredentialStrict(slot), desired })
    }
    const applied: typeof snapshots = []
    try {
      for (const snapshot of snapshots) {
        await writeSecureCredential(snapshot.slot, snapshot.desired)
        applied.push(snapshot)
      }
      const sanitized = Object.fromEntries(Object.entries(configs).map(([id, config]) => [
        id,
        { ...config, [API_KEY_FIELD]: "" },
      ]))
      await store.set(PROVIDER_CONFIGS_KEY, sanitized)
      await store.save()
    } catch (error) {
      for (const snapshot of applied.reverse()) {
        await restoreSecureCredential(snapshot.slot, snapshot.previous).catch(() => {})
      }
      await store.set(PROVIDER_CONFIGS_KEY, previous).catch(() => {})
      await store.save().catch(() => {})
      throw error
    }
  })
  providerConfigsWrite = write.catch(() => {})
  await write
}

export async function loadProviderConfigs(): Promise<ProviderConfigs | null> {
  const store = await getStore()
  const saved = await store.get<ProviderConfigs>(PROVIDER_CONFIGS_KEY)
  if (!saved) return null

  let migrated = false
  const hydratedEntries = await Promise.all(Object.entries(saved).map(async ([id, config]) => {
    if (config.apiKey) {
      await writeSecureCredential(`provider:${id}`, config.apiKey)
      migrated = true
      return [id, config] as const
    }
    const apiKey = await readSecureCredential(`provider:${id}`)
    return [id, { ...config, apiKey }] as const
  }))
  if (migrated) {
    const sanitized = Object.fromEntries(Object.entries(saved).map(([id, config]) => [
      id,
      { ...config, apiKey: "" },
    ]))
    await store.set(PROVIDER_CONFIGS_KEY, sanitized)
    await store.save()
  }
  return Object.fromEntries(hydratedEntries)
}

export async function saveCustomLlmPresets(presets: CustomLlmPreset[]): Promise<void> {
  const normalized = normalizeCustomLlmPresets(presets)
  const write = customLlmPresetWrite.then(async () => {
    const store = await getStore()
    await store.set(CUSTOM_LLM_PRESETS_KEY, normalized)
  })
  customLlmPresetWrite = write.catch(() => {})
  await write
}

export async function loadCustomLlmPresets(): Promise<CustomLlmPreset[]> {
  const store = await getStore()
  return normalizeCustomLlmPresets(await store.get<unknown>(CUSTOM_LLM_PRESETS_KEY))
}

function normalizeCustomLlmPresets(value: unknown): CustomLlmPreset[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const normalized: CustomLlmPreset[] = []
  for (const entry of value) {
    if (normalized.length >= 50) break
    const candidate = entry as Partial<CustomLlmPreset> | null
    if (!candidate || typeof candidate !== "object") continue
    if (typeof candidate.id !== "string" || !/^custom-[A-Za-z0-9-]{1,80}$/.test(candidate.id)) continue
    const label = typeof candidate.label === "string" ? candidate.label.trim().slice(0, 80) : ""
    if (!label || seen.has(candidate.id)) continue
    seen.add(candidate.id)
    normalized.push({ id: candidate.id, label })
  }
  return normalized
}

export async function saveActivePresetId(id: string | null): Promise<void> {
  const store = await getStore()
  await store.set(ACTIVE_PRESET_KEY, id)
}

export async function loadActivePresetId(): Promise<string | null> {
  const store = await getStore()
  return (await store.get<string | null>(ACTIVE_PRESET_KEY)) ?? null
}

export async function saveTaskModelRouting(config: TaskModelRoutingConfig): Promise<void> {
  const store = await getStore()
  await store.set(TASK_MODEL_ROUTING_KEY, config)
}

export async function loadTaskModelRouting(): Promise<TaskModelRoutingConfig | null> {
  const store = await getStore()
  const saved = await store.get<Partial<TaskModelRoutingConfig>>(TASK_MODEL_ROUTING_KEY)
  if (!saved) return null
  return {
    chatPresetId: typeof saved.chatPresetId === "string" ? saved.chatPresetId : null,
    ingestPresetId: typeof saved.ingestPresetId === "string" ? saved.ingestPresetId : null,
  }
}

export async function saveProjectLlmOverride(
  projectId: string,
  config: ProjectLlmOverride,
): Promise<void> {
  // Store updates are read-modify-write. Serialize them so rapid model input
  // or concurrent project edits cannot let an older write overwrite a newer
  // snapshot (or drop another project's entry).
  const write = projectLlmOverrideWrite.then(async () => {
    const store = await getStore()
    const existing = (await store.get<Record<string, ProjectLlmOverride>>(PROJECT_LLM_OVERRIDES_KEY)) ?? {}
    await store.set(PROJECT_LLM_OVERRIDES_KEY, { ...existing, [projectId]: config })
  })
  projectLlmOverrideWrite = write.catch(() => {})
  await write
}

export async function loadProjectLlmOverride(projectId: string): Promise<ProjectLlmOverride> {
  const store = await getStore()
  const existing = await store.get<Record<string, Partial<ProjectLlmOverride>>>(PROJECT_LLM_OVERRIDES_KEY)
  const saved = existing?.[projectId]
  return {
    enabled: saved?.enabled === true,
    presetId: typeof saved?.presetId === "string" ? saved.presetId : null,
    model: typeof saved?.model === "string" ? saved.model : "",
    profile: saved?.profile,
  }
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
  await saveCredentialBackedConfig(EMBEDDING_KEY, "embedding", config)
}

export async function loadEmbeddingConfig(): Promise<EmbeddingConfig | null> {
  return loadCredentialBackedConfig<EmbeddingConfig>(EMBEDDING_KEY, "embedding")
}

const MULTIMODAL_KEY = "multimodalConfig"

export async function saveMultimodalConfig(config: MultimodalConfig): Promise<void> {
  await saveCredentialBackedConfig(MULTIMODAL_KEY, "multimodal", config)
}

export async function loadMultimodalConfig(): Promise<MultimodalConfig | null> {
  return loadCredentialBackedConfig<MultimodalConfig>(MULTIMODAL_KEY, "multimodal")
}

const MINERU_KEY = "mineruConfig"
const DEFAULT_LOCAL_MINERU_ENDPOINT = "http://127.0.0.1:8000"
const LOCAL_MINERU_BACKENDS = new Set([
  "pipeline",
  "vlm-engine",
  "hybrid-engine",
  "vlm-http-client",
  "hybrid-http-client",
])

function normalizeMineruConfig(config: MineruConfig): MineruConfig {
  return {
    enabled: config.enabled === true,
    backend: config.backend === "local" ? "local" : "cloud",
    localEndpoint:
      typeof config.localEndpoint === "string" && config.localEndpoint.trim()
        ? config.localEndpoint.trim()
        : DEFAULT_LOCAL_MINERU_ENDPOINT,
    localToken: typeof config.localToken === "string" ? config.localToken.trim() : "",
    localBackend: LOCAL_MINERU_BACKENDS.has(config.localBackend ?? "")
      ? config.localBackend
      : "hybrid-engine",
    localEffort: config.localEffort === "high" ? "high" : "medium",
    localParseMethod:
      config.localParseMethod === "txt" || config.localParseMethod === "ocr"
        ? config.localParseMethod
        : "auto",
    localLanguage:
      typeof config.localLanguage === "string" && config.localLanguage.trim()
        ? config.localLanguage.trim()
        : "ch",
    localFormulaEnabled: config.localFormulaEnabled !== false,
    localTableEnabled: config.localTableEnabled !== false,
    localImageAnalysis: config.localImageAnalysis !== false,
    localServerUrl:
      typeof config.localServerUrl === "string" ? config.localServerUrl.trim() : "",
    token: typeof config.token === "string" ? config.token : "",
    modelVersion: config.modelVersion === "pipeline" ? "pipeline" : "vlm",
  }
}

function normalizeZoomLevel(level: unknown): number {
  return typeof level === "number" && Number.isFinite(level)
    ? clampZoomLevel(level)
    : DEFAULT_ZOOM_LEVEL
}

export const __projectStoreTest = {
  normalizeMineruConfig,
  normalizeZoomLevel,
  normalizeCustomLlmPresets,
}

export async function saveMineruConfig(config: MineruConfig): Promise<void> {
  const store = await getStore()
  await store.set(MINERU_KEY, normalizeMineruConfig(config))
}

export async function loadMineruConfig(): Promise<MineruConfig | null> {
  const store = await getStore()
  const config = await store.get<MineruConfig>(MINERU_KEY)
  return config ? normalizeMineruConfig(config) : null
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

// Local API server config. KEY MUST stay `apiConfig` — the Rust
// `api_server` module reads `parsed.get("apiConfig")` from this same
// `app-state.json` on every request (5s cache). Rename one side and
// the API silently goes back to "no token configured = 401 forever".
const API_CONFIG_KEY = "apiConfig"

export async function saveApiConfig(config: ApiConfig): Promise<void> {
  const store = await getStore()
  await store.set(API_CONFIG_KEY, config)
  // Force-flush. The 100ms debounce default is fine for cosmetic
  // settings, but the API token is on a security hot path — a user
  // generates one, hits Save, then immediately curls the API from
  // another terminal. We want the disk file to match in-memory
  // state before the next request reads it.
  await store.save()
}

export async function loadApiConfig(): Promise<ApiConfig | null> {
  const store = await getStore()
  return (await store.get<ApiConfig>(API_CONFIG_KEY)) ?? null
}

const GENERAL_CONFIG_KEY = "generalConfig"

export const DEFAULT_GENERAL_CONFIG: GeneralConfig = {
  autostart: false,
  closeBehavior: "minimize",
}

export function normalizeGeneralConfig(config?: Partial<GeneralConfig> | null): GeneralConfig {
  const closeBehavior = config?.closeBehavior
  return {
    autostart: typeof config?.autostart === "boolean" ? config.autostart : DEFAULT_GENERAL_CONFIG.autostart,
    closeBehavior:
      closeBehavior === "ask" || closeBehavior === "minimize" || closeBehavior === "exit"
        ? closeBehavior
        : DEFAULT_GENERAL_CONFIG.closeBehavior,
  }
}

export async function saveGeneralConfig(config: GeneralConfig): Promise<void> {
  const store = await getStore()
  await store.set(GENERAL_CONFIG_KEY, normalizeGeneralConfig(config))
  await store.save()
}

export async function loadGeneralConfig(): Promise<GeneralConfig> {
  const store = await getStore()
  const config = await store.get<Partial<GeneralConfig>>(GENERAL_CONFIG_KEY)
  return normalizeGeneralConfig(config)
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

const THEME_KEY = "theme"

export async function saveTheme(theme: "light" | "dark" | "system"): Promise<void> {
  const store = await getStore()
  await store.set(THEME_KEY, theme)
}

export async function loadTheme(): Promise<"light" | "dark" | "system" | null> {
  const store = await getStore()
  return (await store.get<"light" | "dark" | "system">(THEME_KEY)) ?? null
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

const ZOOM_LEVEL_KEY = "zoomLevel"

export async function saveZoomLevel(level: number): Promise<void> {
  const store = await getStore()
  await store.set(ZOOM_LEVEL_KEY, normalizeZoomLevel(level))
  await store.save()
}

export async function loadZoomLevel(): Promise<number> {
  const store = await getStore()
  const level = await store.get<number>(ZOOM_LEVEL_KEY)
  return normalizeZoomLevel(level)
}

import { useCallback, useEffect, useMemo, useState } from "react"
import {
  Bot,
  Binary,
  Globe,
  Languages,
  Palette,
  Info,
  Image as ImageIcon,
  Network,
  History,
  Wrench,
  Clock,
  FolderSync,
  Server,
  Settings,
  FileText,
} from "lucide-react"
import { useTranslation } from "react-i18next"
import { invoke } from "@tauri-apps/api/core"
import { disable as disableAutostart, enable as enableAutostart } from "@tauri-apps/plugin-autostart"
import i18n from "@/i18n"
import { Button } from "@/components/ui/button"
import { useWikiStore } from "@/stores/wiki-store"
import { useChatStore } from "@/stores/chat-store"
import { useUpdateStore, hasAvailableUpdate } from "@/stores/update-store"
import { useZoomStore } from "@/stores/zoom-store"
import { loadSourceWatchConfig, saveLanguage, saveTheme, loadTheme } from "@/lib/project-store"
import { applyTheme, type AppTheme } from "@/lib/theme"
import type { SettingsDraft, DraftSetter } from "./settings-types"
import { normalizeSourceWatchConfig } from "@/lib/source-watch-config"
import { LlmProviderSection } from "./sections/llm-provider-section"
import { EmbeddingSection } from "./sections/embedding-section"
import { MultimodalSection } from "./sections/multimodal-section"
import { WebSearchSection } from "./sections/web-search-section"
import { OutputSection } from "./sections/output-section"
import { InterfaceSection } from "./sections/interface-section"
import { NetworkSection } from "./sections/network-section"
import { ScheduledImportSection } from "./sections/scheduled-import-section"
import { SourceWatchSection } from "./sections/source-watch-section"
import { MineruSection } from "./sections/mineru-section"
import { ApiServerSection } from "./sections/api-server-section"
import { GeneralSection } from "./sections/general-section"
import { ChangelogSection } from "./sections/changelog-section"
import { MaintenanceSection } from "./sections/maintenance-section"
import { AboutSection } from "./sections/about-section"

type CategoryId =
  | "general"
  | "llm"
  | "embedding"
  | "multimodal"
  | "web-search"
  | "network"
  | "source-watch"
  | "scheduled-import"
  | "mineru"
  | "api-server"
  | "output"
  | "interface"
  | "maintenance"
  | "changelog"
  | "about"

interface Category {
  id: CategoryId
  /** i18n key under settings.categories — resolved at render time so
   *  switching language in Settings → Interface takes effect without
   *  remounting this component (Bug #53). */
  labelKey: string
  icon: typeof Bot
}

const CATEGORIES: Category[] = [
  { id: "general", labelKey: "settings.categories.general", icon: Settings },
  { id: "llm", labelKey: "settings.categories.llm", icon: Bot },
  { id: "embedding", labelKey: "settings.categories.embedding", icon: Binary },
  { id: "multimodal", labelKey: "settings.categories.multimodal", icon: ImageIcon },
  { id: "web-search", labelKey: "settings.categories.webSearch", icon: Globe },
  { id: "network", labelKey: "settings.categories.network", icon: Network },
  { id: "source-watch", labelKey: "settings.categories.sourceWatch", icon: FolderSync },
  { id: "scheduled-import", labelKey: "settings.categories.scheduledImport", icon: Clock },
  { id: "mineru", labelKey: "settings.categories.mineru", icon: FileText },
  { id: "api-server", labelKey: "settings.categories.apiServer", icon: Server },
  { id: "output", labelKey: "settings.categories.output", icon: Languages },
  { id: "interface", labelKey: "settings.categories.interface", icon: Palette },
  { id: "maintenance", labelKey: "settings.categories.maintenance", icon: Wrench },
  { id: "changelog", labelKey: "settings.categories.changelog", icon: History },
  { id: "about", labelKey: "settings.categories.about", icon: Info },
]

function initialDraft(
  llm: ReturnType<typeof useWikiStore.getState>["llmConfig"],
  embed: ReturnType<typeof useWikiStore.getState>["embeddingConfig"],
  multimodal: ReturnType<typeof useWikiStore.getState>["multimodalConfig"],
  outputLanguage: ReturnType<typeof useWikiStore.getState>["outputLanguage"],
  proxy: ReturnType<typeof useWikiStore.getState>["proxyConfig"],
  scheduledImport: ReturnType<typeof useWikiStore.getState>["scheduledImportConfig"],
  sourceWatch: ReturnType<typeof useWikiStore.getState>["sourceWatchConfig"],
  mineru: ReturnType<typeof useWikiStore.getState>["mineruConfig"],
  apiConfig: ReturnType<typeof useWikiStore.getState>["apiConfig"],
  generalConfig: ReturnType<typeof useWikiStore.getState>["generalConfig"],
  maxHistoryMessages: number,
  uiLanguage: string,
  projectPath?: string,
  theme?: AppTheme,
  zoomLevel?: number,
): SettingsDraft {
  // Show absolute path: if stored path is empty, show default using project path
  // If stored path is relative (legacy), prepend project path
  // If stored path is absolute, show as-is
  let displayPath = scheduledImport.path || ""
  if (!displayPath && projectPath) {
    displayPath = `${projectPath}/raw/sources`
  } else if (displayPath && projectPath && !displayPath.startsWith("/") && !displayPath.match(/^[a-zA-Z]:[/\\]/)) {
    // Legacy relative path - prepend project path for display
    displayPath = `${projectPath}/${displayPath}`
  }

  return {
    provider: llm.provider,
    apiKey: llm.apiKey,
    model: llm.model,
    ollamaUrl: llm.ollamaUrl,
    customEndpoint: llm.customEndpoint,
    azureApiVersion: llm.azureApiVersion ?? "2024-10-21",
    azureModelFamily: llm.azureModelFamily ?? "auto",
    maxContextSize: llm.maxContextSize ?? 204800,
    apiMode: llm.apiMode,
    reasoning: llm.reasoning,
    localCliIsolation: llm.localCliIsolation === true,
    embeddingEnabled: embed.enabled,
    embeddingEndpoint: embed.endpoint,
    embeddingApiKey: embed.apiKey,
    embeddingModel: embed.model,
    embeddingOutputDimensionality: embed.outputDimensionality,
    embeddingMaxChunkChars: embed.maxChunkChars,
    embeddingOverlapChunkChars: embed.overlapChunkChars,
    embeddingExtraHeaders: embed.extraHeaders ?? {},
    multimodalEnabled: multimodal.enabled,
    multimodalUseMainLlm: multimodal.useMainLlm,
    multimodalProvider: multimodal.provider,
    multimodalApiKey: multimodal.apiKey,
    multimodalModel: multimodal.model,
    multimodalOllamaUrl: multimodal.ollamaUrl,
    multimodalCustomEndpoint: multimodal.customEndpoint,
    multimodalAzureApiVersion: multimodal.azureApiVersion ?? "2024-10-21",
    multimodalAzureModelFamily: multimodal.azureModelFamily ?? "auto",
    multimodalApiMode: multimodal.apiMode,
    multimodalConcurrency: multimodal.concurrency,
    outputLanguage,
    maxHistoryMessages,
    proxyEnabled: proxy.enabled,
    proxyUrl: proxy.url,
    proxyBypassLocal: proxy.bypassLocal,
    scheduledImportEnabled: scheduledImport.enabled,
    scheduledImportPath: displayPath,
    scheduledImportInterval: scheduledImport.interval,
    sourceWatchConfig: normalizeSourceWatchConfig(sourceWatch),
    mineruEnabled: mineru.enabled,
    mineruToken: mineru.token,
    mineruModelVersion: mineru.modelVersion,
    apiEnabled: apiConfig.enabled,
    apiAllowUnauthenticated: apiConfig.allowUnauthenticated,
    apiAllowLanAccess: apiConfig.allowLanAccess,
    apiMcpEnabled: apiConfig.mcpEnabled,
    apiToken: apiConfig.token,
    autostart: generalConfig.autostart,
    closeBehavior: generalConfig.closeBehavior,
    uiLanguage,
    theme: theme ?? "system",
    zoomLevel: zoomLevel ?? useZoomStore.getState().level,
  }
}

export function SettingsView() {
  const { t } = useTranslation()
  const project = useWikiStore((s) => s.project)
  const llmConfig = useWikiStore((s) => s.llmConfig)
  const setLlmConfig = useWikiStore((s) => s.setLlmConfig)
  const embeddingConfig = useWikiStore((s) => s.embeddingConfig)
  const setEmbeddingConfig = useWikiStore((s) => s.setEmbeddingConfig)
  const multimodalConfig = useWikiStore((s) => s.multimodalConfig)
  const setMultimodalConfig = useWikiStore((s) => s.setMultimodalConfig)
  const outputLanguage = useWikiStore((s) => s.outputLanguage)
  const setOutputLanguage = useWikiStore((s) => s.setOutputLanguage)
  const proxyConfig = useWikiStore((s) => s.proxyConfig)
  const setProxyConfig = useWikiStore((s) => s.setProxyConfig)
  const scheduledImportConfig = useWikiStore((s) => s.scheduledImportConfig)
  const setScheduledImportConfig = useWikiStore((s) => s.setScheduledImportConfig)
  const sourceWatchConfig = useWikiStore((s) => s.sourceWatchConfig)
  const setSourceWatchConfig = useWikiStore((s) => s.setSourceWatchConfig)
  const mineruConfig = useWikiStore((s) => s.mineruConfig)
  const setMineruConfig = useWikiStore((s) => s.setMineruConfig)
  const apiConfig = useWikiStore((s) => s.apiConfig)
  const setApiConfig = useWikiStore((s) => s.setApiConfig)
  const generalConfig = useWikiStore((s) => s.generalConfig)
  const setGeneralConfig = useWikiStore((s) => s.setGeneralConfig)
  const maxHistoryMessages = useChatStore((s) => s.maxHistoryMessages)
  const setMaxHistoryMessages = useChatStore((s) => s.setMaxHistoryMessages)
  // Drives the red dot next to the "About" row in the settings
  // sidebar. Uses `hasAvailableUpdate` (NOT `shouldShowUpdateBanner`)
  // so the indicator remains even after the user dismisses the
  // top banner — the user explicitly asked for the gear/About dots
  // to keep showing as a signpost so they can find the update
  // again later. The top banner stays gated by the dismiss
  // preference so the more aggressive interruption only fires once
  // per version.
  const updateAvailable = useUpdateStore((s) => hasAvailableUpdate(s))

  const [active, setActive] = useState<CategoryId>("llm")
  const [saved, setSaved] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [currentTheme, setCurrentTheme] = useState<AppTheme>("system")
  const [draft, setDraftState] = useState<SettingsDraft>(() =>
    initialDraft(
      llmConfig,
      embeddingConfig,
      multimodalConfig,
      outputLanguage,
      proxyConfig,
      scheduledImportConfig,
      sourceWatchConfig,
      mineruConfig,
      apiConfig,
      generalConfig,
      maxHistoryMessages,
      i18n.language,
      project?.path,
    ),
  )

  // Load theme on mount
  useEffect(() => {
    loadTheme().then((theme) => {
      if (theme) {
        setCurrentTheme(theme)
        setDraftState((prev) => ({ ...prev, theme }))
      }
    }).catch(() => {})
  }, [])

  useEffect(() => {
    let cancelled = false
    loadSourceWatchConfig(project?.id).then((config) => {
      if (cancelled) return
      const normalized = normalizeSourceWatchConfig(config)
      setSourceWatchConfig(normalized)
      setDraftState((prev) => ({ ...prev, sourceWatchConfig: normalized }))
    }).catch(() => {
      if (cancelled) return
      const fallback = normalizeSourceWatchConfig()
      setSourceWatchConfig(fallback)
      setDraftState((prev) => ({ ...prev, sourceWatchConfig: fallback }))
    })
    return () => {
      cancelled = true
    }
  }, [project?.id, setSourceWatchConfig])

  // Resync draft from store if it changes out-of-band (e.g. project switch).
  // IMPORTANT: keep the current draft.uiLanguage instead of re-reading
  // `i18n.language`. handleSave calls multiple zustand setters before it
  // calls `i18n.changeLanguage` at the end, and each setter triggers this
  // effect mid-save — which used to clobber the user's pending language
  // pick with the still-stale `i18n.language`. The next save would then
  // see draft.uiLanguage out of sync with i18n.language and silently
  // revert the UI to the previous language.
  // Same applies to zoomLevel — preserve the user's pending value through
  // the resync so mid-save store updates don't revert the input.
  useEffect(() => {
    setDraftState((prev) =>
      initialDraft(
        llmConfig,
        embeddingConfig,
        multimodalConfig,
        outputLanguage,
        proxyConfig,
        scheduledImportConfig,
        sourceWatchConfig,
        mineruConfig,
        apiConfig,
        generalConfig,
        maxHistoryMessages,
        prev.uiLanguage,
        project?.path,
        prev.theme,
        prev.zoomLevel,
      ),
    )
  }, [
    llmConfig,
    embeddingConfig,
    multimodalConfig,
    outputLanguage,
    proxyConfig,
    scheduledImportConfig,
    sourceWatchConfig,
    mineruConfig,
    apiConfig,
    generalConfig,
    maxHistoryMessages,
    project,
  ])

  const setDraft: DraftSetter = useCallback((key, value) => {
    setSaveError(null)
    setDraftState((prev) => ({ ...prev, [key]: value }))
  }, [])

  useEffect(() => {
    setSaveError(null)
  }, [active])

  const handleSave = useCallback(async () => {
    setSaveError(null)
    const {
      saveLlmConfig,
      loadLlmConfig,
      saveEmbeddingConfig,
      loadEmbeddingConfig,
      saveMultimodalConfig,
      loadMultimodalConfig,
      saveOutputLanguage,
      loadOutputLanguage,
      saveProxyConfig,
      loadProxyConfig,
      saveScheduledImportConfig,
      loadScheduledImportConfig,
      saveSourceWatchConfig,
      saveMineruConfig,
      loadMineruConfig,
      saveApiConfig,
      loadApiConfig,
      saveGeneralConfig,
      loadGeneralConfig,
      saveZoomLevel,
      loadZoomLevel,
    } = await import("@/lib/project-store")

    const newLlm = {
      provider: draft.provider,
      apiKey: draft.apiKey,
      model: draft.model,
      ollamaUrl: draft.ollamaUrl,
      customEndpoint: draft.customEndpoint,
      azureApiVersion: draft.provider === "azure" ? draft.azureApiVersion.trim() : undefined,
      azureModelFamily: draft.provider === "azure" ? draft.azureModelFamily : undefined,
      maxContextSize: draft.maxContextSize,
      apiMode: draft.provider === "custom" ? draft.apiMode : undefined,
      reasoning: draft.reasoning,
      localCliIsolation: draft.localCliIsolation,
    }
    const newEmbed = {
      enabled: draft.embeddingEnabled,
      endpoint: draft.embeddingEndpoint,
      apiKey: draft.embeddingApiKey,
      model: draft.embeddingModel,
      outputDimensionality: draft.embeddingOutputDimensionality,
      maxChunkChars: draft.embeddingMaxChunkChars,
      overlapChunkChars: draft.embeddingOverlapChunkChars,
      extraHeaders: draft.embeddingExtraHeaders,
    }
    const newMultimodal = {
      enabled: draft.multimodalEnabled,
      useMainLlm: draft.multimodalUseMainLlm,
      provider: draft.multimodalProvider,
      apiKey: draft.multimodalApiKey,
      model: draft.multimodalModel,
      ollamaUrl: draft.multimodalOllamaUrl,
      customEndpoint: draft.multimodalCustomEndpoint,
      azureApiVersion: draft.multimodalProvider === "azure" ? draft.multimodalAzureApiVersion.trim() : undefined,
      azureModelFamily: draft.multimodalProvider === "azure" ? draft.multimodalAzureModelFamily : undefined,
      apiMode: draft.multimodalProvider === "custom" ? draft.multimodalApiMode : undefined,
      // Clamp at save time so a hand-edited persisted store with a
      // ridiculous concurrency value (e.g. someone setting 1000 in
      // the JSON) doesn't blow up the captioning pipeline. Caption
      // calls already share the LLM endpoint with everything else;
      // going wider than ~16 just queues behind the server's batch
      // slot.
      concurrency: Math.max(1, Math.min(16, draft.multimodalConcurrency || 4)),
    }

    const newProxy = {
      enabled: draft.proxyEnabled,
      url: draft.proxyUrl.trim(),
      bypassLocal: draft.proxyBypassLocal,
    }
    const newSourceWatch = normalizeSourceWatchConfig(draft.sourceWatchConfig)
    const newScheduledImport = {
      enabled: draft.scheduledImportEnabled,
      path: draft.scheduledImportPath,
      interval: Math.max(1, Math.min(1440, draft.scheduledImportInterval || 60)),
      lastScan: scheduledImportConfig.lastScan,
    }
    const newMineruConfig = {
      enabled: draft.mineruEnabled,
      token: draft.mineruToken.trim(),
      modelVersion: draft.mineruModelVersion,
    }
    const newApiConfig = {
      enabled: draft.apiEnabled,
      allowUnauthenticated: draft.apiAllowUnauthenticated,
      allowLanAccess: draft.apiAllowLanAccess,
      mcpEnabled: draft.apiMcpEnabled,
      token: draft.apiToken.trim(),
    }
    const newGeneralConfig = {
      autostart: draft.autostart,
      closeBehavior: draft.closeBehavior,
    }

    // Push all config values to zustand before any awaited save below. The
    // settings draft resync effect runs after store updates; if any config stays
    // stale until later in the save sequence, that resync can briefly restore
    // the old value and make the UI look like saving reverted the user's edit.
    setLlmConfig(newLlm)
    setEmbeddingConfig(newEmbed)
    setMultimodalConfig(newMultimodal)
    setOutputLanguage(draft.outputLanguage as typeof outputLanguage)
    setProxyConfig(newProxy)
    setSourceWatchConfig(newSourceWatch)
    setScheduledImportConfig(newScheduledImport)
    setMaxHistoryMessages(draft.maxHistoryMessages)
    setMineruConfig(newMineruConfig)
    setApiConfig(newApiConfig)
    setGeneralConfig(newGeneralConfig)

    try {
      await saveLlmConfig(newLlm)
      await saveEmbeddingConfig(newEmbed)
      await saveMultimodalConfig(newMultimodal)
      await saveOutputLanguage(draft.outputLanguage as typeof outputLanguage, project?.id)
      await saveProxyConfig(newProxy)
      await saveSourceWatchConfig(newSourceWatch, project?.id)
      if (project) {
        const { startProjectFileSync, stopProjectFileSync } = await import("@/lib/project-file-sync")
        if (newSourceWatch.enabled) {
          await startProjectFileSync(project, newSourceWatch).catch((err) =>
            console.error("Failed to start project file sync:", err)
          )
        } else {
          await stopProjectFileSync()
        }
      }
      // Apply the proxy env vars LIVE so the next outbound request
      // picks them up — no app restart needed. tauri-plugin-http
      // builds a fresh reqwest client per fetch and reqwest reads
      // env vars at build time, so changing them here is enough.
      try {
        await invoke<string>("set_proxy_env", { config: newProxy })
      } catch (err) {
        console.warn("[proxy] live update failed; restart will still apply:", err)
      }

      if (project) {
        await saveScheduledImportConfig(project.path, newScheduledImport)
        const { startScheduledImport, stopScheduledImport } = await import("@/lib/scheduled-import")
        if (
          newScheduledImport.enabled &&
          newScheduledImport.path &&
          newScheduledImport.interval > 0
        ) {
          startScheduledImport(project, newScheduledImport)
        } else {
          stopScheduledImport()
        }
      }

      await saveMineruConfig(newMineruConfig)

      // The Rust side reads `apiConfig.{enabled,token,mcpEnabled,allowLanAccess}` from this
      // same `app-state.json` via a 5s cache, so saved changes propagate within
      // that window without any IPC round-trip. Bind-address changes still
      // require an app restart because the server sockets are already open.
      await saveApiConfig(newApiConfig)
      try {
        await invoke<string>("api_server_reload_config")
      } catch (err) {
        console.warn("[api] failed to reload API server config cache:", err)
      }

      await saveGeneralConfig(newGeneralConfig)
      try {
        if (newGeneralConfig.autostart) {
          await enableAutostart()
        } else {
          await disableAutostart()
        }
      } catch (err) {
        console.warn("[general] failed to update autostart:", err)
      }
      try {
        await invoke<string>("set_close_behavior", { value: newGeneralConfig.closeBehavior })
      } catch (err) {
        console.warn("[general] failed to update close behavior:", err)
      }

      if (draft.uiLanguage !== i18n.language) {
        await i18n.changeLanguage(draft.uiLanguage)
        await saveLanguage(draft.uiLanguage)
      }

      // Save theme
      if (draft.theme !== currentTheme) {
        await saveTheme(draft.theme)
        setCurrentTheme(draft.theme)
        // Apply theme immediately
        applyTheme(draft.theme)
      }

      // Apply zoom level
      useZoomStore.getState().setLevel(draft.zoomLevel)
      await saveZoomLevel(draft.zoomLevel)

      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error("[settings] failed to save settings:", err)
      const resultValue = <T,>(result: PromiseSettledResult<T>, fallback: T): T =>
        result.status === "fulfilled" ? result.value : fallback
      try {
        const [
          persistedLlm,
          persistedEmbedding,
          persistedMultimodal,
          persistedOutputLanguage,
          persistedProxy,
          persistedSourceWatch,
          persistedScheduledImport,
          persistedMineru,
          persistedApi,
          persistedGeneral,
          persistedZoom,
        ] = await Promise.allSettled([
          loadLlmConfig(),
          loadEmbeddingConfig(),
          loadMultimodalConfig(),
          loadOutputLanguage(project?.id),
          loadProxyConfig(),
          loadSourceWatchConfig(project?.id),
          project ? loadScheduledImportConfig(project.path) : Promise.resolve(null),
          loadMineruConfig(),
          loadApiConfig(),
          loadGeneralConfig(),
          loadZoomLevel(),
        ] as const)
        setLlmConfig(resultValue(persistedLlm, null) ?? llmConfig)
        setEmbeddingConfig(resultValue(persistedEmbedding, null) ?? embeddingConfig)
        setMultimodalConfig(resultValue(persistedMultimodal, null) ?? multimodalConfig)
        setOutputLanguage((resultValue(persistedOutputLanguage, null) ?? outputLanguage) as typeof outputLanguage)
        setProxyConfig(resultValue(persistedProxy, null) ?? proxyConfig)
        setSourceWatchConfig(resultValue(persistedSourceWatch, sourceWatchConfig))
        setScheduledImportConfig(resultValue(persistedScheduledImport, null) ?? scheduledImportConfig)
        setMaxHistoryMessages(maxHistoryMessages)
        setMineruConfig(resultValue(persistedMineru, null) ?? mineruConfig)
        setApiConfig(resultValue(persistedApi, null) ?? apiConfig)
        setGeneralConfig(resultValue(persistedGeneral, generalConfig))
        useZoomStore.getState().setLevel(resultValue(persistedZoom, useZoomStore.getState().level))
      } catch (reloadErr) {
        console.warn("[settings] failed to reload persisted settings after save failure:", reloadErr)
      }
      setSaveError(message || "unknown error")
    }
  }, [
    draft,
    project,
    llmConfig,
    embeddingConfig,
    multimodalConfig,
    outputLanguage,
    proxyConfig,
    sourceWatchConfig,
    scheduledImportConfig,
    mineruConfig,
    apiConfig,
    generalConfig,
    maxHistoryMessages,
    setLlmConfig,
    setEmbeddingConfig,
    setMultimodalConfig,
    setOutputLanguage,
    setProxyConfig,
    setScheduledImportConfig,
    setSourceWatchConfig,
    setMineruConfig,
    setApiConfig,
    setGeneralConfig,
    setMaxHistoryMessages,
    currentTheme,
  ])

  const body = useMemo(() => {
    switch (active) {
      case "general":
        return <GeneralSection draft={draft} setDraft={setDraft} />
      case "llm":
        // The LLM section manages its own store state (per-provider
        // configs + active preset) and persists directly — it bypasses
        // the shared draft / global Save button.
        return <LlmProviderSection />
      case "embedding":
        return <EmbeddingSection draft={draft} setDraft={setDraft} />
      case "multimodal":
        return <MultimodalSection draft={draft} setDraft={setDraft} />
      case "web-search":
        return <WebSearchSection />
      case "network":
        return <NetworkSection draft={draft} setDraft={setDraft} />
      case "source-watch":
        return <SourceWatchSection draft={draft} setDraft={setDraft} projectReady={!!project} />
      case "scheduled-import":
        return <ScheduledImportSection draft={draft} setDraft={setDraft} />
      case "mineru":
        return <MineruSection draft={draft} setDraft={setDraft} />
      case "api-server":
        return <ApiServerSection draft={draft} setDraft={setDraft} />
      case "output":
        return <OutputSection draft={draft} setDraft={setDraft} />
      case "interface":
        return <InterfaceSection draft={draft} setDraft={setDraft} onThemeChange={applyTheme} />
      case "maintenance":
        return <MaintenanceSection />
      case "changelog":
        return <ChangelogSection />
      case "about":
        return <AboutSection />
    }
  }, [active, draft, setDraft])

  return (
    <div className="flex h-full overflow-hidden">
      {/* Sidebar — category nav. Matches the IconSidebar's pill-on-accent
          pattern so the two navigational surfaces feel like one app. */}
      <aside className="flex w-56 shrink-0 flex-col border-r bg-muted/30">
        <div className="px-4 pb-2 pt-4 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          {t("settings.title")}
        </div>
        <nav className="flex-1 overflow-y-auto px-2 pb-3">
          {CATEGORIES.map((c) => {
            const Icon = c.icon
            const isActive = c.id === active
            // Mirror the gear-icon dot inside the settings sidebar
            // so the user can find which sub-section the update
            // notification is pointing at. Update info lives in
            // the About panel, so the dot follows the About row.
            // Same store, same gating — once dismissed, both
            // disappear together.
            const showUpdateDot =
              c.id === "about" && updateAvailable
            return (
              <button
                key={c.id}
                type="button"
                onClick={() => setActive(c.id)}
                aria-current={isActive ? "page" : undefined}
                className={`group mb-0.5 flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm transition-colors ${
                  isActive
                    ? "bg-foreground/[0.08] font-medium text-foreground ring-1 ring-border/70"
                    : "text-muted-foreground hover:bg-accent/50 hover:text-accent-foreground"
                }`}
              >
                <Icon
                  className={`h-4 w-4 shrink-0 transition-colors ${
                    isActive ? "text-primary" : "text-muted-foreground/80 group-hover:text-accent-foreground"
                  }`}
                />
                <span className="truncate">{t(c.labelKey)}</span>
                {showUpdateDot && (
                  <span
                    className="ml-auto h-2 w-2 shrink-0 rounded-full bg-red-500"
                    aria-label={t("nav.updateAvailable")}
                    title={t("nav.updateAvailable")}
                  />
                )}
              </button>
            )
          })}
        </nav>
      </aside>

      {/* Content */}
      <div className="flex flex-1 flex-col overflow-hidden">
        <div className="flex-1 overflow-y-auto px-8 py-6">
          <div className="mx-auto max-w-2xl">{body}</div>
        </div>

        {/* Global Save bar hidden for sections that persist inline:
            - "llm" saves per-row on every edit (independent per-preset state)
            - "about" has no draft-bound fields */}
        {active !== "about" && active !== "llm" && (
          <div className="shrink-0 border-t bg-background/80 backdrop-blur px-8 py-3">
            <div className="mx-auto flex max-w-2xl items-center justify-between gap-4">
              <p className={`text-xs ${saveError ? "text-destructive" : "text-muted-foreground"}`}>
                {saveError
                  ? t("settings.saveFailed")
                  : saved
                    ? t("settings.savedTick")
                    : t("settings.changeHint")}
              </p>
              <Button onClick={handleSave}>
                {saved ? t("settings.saved") : t("settings.save")}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

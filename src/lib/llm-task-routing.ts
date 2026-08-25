import { findLlmPreset } from "@/components/settings/llm-presets"
import { resolveConfig } from "@/components/settings/preset-resolver"
import { hasUsableLlm } from "@/lib/has-usable-llm"
import type {
  LlmConfig,
  ProjectLlmOverride,
  CustomLlmPreset,
  ProviderConfigs,
  TaskModelRoutingConfig,
} from "@/stores/wiki-store"
import { useWikiStore } from "@/stores/wiki-store"

export type LlmTaskKind = "chat" | "ingest"

export function resolveProjectLlmConfig(
  globalConfig: LlmConfig,
  providerConfigs: ProviderConfigs,
  projectOverride: ProjectLlmOverride,
  customPresets: CustomLlmPreset[] = [],
): LlmConfig {
  // Keep this fallback contract aligned with project_llm_config in
  // src-tauri/src/api_server.rs. Native API/MCP callers resolve the same
  // persisted override without running this TypeScript code.
  if (!projectOverride.enabled || !projectOverride.presetId) return globalConfig
  const preset = findLlmPreset(projectOverride.presetId, customPresets)
  if (!preset) return globalConfig
  const baseOverride = providerConfigs[projectOverride.presetId]
  const override = projectOverride.model.trim()
    ? { ...baseOverride, model: projectOverride.model.trim() }
    : baseOverride
  return resolveConfig(preset, override, globalConfig)
}

export function projectLlmProfile(config: LlmConfig): Omit<LlmConfig, "apiKey" | "customHeaders"> {
  // Headers can contain gateway credentials, so keep them in the provider
  // credential record and merge them at runtime just like the API key.
  const { apiKey: _apiKey, customHeaders: _customHeaders, ...profile } = config
  return profile
}

export function hydrateTaskModelRoutingProfile(
  routing: TaskModelRoutingConfig,
  fallback: LlmConfig,
  providerConfigs: ProviderConfigs,
  customPresets: CustomLlmPreset[] = [],
): TaskModelRoutingConfig {
  if (!routing.chatPresetId || routing.chatProfile) return routing
  const resolved = resolveTaskLlmConfig("chat", fallback, providerConfigs, routing, undefined, customPresets)
  if (resolved === fallback) return routing
  return { ...routing, chatProfile: projectLlmProfile(resolved) }
}

/**
 * Resolve a task-specific provider from the current preset overrides.
 * Routing stores preset ids rather than credential snapshots so API-key,
 * endpoint, and model edits take effect immediately. Missing/deleted preset
 * ids fail safely to the active global configuration.
 */
export function resolveTaskLlmConfig(
  task: LlmTaskKind,
  fallback: LlmConfig,
  providerConfigs: ProviderConfigs,
  routing: TaskModelRoutingConfig,
  projectOverride?: ProjectLlmOverride,
  customPresets: CustomLlmPreset[] = [],
): LlmConfig {
  if (projectOverride?.enabled) return fallback
  if (!hasUsableLlm(fallback)) return fallback
  const presetId = task === "chat" ? routing.chatPresetId : routing.ingestPresetId
  if (!presetId) return fallback
  const preset = findLlmPreset(presetId, customPresets)
  if (!preset) return fallback
  return resolveConfig(preset, providerConfigs[presetId], fallback)
}

/** Resolve against one atomic Zustand snapshot for imperative/background code. */
export function getTaskLlmConfig(task: LlmTaskKind, fallback?: LlmConfig): LlmConfig {
  const state = useWikiStore.getState()
  return resolveTaskLlmConfig(
    task,
    fallback ?? state.llmConfig,
    state.providerConfigs,
    state.taskModelRouting,
    state.projectLlmOverride,
    state.customLlmPresets,
  )
}

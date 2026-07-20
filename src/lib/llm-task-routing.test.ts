import { describe, expect, it } from "vitest"
import { resolveProjectLlmConfig, resolveTaskLlmConfig } from "./llm-task-routing"
import type { LlmConfig } from "@/stores/wiki-store"

const fallback: LlmConfig = {
  provider: "openai",
  apiKey: "global-key",
  model: "global-model",
  ollamaUrl: "http://localhost:11434",
  customEndpoint: "",
  maxContextSize: 128000,
}

describe("resolveTaskLlmConfig", () => {
  it("uses the active global config when no task override is selected", () => {
    expect(resolveTaskLlmConfig("chat", fallback, {}, {
      chatPresetId: null,
      ingestPresetId: null,
    })).toBe(fallback)
  })

  it("resolves chat and ingest from independent provider presets", () => {
    const configs = {
      openai: { apiKey: "chat-key", model: "gpt-4o-mini" },
      anthropic: { apiKey: "ingest-key", model: "claude-sonnet-4-6" },
    }
    const routing = { chatPresetId: "openai", ingestPresetId: "anthropic" }

    expect(resolveTaskLlmConfig("chat", fallback, configs, routing)).toMatchObject({
      provider: "openai",
      apiKey: "chat-key",
      model: "gpt-4o-mini",
    })
    expect(resolveTaskLlmConfig("ingest", fallback, configs, routing)).toMatchObject({
      provider: "anthropic",
      apiKey: "ingest-key",
      model: "claude-sonnet-4-6",
    })
  })

  it("falls back when a persisted preset id no longer exists", () => {
    expect(resolveTaskLlmConfig("ingest", fallback, {}, {
      chatPresetId: null,
      ingestPresetId: "removed-provider",
    })).toBe(fallback)
  })

  it("routes tasks through a user-defined custom provider", () => {
    const custom = [{ id: "custom-team", label: "Team Gateway" }]
    expect(resolveTaskLlmConfig(
      "chat",
      fallback,
      { "custom-team": { apiKey: "team-key", model: "team-model", baseUrl: "https://gateway.example/v1" } },
      { chatPresetId: "custom-team", ingestPresetId: null },
      undefined,
      custom,
    )).toMatchObject({
      provider: "custom",
      apiKey: "team-key",
      model: "team-model",
      customEndpoint: "https://gateway.example/v1",
    })
  })
})

describe("resolveProjectLlmConfig", () => {
  it("keeps the global config when project overrides are disabled", () => {
    expect(resolveProjectLlmConfig(fallback, {}, {
      enabled: false,
      presetId: "anthropic",
      model: "project-model",
    })).toBe(fallback)
  })

  it("uses global credentials with a project-specific provider and model", () => {
    const resolved = resolveProjectLlmConfig(fallback, {
      anthropic: { apiKey: "shared-secret", model: "global-anthropic-model" },
    }, {
      enabled: true,
      presetId: "anthropic",
      model: "project-sonnet",
    })
    expect(resolved).toMatchObject({
      provider: "anthropic",
      apiKey: "shared-secret",
      model: "project-sonnet",
    })
  })

  it("supports a user-defined custom provider as a project override", () => {
    expect(resolveProjectLlmConfig(
      fallback,
      { "custom-team": { apiKey: "secret", baseUrl: "https://team.example/v1" } },
      { enabled: true, presetId: "custom-team", model: "project-model" },
      [{ id: "custom-team", label: "Team" }],
    )).toMatchObject({
      provider: "custom",
      apiKey: "secret",
      model: "project-model",
      customEndpoint: "https://team.example/v1",
    })
  })

  it("makes a project override take precedence over global task routing", () => {
    expect(resolveTaskLlmConfig(
      "chat",
      { ...fallback, provider: "anthropic", model: "project-sonnet" },
      { openai: { apiKey: "chat-key", model: "cheap-chat" } },
      { chatPresetId: "openai", ingestPresetId: null },
      { enabled: true, presetId: "anthropic", model: "project-sonnet" },
    )).toMatchObject({ provider: "anthropic", model: "project-sonnet" })
  })
})

// Server-port regression tests for task-model routing resolution
// (issue #14 P0). Ported from the desktop cases in
// src/lib/llm-task-routing.test.ts that exercise the *ingest* slot, adapted
// to the store-snapshot API (resolveChatConfig / resolveIngestConfig read the
// same persisted shapes the web Settings UI writes).

import { describe, expect, it } from "vitest"
import { resolveChatConfig, resolveIngestConfig, hasUsableLlmConfig } from "../src/llm-resolve.js"

const llmConfig = {
  provider: "openai",
  apiKey: "global-key",
  model: "global-model",
  ollamaUrl: "http://localhost:11434",
  customEndpoint: "",
  maxContextSize: 128000,
}

function store(overrides = {}) {
  return { llmConfig, ...overrides }
}

describe("resolveIngestConfig", () => {
  it("uses the active global config when no task override is selected", () => {
    const s = store({ taskModelRouting: { chatPresetId: null, ingestPresetId: null } })
    expect(resolveIngestConfig(s)).toBe(llmConfig)
    expect(resolveChatConfig(s)).toBe(llmConfig)
  })

  it("resolves chat and ingest from independent provider presets", () => {
    const s = store({
      providerConfigs: {
        openai: { apiKey: "chat-key", model: "gpt-4o-mini" },
        anthropic: { apiKey: "ingest-key", model: "claude-sonnet-4-6" },
      },
      taskModelRouting: { chatPresetId: "openai", ingestPresetId: "anthropic" },
    })
    expect(resolveChatConfig(s)).toMatchObject({
      provider: "openai",
      apiKey: "chat-key",
      model: "gpt-4o-mini",
    })
    expect(resolveIngestConfig(s)).toMatchObject({
      provider: "anthropic",
      apiKey: "ingest-key",
      model: "claude-sonnet-4-6",
    })
  })

  it("reads the ingest slot, never the chat slot", () => {
    const s = store({
      providerConfigs: { anthropic: { apiKey: "ingest-key" } },
      taskModelRouting: { chatPresetId: "anthropic", ingestPresetId: null },
    })
    // chat routes to the preset, ingest stays on the global config
    expect(resolveChatConfig(s)).toMatchObject({ provider: "anthropic", apiKey: "ingest-key" })
    expect(resolveIngestConfig(s)).toBe(llmConfig)
  })

  it("treats an unknown preset id as a custom gateway (credentials still apply)", () => {
    // Server findLlmPreset contract: unknown ids keep providerConfigs[id]
    // credentials live (gateway preset deleted from the projection but still
    // configured) instead of silently dropping to the global config.
    const s = store({
      providerConfigs: { "removed-provider": { apiKey: "leftover-key", baseUrl: "https://gw.example/v1" } },
      taskModelRouting: { chatPresetId: null, ingestPresetId: "removed-provider" },
    })
    expect(resolveIngestConfig(s)).toMatchObject({
      provider: "custom",
      apiKey: "leftover-key",
      model: "",
      customEndpoint: "https://gw.example/v1",
    })
    expect(hasUsableLlmConfig(resolveIngestConfig(s))).toBe(true)
  })

  it("routes ingest through a user-defined custom preset", () => {
    const s = store({
      customLlmPresets: [{ id: "custom-ingest", label: "Ingest Gateway" }],
      providerConfigs: { "custom-ingest": { apiKey: "team-key", model: "team-model", baseUrl: "https://gateway.example/v1" } },
      taskModelRouting: { chatPresetId: null, ingestPresetId: "custom-ingest" },
    })
    expect(resolveIngestConfig(s)).toMatchObject({
      provider: "custom",
      apiKey: "team-key",
      model: "team-model",
      customEndpoint: "https://gateway.example/v1",
    })
  })

  it("makes a project override take precedence over ingest routing", () => {
    const s = store({
      llmConfig: { ...llmConfig, provider: "anthropic", model: "project-sonnet" },
      providerConfigs: { openai: { apiKey: "chat-key", model: "cheap-model" } },
      taskModelRouting: { chatPresetId: null, ingestPresetId: "openai" },
      projectLlmOverride: { enabled: true, presetId: "anthropic", model: "project-sonnet" },
    })
    expect(resolveIngestConfig(s)).toMatchObject({ provider: "anthropic", model: "project-sonnet" })
  })

  it("tolerates a store with no routing or provider records at all", () => {
    expect(resolveIngestConfig({})).toEqual({})
    expect(hasUsableLlmConfig(resolveIngestConfig({}))).toBe(false)
  })
})

describe("hasUsableLlmConfig", () => {
  it("accepts no-key providers without credentials", () => {
    expect(hasUsableLlmConfig({ provider: "ollama", apiKey: "" })).toBe(true)
    expect(hasUsableLlmConfig({ provider: "custom", apiKey: "" })).toBe(true)
  })

  it("requires a non-blank API key for hosted providers", () => {
    expect(hasUsableLlmConfig({ provider: "openai", apiKey: "k" })).toBe(true)
    expect(hasUsableLlmConfig({ provider: "openai", apiKey: "" })).toBe(false)
    expect(hasUsableLlmConfig({ provider: "anthropic", apiKey: "   " })).toBe(false)
    expect(hasUsableLlmConfig({})).toBe(false)
  })
})

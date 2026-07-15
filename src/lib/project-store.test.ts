import { describe, expect, it } from "vitest"
import { __projectStoreTest } from "./project-store"

describe("project-store MinerU config normalization", () => {
  it("preserves valid MinerU config values", () => {
    expect(__projectStoreTest.normalizeMineruConfig({
      enabled: true,
      token: "token-123",
      modelVersion: "pipeline",
    })).toEqual({
      enabled: true,
      token: "token-123",
      modelVersion: "pipeline",
    })
  })

  it("migrates legacy and malformed MinerU config values to safe defaults", () => {
    expect(__projectStoreTest.normalizeMineruConfig({
      enabled: "yes" as unknown as boolean,
      token: 123 as unknown as string,
      modelVersion: "mineru-html" as "vlm",
    })).toEqual({
      enabled: false,
      token: "",
      modelVersion: "vlm",
    })
  })
})

describe("project-store zoom normalization", () => {
  it("preserves valid zoom values", () => {
    expect(__projectStoreTest.normalizeZoomLevel(0.5)).toBe(0.5)
    expect(__projectStoreTest.normalizeZoomLevel(1.25)).toBe(1.25)
    expect(__projectStoreTest.normalizeZoomLevel(3)).toBe(3)
  })

  it("clamps finite out-of-range values", () => {
    expect(__projectStoreTest.normalizeZoomLevel(-2)).toBe(0.5)
    expect(__projectStoreTest.normalizeZoomLevel(0)).toBe(0.5)
    expect(__projectStoreTest.normalizeZoomLevel(0.49)).toBe(0.5)
    expect(__projectStoreTest.normalizeZoomLevel(3.01)).toBe(3)
  })

  it("falls back to 100% for malformed values", () => {
    expect(__projectStoreTest.normalizeZoomLevel(undefined)).toBe(1)
    expect(__projectStoreTest.normalizeZoomLevel(null)).toBe(1)
    expect(__projectStoreTest.normalizeZoomLevel(Number.NaN)).toBe(1)
    expect(__projectStoreTest.normalizeZoomLevel(Number.POSITIVE_INFINITY)).toBe(1)
    expect(__projectStoreTest.normalizeZoomLevel("150")).toBe(1)
  })
})

describe("project-store per-project LLM settings", () => {
  const globalLlm = {
    provider: "openai" as const,
    apiKey: "global-key",
    model: "gpt-global",
    ollamaUrl: "http://localhost:11434",
    customEndpoint: "",
    maxContextSize: 128000,
  }
  const projectLlm = {
    provider: "google" as const,
    apiKey: "project-key",
    model: "gemini-project",
    ollamaUrl: "http://localhost:11434",
    customEndpoint: "",
    maxContextSize: 1000000,
  }

  it("falls back to global LLM settings when a project has no override", () => {
    expect(__projectStoreTest.resolveStoredLlmSettings({}, "project-a", {
      llmConfig: globalLlm,
      providerConfigs: { openai: { model: "gpt-global" } },
      activePresetId: "openai",
    })).toEqual({
      llmConfig: globalLlm,
      providerConfigs: { openai: { model: "gpt-global" } },
      activePresetId: "openai",
      hasProjectSettings: false,
    })
  })

  it("loads project-scoped LLM settings ahead of global defaults", () => {
    const settings = __projectStoreTest.mergeProjectLlmSettings({}, "project-a", {
      llmConfig: projectLlm,
      providerConfigs: { google: { model: "gemini-project" } },
      activePresetId: "google",
    })

    expect(__projectStoreTest.resolveStoredLlmSettings(settings, "project-a", {
      llmConfig: globalLlm,
      providerConfigs: { openai: { model: "gpt-global" } },
      activePresetId: "openai",
    })).toEqual({
      llmConfig: projectLlm,
      providerConfigs: { google: { model: "gemini-project" } },
      activePresetId: "google",
      hasProjectSettings: true,
    })
  })

  it("keeps project saves isolated and preserves explicit disabled state", () => {
    const settings = __projectStoreTest.mergeProjectLlmSettings(
      {
        "project-a": {
          llmConfig: projectLlm,
          providerConfigs: { google: { model: "gemini-project" } },
          activePresetId: "google",
        },
      },
      "project-b",
      {
        activePresetId: null,
      },
    )

    expect(settings["project-a"]?.activePresetId).toBe("google")
    expect(__projectStoreTest.resolveStoredLlmSettings(settings, "project-b", {
      llmConfig: globalLlm,
      providerConfigs: { openai: { model: "gpt-global" } },
      activePresetId: "openai",
    })).toEqual({
      llmConfig: null,
      providerConfigs: { openai: { model: "gpt-global" } },
      activePresetId: null,
      hasProjectSettings: true,
    })
  })
})

import { beforeEach, describe, expect, it, vi } from "vitest"

const state = vi.hoisted(() => ({
  values: new Map<string, unknown>(),
  secrets: new Map<string, string>(),
  invoke: vi.fn(),
  save: vi.fn(),
}))

vi.mock("@tauri-apps/plugin-store", () => ({
  load: vi.fn(async () => ({
    get: async <T>(key: string) => state.values.get(key) as T | undefined,
    set: async (key: string, value: unknown) => { state.values.set(key, value) },
    delete: async (key: string) => { state.values.delete(key) },
    save: state.save,
  })),
}))

vi.mock("@tauri-apps/api/core", () => ({
  invoke: state.invoke,
}))

import {
  loadEmbeddingConfig,
  loadLlmConfig,
  loadProviderConfigs,
  saveEmbeddingConfig,
  saveLlmConfig,
  saveProviderConfigs,
} from "./project-store"
import type { EmbeddingConfig, LlmConfig, ProviderConfigs } from "@/stores/wiki-store"

const llmConfig: LlmConfig = {
  provider: "openai",
  apiKey: "test-llm-key",
  model: "gpt-4o-mini",
  ollamaUrl: "http://localhost:11434",
  customEndpoint: "",
  maxContextSize: 8192,
}

beforeEach(() => {
  state.values.clear()
  state.secrets.clear()
  state.invoke.mockReset()
  state.save.mockReset()
  state.save.mockResolvedValue(undefined)
  state.invoke.mockImplementation(async (command: string, args?: Record<string, string>) => {
    const slot = args?.slot ?? ""
    if (command === "secure_credential_set") {
      state.secrets.set(slot, args?.secret ?? "")
      return undefined
    }
    if (command === "secure_credential_get") return state.secrets.get(slot) ?? null
    if (command === "secure_credential_delete") {
      state.secrets.delete(slot)
      return undefined
    }
    throw new Error(`unexpected command: ${command}`)
  })
})

describe("secure provider credential persistence", () => {
  it("stores the active LLM API key in secure storage and never in app-state", async () => {
    await saveLlmConfig(llmConfig)

    expect(state.secrets.get("llm")).toBe("test-llm-key")
    expect(state.values.get("llmConfig")).toEqual({ ...llmConfig, apiKey: "" })
    expect(await loadLlmConfig()).toEqual(llmConfig)
  })

  it("migrates a legacy plaintext embedding API key on first load", async () => {
    const legacy: EmbeddingConfig = {
      enabled: true,
      endpoint: "https://api.openai.com/v1/embeddings",
      apiKey: "legacy-embedding-key",
      model: "text-embedding-3-small",
    }
    state.values.set("embeddingConfig", legacy)

    expect(await loadEmbeddingConfig()).toEqual(legacy)
    expect(state.secrets.get("embedding")).toBe("legacy-embedding-key")
    expect(state.values.get("embeddingConfig")).toEqual({ ...legacy, apiKey: "" })
  })

  it("isolates preset credentials and removes deleted preset secrets", async () => {
    const configs: ProviderConfigs = {
      openai: { apiKey: "openai-key", model: "gpt-4o-mini" },
      "custom-local": { apiKey: "gateway-key", baseUrl: "http://127.0.0.1:1234/v1" },
    }
    await saveProviderConfigs(configs)

    expect(state.values.get("providerConfigs")).toEqual({
      openai: { apiKey: "", model: "gpt-4o-mini" },
      "custom-local": { apiKey: "", baseUrl: "http://127.0.0.1:1234/v1" },
    })
    expect(await loadProviderConfigs()).toEqual(configs)

    await saveProviderConfigs({ openai: configs.openai })
    expect(state.secrets.has("provider:custom-local")).toBe(false)
  })

  it("clears a secure credential when the user clears the API key", async () => {
    state.secrets.set("embedding", "old-key")
    await saveEmbeddingConfig({
      enabled: true,
      endpoint: "http://127.0.0.1:1234/v1/embeddings",
      apiKey: "",
      model: "local-embedding",
    })

    expect(state.secrets.has("embedding")).toBe(false)
    expect(JSON.stringify(state.values.get("embeddingConfig"))).not.toContain("old-key")
  })

  it("keeps a keyless local provider usable when secure storage is unavailable", async () => {
    const local = { ...llmConfig, provider: "ollama" as const, apiKey: "" }
    state.values.set("llmConfig", local)
    state.invoke.mockRejectedValue(new Error("keychain is locked"))

    await expect(loadLlmConfig()).resolves.toEqual(local)
  })

  it("does not delete an unknown credential after a fail-open load", async () => {
    const local = { ...llmConfig, provider: "ollama" as const, apiKey: "" }
    state.values.set("llmConfig", local)
    state.secrets.set("llm", "existing-key")
    state.invoke.mockRejectedValueOnce(new Error("keychain is locked"))

    expect(await loadLlmConfig()).toEqual(local)
    await saveLlmConfig(local)

    expect(state.secrets.get("llm")).toBe("existing-key")
  })

  it("rolls back the credential and config when persistence fails", async () => {
    const previous = { ...llmConfig, apiKey: "" }
    state.values.set("llmConfig", previous)
    state.secrets.set("llm", "previous-key")
    state.save.mockRejectedValueOnce(new Error("disk full"))

    await expect(saveLlmConfig({ ...llmConfig, apiKey: "new-key", model: "gpt-5" }))
      .rejects.toThrow("disk full")

    expect(state.secrets.get("llm")).toBe("previous-key")
    expect(state.values.get("llmConfig")).toEqual(previous)
  })
})

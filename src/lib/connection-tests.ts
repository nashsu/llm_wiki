import type { EmbeddingConfig, LlmConfig } from "@/stores/wiki-store"
import { fetchEmbedding, getLastEmbeddingError } from "@/lib/embedding"
import { streamChat } from "@/lib/llm-client"

export interface ProviderTestResult {
  ok: boolean
  message: string
}

export const LLM_PROVIDER_TEST_MAX_TOKENS = 512

function configForProviderTest(cfg: LlmConfig): LlmConfig {
  if (cfg.provider === "claude-code" || cfg.provider === "codex-cli") {
    return { ...cfg, localCliIsolation: true }
  }
  return cfg
}

export async function testEmbeddingConnection(cfg: EmbeddingConfig): Promise<ProviderTestResult> {
  if (!cfg.endpoint.trim()) {
    return { ok: false, message: "Embedding endpoint is empty." }
  }
  if (!cfg.model.trim()) {
    return { ok: false, message: "Embedding model is empty." }
  }

  const started = performance.now()
  const vector = await fetchEmbedding("LLM Wiki embedding connection test.", cfg, 0)
  if (!vector) {
    return {
      ok: false,
      message: getLastEmbeddingError() ?? "Embedding endpoint returned no vector.",
    }
  }

  return {
    ok: true,
    message: `Connected. Returned ${vector.length} dimensions in ${Math.round(performance.now() - started)} ms.`,
  }
}

export async function testEmbeddingFunction(cfg: EmbeddingConfig): Promise<ProviderTestResult> {
  const first = await fetchEmbedding("LLM Wiki functional embedding test: apple banana graph.", cfg, 0)
  const second = await fetchEmbedding("LLM Wiki functional embedding test: apple banana graph.", cfg, 0)
  if (!first || !second) {
    return {
      ok: false,
      message: getLastEmbeddingError() ?? "Embedding endpoint did not return vectors.",
    }
  }
  if (first.length !== second.length) {
    return {
      ok: false,
      message: `Embedding dimension changed between calls (${first.length} vs ${second.length}).`,
    }
  }
  if (first.length === 0 || first.some((v) => !Number.isFinite(v)) || second.some((v) => !Number.isFinite(v))) {
    return { ok: false, message: "Embedding endpoint returned an empty or non-finite vector." }
  }

  const norm = Math.sqrt(first.reduce((sum, v) => sum + v * v, 0))
  if (!Number.isFinite(norm) || norm <= 0) {
    return { ok: false, message: "Embedding vector norm is zero or invalid." }
  }

  return {
    ok: true,
    message: `Functional test passed. Stable ${first.length}-dimension finite vectors returned.`,
  }
}

export async function testLlmConnection(cfg: LlmConfig): Promise<ProviderTestResult> {
  const started = performance.now()
  const testCfg = configForProviderTest(cfg)
  let content = ""
  let errorMessage: string | null = null

  await streamChat(
    testCfg,
    [
      { role: "system", content: "You are a connection checker. Reply briefly." },
      { role: "user", content: "Reply with one short word." },
    ],
    {
      onToken: (token) => { content += token },
      onDone: () => {},
      onError: (err) => { errorMessage = err.message },
    },
    undefined,
    { max_tokens: LLM_PROVIDER_TEST_MAX_TOKENS, reasoning: { mode: "off" } },
  )

  if (errorMessage) return { ok: false, message: errorMessage }
  if (!content.trim()) return { ok: false, message: "Model connected but returned empty content." }
  return {
    ok: true,
    message: `Connected in ${Math.round(performance.now() - started)} ms. Response: ${content.trim().slice(0, 80)}`,
  }
}

export async function testLlmFunction(cfg: LlmConfig): Promise<ProviderTestResult> {
  const testCfg = configForProviderTest(cfg)
  let content = ""
  let errorMessage: string | null = null

  await streamChat(
    testCfg,
    [
      {
        role: "system",
        content: "You are a deterministic API test. Do not explain. Output only the requested token.",
      },
      { role: "user", content: "Output exactly this token and nothing else: LLM_WIKI_TEST_OK" },
    ],
    {
      onToken: (token) => { content += token },
      onDone: () => {},
      onError: (err) => { errorMessage = err.message },
    },
    undefined,
    { max_tokens: LLM_PROVIDER_TEST_MAX_TOKENS, reasoning: { mode: "off" } },
  )

  if (errorMessage) return { ok: false, message: errorMessage }
  const trimmed = content.trim()
  if (!trimmed.includes("LLM_WIKI_TEST_OK")) {
    return {
      ok: false,
      message: `Model responded, but did not follow the functional test prompt. Response: ${trimmed.slice(0, 120) || "(empty)"}`,
    }
  }
  return { ok: true, message: "Functional test passed. The model returned the expected token." }
}

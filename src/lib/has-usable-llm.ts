import type { DocumentLlmConfig, LlmConfig } from "@/stores/wiki-store"

export type LlmProvider = LlmConfig["provider"]

/**
 * Providers that don't need an API key to operate:
 *   - `ollama` runs on a local HTTP endpoint with no auth
 *   - `custom` is an OpenAI-compatible local-or-LAN endpoint that
 *     may or may not require auth (LM Studio, llama.cpp, vLLM
 *     defaults are all unauthenticated; users who deploy behind a
 *     proxy can still set apiKey to add Bearer auth)
 *   - `claude-code` spawns the Claude Code CLI subprocess, which
 *     authenticates via the user's existing ~/.claude OAuth — no
 *     API key is needed (or accepted) at this layer.
 *
 * Hosted providers (openai, anthropic, google, minimax) require a
 * key from the user.
 */
export const PROVIDERS_WITHOUT_KEY: ReadonlySet<LlmProvider> = new Set<LlmProvider>([
  "ollama",
  "custom",
  "claude-code",
])

/**
 * Single source of truth for "is the user's LLM configuration good
 * enough to make calls?" Replaces ad-hoc `apiKey || provider ===
 * "ollama" || …` checks scattered across ingest, sweep, lint,
 * chat, and clip-watcher — every one of which had to be edited
 * by hand whenever a new no-key provider was added, and at least
 * three of which were silently out of date when the
 * Claude Code CLI provider shipped.
 *
 * Use this everywhere a guard like "do we have an LLM?" is
 * needed; the type-level union plus the exhaustiveness test in
 * `has-usable-llm.test.ts` ensures future provider additions
 * land in exactly one bucket and don't slip through.
 */
export function hasUsableLlm(
  cfg: Pick<LlmConfig, "provider" | "apiKey">,
): boolean {
  if (PROVIDERS_WITHOUT_KEY.has(cfg.provider)) return true
  return cfg.apiKey.trim().length > 0
}

export function hasUsableDocumentLlm(
  mainCfg: Pick<LlmConfig, "provider" | "apiKey">,
  documentCfg: Pick<DocumentLlmConfig, "useMainLlm" | "provider" | "apiKey">,
): boolean {
  if (documentCfg.useMainLlm) return hasUsableLlm(mainCfg)
  return hasUsableLlm(documentCfg)
}

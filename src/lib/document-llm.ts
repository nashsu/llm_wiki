import type { DocumentLlmConfig, LlmConfig } from "@/stores/wiki-store"

export function resolveDocumentLlmConfig(
  mainLlm: LlmConfig,
  documentLlm: DocumentLlmConfig,
): LlmConfig {
  if (documentLlm.useMainLlm) return mainLlm
  return {
    provider: documentLlm.provider,
    apiKey: documentLlm.apiKey,
    model: documentLlm.model,
    ollamaUrl: documentLlm.ollamaUrl,
    customEndpoint: documentLlm.customEndpoint,
    maxContextSize: documentLlm.maxContextSize,
    apiMode: documentLlm.provider === "custom" ? documentLlm.apiMode : undefined,
    reasoning: documentLlm.reasoning,
  }
}

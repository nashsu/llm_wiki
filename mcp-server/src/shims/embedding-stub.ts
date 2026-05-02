/**
 * Stub for @/lib/embedding — vector search is not available in the skill/MCP layer
 * without a running LanceDB instance. Returns empty results so BM25-only search works.
 */
export interface EmbeddingConfig {
  enabled: boolean
  model: string
  apiBase?: string
  apiKey?: string
}

export interface VectorSearchResult {
  id: string
  score: number
  path?: string
}

export async function searchByEmbedding(
  _projectPath: string,
  _query: string,
  _config: EmbeddingConfig,
  _limit: number = 10,
): Promise<VectorSearchResult[]> {
  return []
}

export async function createEmbedding(
  _text: string,
  _config: EmbeddingConfig,
): Promise<number[]> {
  return []
}

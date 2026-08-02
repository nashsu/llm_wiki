// Search + knowledge graph — /api/v2/projects/:id/search, /graph

import { request } from "./client"

export interface SearchOptions {
  topK?: number
  includeContent?: boolean
}

export interface SearchResult {
  path: string
  score: number
  snippet?: string
  content?: string
}

export interface SearchResponse {
  results: SearchResult[]
  mode: string
  tokenHits: number
  vectorHits: number
  graphHits: number
}

export interface GraphOptions {
  q?: string
  nodeType?: string
  limit?: number
}

export interface GraphNode {
  id: string
  label: string
  nodeType: string
  path: string
  linkCount: number
  weight: number
}

export interface GraphEdge {
  source: string
  target: string
  weight: number
}

export interface GraphResponse {
  nodes: GraphNode[]
  edges: GraphEdge[]
}

/** POST /api/v2/projects/:id/search */
export function search(
  projectId: number,
  query: string,
  opts: SearchOptions = {},
): Promise<SearchResponse> {
  return request<SearchResponse>(`/api/v2/projects/${projectId}/search`, {
    method: "POST",
    json: {
      query,
      topK: opts.topK,
      includeContent: opts.includeContent,
    },
  })
}

/** GET /api/v2/projects/:id/graph */
export function getGraph(projectId: number, opts: GraphOptions = {}): Promise<GraphResponse> {
  return request<GraphResponse>(`/api/v2/projects/${projectId}/graph`, {
    query: { q: opts.q, nodeType: opts.nodeType, limit: opts.limit },
  })
}

// File operations — /api/v2/projects/:id/files/*

import { getBaseUrl, getToken, request, resolveUrl } from "./client"

/** A node in the directory tree returned by getTree. */
export interface FileTreeNode {
  name: string
  path: string
  type: "file" | "directory" | string
  size?: number
  children?: FileTreeNode[]
  [key: string]: unknown
}

export interface FileTreeResponse {
  tree: FileTreeNode[] | FileTreeNode
}

export interface FileContentResponse {
  content: string
}

export interface FileUploadResponse {
  path: string
  [key: string]: unknown
}

export interface TreeOptions {
  path?: string
  includeHidden?: boolean
  maxDepth?: number
}

/** GET /api/v2/projects/:id/files/tree */
export function getTree(projectId: number, path?: string, opts: Omit<TreeOptions, "path"> = {}): Promise<FileTreeResponse> {
  return request<FileTreeResponse>(`/api/v2/projects/${projectId}/files/tree`, {
    query: {
      path: path ?? "",
      includeHidden: opts.includeHidden,
      maxDepth: opts.maxDepth,
    },
  })
}

/** GET /api/v2/projects/:id/files/content?path= */
export function getContent(projectId: number, path: string): Promise<FileContentResponse> {
  return request<FileContentResponse>(`/api/v2/projects/${projectId}/files/content`, {
    query: { path },
  })
}

/** POST /api/v2/projects/:id/files/upload */
export function uploadFile(
  projectId: number,
  path: string,
  content: string,
  encoding: "utf-8" | "base64" = "utf-8",
): Promise<FileUploadResponse> {
  return request<FileUploadResponse>(`/api/v2/projects/${projectId}/files/upload`, {
    method: "POST",
    json: { path, content, encoding },
  })
}

/** GET /api/v2/projects/:id/files/download?path= — returns the raw bytes as a Blob. */
export async function downloadFile(projectId: number, path: string): Promise<Blob> {
  const res = await fetch(
    resolveUrl(`/api/v2/projects/${projectId}/files/download`, { path }),
    { headers: authHeaders() },
  )
  if (!res.ok) {
    throw new Error(`Download failed (${res.status})`)
  }
  return res.blob()
}

/** Build an absolute URL for GET /api/v2/projects/:id/files/raw?path= (e.g. for <img src>). */
export function getRawUrl(projectId: number, path: string): string {
  return resolveUrl(`/api/v2/projects/${projectId}/files/raw`, { path })
}

/** Headers carrying the Bearer token, for use with raw fetch (download/img). */
function authHeaders(): HeadersInit {
  const token = getToken()
  const headers: Record<string, string> = {}
  if (token) headers.Authorization = `Bearer ${token}`
  return headers
}

// Re-exported so callers can build their own authenticated URLs if needed.
export { getBaseUrl }

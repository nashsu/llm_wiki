import type { FileNode, WikiProject } from "@/types/wiki"
import { ensureProjectId, upsertProjectInfo } from "@/lib/project-identity"
import { isAbsolutePath } from "@/lib/path-utils"

const API_BASE = "http://127.0.0.1:19828"

/** Convert Windows backslashes to forward slashes. */
function normalizePath(p: string): string {
  return p.replace(/\\/g, "/")
}

/** Simple string hash fallback when MD5 is unavailable via the API. */
function simpleHash(s: string): string {
  let hash = 0
  for (let i = 0; i < s.length; i++) {
    const char = s.charCodeAt(i)
    hash = ((hash << 5) - hash) + char
    hash |= 0
  }
  return Math.abs(hash).toString(16).padStart(8, "0")
}

async function apiPost<T>(endpoint: string, body?: unknown): Promise<T> {
  const response = await fetch(`${API_BASE}${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  if (!response.ok) {
    throw new Error(
      JSON.stringify({
        status: response.status,
        detail: await response.text().catch(() => "unknown error"),
      }),
    )
  }
  return response.json() as Promise<T>
}

async function apiGet<T>(endpoint: string): Promise<T> {
  const response = await fetch(`${API_BASE}${endpoint}`)
  if (!response.ok) {
    throw new Error(
      JSON.stringify({
        status: response.status,
        detail: await response.text().catch(() => "unknown error"),
      }),
    )
  }
  return response.json() as Promise<T>
}

/** Raw shape returned by the project endpoints — id is attached client-side. */
interface RawProject {
  name: string
  path: string
}

export async function readFile(
  path: string,
  _options?: { extractImages?: boolean },
): Promise<string> {
  const { content } = await apiPost<{ content: string }>("/api/files/read", {
    path: normalizePath(path),
    encoding: "utf-8",
  })
  return content
}

export async function writeFile(path: string, contents: string): Promise<void> {
  assertAbsoluteFsPath("writeFile", path)
  await apiPost<void>("/api/files/write", { path: normalizePath(path), content: contents })
}

export async function writeFileBase64(path: string, base64: string): Promise<void> {
  assertAbsoluteFsPath("writeFileBase64", path)
  await apiPost<void>("/api/files/write", { path: normalizePath(path), content: base64 })
}

export async function writeFileAtomic(path: string, contents: string): Promise<void> {
  assertAbsoluteFsPath("writeFileAtomic", path)
  await apiPost<void>("/api/files/write", { path: normalizePath(path), content: contents })
}

/**
 * List a directory tree. Dot-prefixed entries (`.claude`, `.env`,
 * `.llm-wiki`, …) are hidden by default; pass `includeHidden: true`
 * only for the `raw/sources` content area, where dotfolders are
 * legitimate user-added sources. See `entry_is_visible` in fs.rs.
 */
export interface ListDirectoryOptions {
  includeHidden?: boolean
  maxDepth?: number
}

// In-flight dedupe only: entries are removed when the request settles. Each
// caller receives its own tree copy when a request is actually shared, so
// accidental in-place mutations do not leak across concurrent waiters.
interface PendingListDirectory {
  request: Promise<FileNode[]>
  shared: boolean
}

const pendingListDirectory = new Map<string, PendingListDirectory>()

function cloneFileNodes(nodes: FileNode[]): FileNode[] {
  return nodes.map((node) => ({
    ...node,
    children: node.children ? cloneFileNodes(node.children) : node.children,
  }))
}

export async function listDirectory(
  path: string,
  includeHiddenOrOptions: boolean | ListDirectoryOptions = false,
): Promise<FileNode[]> {
  const options =
    typeof includeHiddenOrOptions === "boolean"
      ? { includeHidden: includeHiddenOrOptions }
      : includeHiddenOrOptions
  const includeHidden = options.includeHidden ?? false
  const maxDepth = options.maxDepth
  const requestKey = JSON.stringify([path, includeHidden, maxDepth ?? null])
  const pending = pendingListDirectory.get(requestKey)
  if (pending) {
    pending.shared = true
    return pending.request.then(cloneFileNodes)
  }

  const request = apiPost<FileNode[]>("/api/files/list", { path: normalizePath(path) }).finally(
    () => {
      pendingListDirectory.delete(requestKey)
    },
  )
  const entry: PendingListDirectory = { request, shared: false }
  pendingListDirectory.set(requestKey, entry)
  return request.then((nodes) => (entry.shared ? cloneFileNodes(nodes) : nodes))
}

export async function copyFile(source: string, destination: string): Promise<void> {
  await apiPost<void>("/api/files/copy", {
    src: normalizePath(source),
    dst: normalizePath(destination),
  })
}

export async function copyDirectory(source: string, destination: string): Promise<string[]> {
  await apiPost<void>("/api/files/copy", {
    src: normalizePath(source),
    dst: normalizePath(destination),
  })
  return [destination]
}

export async function preprocessFile(path: string): Promise<string> {
  return path
}

export async function deleteFile(path: string): Promise<void> {
  await apiPost<void>("/api/files/delete", { path: normalizePath(path) })
}

export async function findRelatedWikiPages(
  _projectPath: string,
  _sourceName: string,
): Promise<string[]> {
  return []
}

export async function createDirectory(path: string): Promise<void> {
  assertAbsoluteFsPath("createDirectory", path)
  const gitkeepPath = `${normalizePath(path).replace(/\/$/, "")}/.gitkeep`
  await apiPost<void>("/api/files/write", { path: gitkeepPath, content: "" })
}

export async function fileExists(path: string): Promise<boolean> {
  const { exists } = await apiPost<{ exists: boolean }>("/api/files/exists", {
    path: normalizePath(path),
  })
  return exists
}

export async function getFileModifiedTime(path: string): Promise<number> {
  const { modified } = await apiPost<{ modified: number }>("/api/files/info", {
    path: normalizePath(path),
  })
  return modified
}

export async function getFileSize(path: string): Promise<number> {
  const { size } = await apiPost<{ size: number }>("/api/files/info", {
    path: normalizePath(path),
  })
  return size
}

export async function getFileMd5(path: string): Promise<string> {
  try {
    const info = await apiPost<{ md5?: string }>("/api/files/info", {
      path: normalizePath(path),
    })
    if (info.md5) return info.md5
  } catch {
    // fall through to simpleHash
  }
  return simpleHash(path)
}

function assertAbsoluteFsPath(operation: string, path: string): void {
  if (!isAbsolutePath(path)) {
    throw new Error(`${operation} requires an absolute path: ${path}`)
  }
}

/** Mirror of `commands::fs::FileBase64` (Rust side). */
export interface FileBase64 {
  base64: string
  mimeType: string
}

/**
 * Read any file off disk as base64 + a guessed mime type. The
 * vision-caption pipeline uses this to pick up extracted images
 * without having to read them as UTF-8 strings (PNG bytes aren't
 * valid UTF-8 — `readFile` would corrupt them).
 */
export async function readFileAsBase64(path: string): Promise<FileBase64> {
  const info = await apiPost<{ mime_type: string }>("/api/files/info", {
    path: normalizePath(path),
  })
  const { content } = await apiPost<{ content: string }>("/api/files/read", {
    path: normalizePath(path),
  })
  const base64 = btoa(unescape(encodeURIComponent(content)))
  return { base64, mimeType: info.mime_type }
}

export async function createProject(
  name: string,
  path: string,
): Promise<WikiProject> {
  const raw = await apiPost<RawProject>("/api/projects/create", {
    name,
    template_id: "general",
    path: normalizePath(path),
  })
  const id = await ensureProjectId(raw.path)
  await upsertProjectInfo(id, raw.path, raw.name)
  return { id, name: raw.name, path: raw.path }
}

export async function openProject(path: string): Promise<WikiProject> {
  const raw = await apiPost<RawProject>("/api/projects/open", {
    path: normalizePath(path),
  })
  const id = await ensureProjectId(raw.path)
  await upsertProjectInfo(id, raw.path, raw.name)
  return { id, name: raw.name, path: raw.path }
}

export async function openProjectFolder(_path: string): Promise<void> {
  // Native folder opening is not available in the browser/webview context
  // without Tauri's shell API.
}

export async function clipServerStatus(): Promise<string> {
  try {
    await apiGet("/health")
    return "running"
  } catch {
    return "stopped"
  }
}

export async function apiServerStatus(): Promise<string> {
  return "running"
}

export async function apiServerReloadConfig(): Promise<string> {
  return "ok"
}

export async function mcpServerEntryPath(): Promise<string> {
  // The MCP server entry path was previously resolved via Tauri's Rust backend.
  // In the Python-backed mode, this path is not available; callers should treat
  // an empty string as "not available".
  return ""
}

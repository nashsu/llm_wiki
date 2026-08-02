// Adapter layer — bridges the legacy invoke()-based API to the v2 REST API.
//
// Phase 3.2 migration path: each function here replaces one invoke() call site.
// The existing invoke() calls in the codebase go through the web shims
// (src/web/core.ts) which proxy to the legacy server. Over time, each call
// site should switch to these typed wrappers which talk directly to the v2
// REST API. During the transition, both paths work — uncommented rows have
// been migrated; commented stubs show the path for the next ones to convert.
//
// Usage from stores/commands (replace):
//   import { copyFile, deleteFile } from "@/api/adapter"
//   // then use copyFile(source, dest) instead of invoke("copy_file", ...)

import { request } from "@/api/client"

// ── Filesystem operations ────────────────────────────────────────────────
// src/commands/fs.ts currently calls invoke("copy_file") / invoke("delete_file").

/** POST /api/v2/projects/:id/files/copy */
export async function copyFile(
  projectId: number,
  source: string,
  destination: string,
): Promise<{ ok: boolean }> {
  return request(`/api/v2/projects/${projectId}/files/copy`, {
    method: "POST",
    json: { source, destination },
  })
}

/** DELETE /api/v2/projects/:id/files?path= */
export async function deleteFile(projectId: number, path: string): Promise<void> {
  return request(`/api/v2/projects/${projectId}/files`, {
    method: "DELETE",
    query: { path },
  })
}

// ── Vector operations ────────────────────────────────────────────────────
// src/lib/embedding.ts calls invoke("vector_upsert_chunks", ...) etc.
// These map to POST /api/v2/projects/:id/maintenance/reindex-vectors or
// equivalent v2 endpoints when the vector maintenance routes are finalised.

// ── CLI transport operations ─────────────────────────────────────────────
// src/lib/claude-cli-transport.ts and src/lib/codex-cli-transport.ts
// call invoke("claude_cli_spawn", ...) / invoke("claude_cli_kill", ...).
// These are migrated to api/chat.ts startChat/cancelChat where the v2
// chat endpoint bridges to the same local CLI binaries on the server.

// ── Maintenance ──────────────────────────────────────────────────────────
// src/components/settings/sections/maintenance-section.tsx calls
// invoke("export_project_archive", ...). Map to:
//   POST /api/v2/projects/:id/maintenance/export

/** POST /api/v2/projects/:id/maintenance/export */
export async function exportProjectArchive(
  projectId: number,
  destination: string,
): Promise<{ ok: boolean }> {
  return request(`/api/v2/projects/${projectId}/maintenance/export`, {
    method: "POST",
    json: { destination },
  })
}
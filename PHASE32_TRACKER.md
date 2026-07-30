# Phase 3.2: Replace invoke() calls with typed v2 API client

> **Related PR**: #1 · **Status**: pending (blocked on desktop build verification)

## Background

Phase 3 built a typed v2 API client (`src/api/`) for the new Express+Zod server, but the existing stores and commands still route most calls through `invoke()` + the Tauri web shims to the legacy server. This issue tracks the incremental migration of each call site.

## Remaining invoke() call sites

| File | Command | v2 API equivalent |
|---|---|---|
| `src/commands/fs.ts` | `copy_file` | `POST /api/v2/projects/:id/files/copy` |
| `src/commands/fs.ts` | `delete_file` | `DELETE /api/v2/projects/:id/files?path=` |
| `src/lib/embedding.ts` (8 calls) | `vector_*` | Search + maintenance endpoints |
| `src/lib/claude-cli-transport.ts` | `claude_cli_*` | `POST /api/v2/projects/:id/chat` |
| `src/lib/codex-cli-transport.ts` | `codex_cli_*` | `POST /api/v2/projects/:id/chat` |
| `src/components/chat/chat-panel.tsx` | `agent_cancel_turn` | `POST /api/v2/projects/:id/chat/:runId/cancel` |
| `src/components/settings/sections/maintenance-section.tsx` | `export_project_archive` | `POST /api/v2/projects/:id/maintenance/export` |
| `src/App.tsx` | `set_close_behavior` | Settings endpoint |

## Migration Adapter

A migration adapter exists at `src/api/adapter.ts` with typed wrappers for `copyFile`, `deleteFile`, and `exportProjectArchive`. Each remaining call site can adopt its adapter counterpart incrementally.

## Risk

These files are shared between the desktop (Tauri) and web (Vite) builds. Each replacement needs desktop build verification, but no Rust toolchain is available on the current host. Consider making replacements conditional on `globalThis.__LLM_WIKI_WEB__`, or adding a build-time feature flag.

## Acceptance Criteria

- [ ] All `invoke()` calls in shared code replaced with typed `api.*` calls
- [ ] Desktop build still compiles and works
- [ ] Web build passes all 9 gates
- [ ] `src/web/` shims can be removed after all call sites are migrated
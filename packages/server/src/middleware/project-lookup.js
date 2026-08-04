// Project lookup middleware for the v2 Express server.
//
// Every route under /api/v2/projects/:id shares the same preamble:
//   const projectId = parseInt(req.params.id, 10)
//   const root = resolveProjectRoot(projectId)
//   const project = getProject(projectId)
//   if (!project) throw new ApiError(...)
//
// This middleware runs the lookup once and attaches the results to the request
// object so route handlers can read req.projectId / req.projectRoot /
// req.project directly, cutting ~100 lines of duplicated preamble across the
// 8 route groups.
//
// The :id param accepts EITHER the integer projects-table id (v2 convention)
// OR the client's project UUID (WikiProject.id from .llm-wiki/project.json).
// The web client only knows the UUID, so resolution mirrors
// resolveChatProject in api/chat.js: numeric first, then getProjectByUuid,
// then the app-state projectRegistry fallback (registry → path). A
// registry-known project that never produced a row is materialized via
// ensureProjectRow — chat-route parity: ingest_queue rows FK-reference
// projects(id), so the queue needs a row to exist; without materialization
// a returning user's first upload 404s until they happen to use chat.

import { getProject, getProjectByUuid, ensureProjectRow } from "../store/projects.js"
import { resolveProjectRoot } from "../store/project-paths.js"
import { readStore } from "../store.js"
import { ApiError, ErrorCode } from "../errors.js"

/**
 * Resolve a projects row from a raw :id param (numeric id or client UUID).
 * Registry-known projects are materialized via ensureProjectRow (same shape
 * as resolveChatProject in api/chat.js, including uuid backfill on a
 * path-matched row). Returns undefined when nothing matches.
 */
export function resolveProjectByIdentity(rawId) {
  const raw = String(rawId ?? "").trim()
  if (!raw) return undefined
  if (/^\d+$/.test(raw)) {
    const project = getProject(Number.parseInt(raw, 10))
    if (project) return project
  }
  const byUuid = getProjectByUuid(raw)
  if (byUuid) return byUuid
  // Registry fallback: the client UUID may predate the projects row's uuid
  // backfill (rows created via POST /api/v2/projects carry no uuid). The
  // registry maps UUID → current filesystem path; a row for that path is the
  // same project — and when no row exists yet, ensureProjectRow creates it
  // (chat-route parity) so FK-dependent surfaces like the ingest queue work
  // for registry-only projects.
  const store = readStore("app-state.json")
  const reg = store.projectRegistry ?? {}
  const entry = reg[raw]
  const path = entry?.path
    ?? (store.lastProject?.id === raw ? store.lastProject?.path : null)
    ?? Object.values(reg).find((e) => e?.id === raw)?.path
  if (!path) return undefined
  return ensureProjectRow({ uuid: raw, path, name: entry?.name ?? null })
}

/**
 * Single-purpose Express middleware that resolves a project from
 * `req.params.id` and attaches the resolved values for downstream use.
 * When a route does NOT have a :id param (e.g. POST /projects lists),
 * pass `required: false` to skip with no error.
 */
export function projectLookup(opts = {}) {
  const { required = true } = opts
  return (req, _res, next) => {
    const raw = req.params.id
    if (!raw) {
      if (required) {
        return next(new ApiError(ErrorCode.VALIDATION_ERROR, "Missing project id"))
      }
      return next()
    }

    let project
    try {
      project = resolveProjectByIdentity(raw)
    } catch (err) {
      return next(err)
    }

    if (!project) {
      if (required) {
        return next(new ApiError(ErrorCode.NOT_FOUND, `Project ${raw} not found`))
      }
      return next()
    }

    const projectId = project.id
    // Throws NOT_FOUND when the project directory is missing — routes need a
    // real root to work against (same behavior as the pre-UUID middleware).
    req.projectId = projectId
    req.projectRoot = resolveProjectRoot(projectId)
    req.project = project
    next()
  }
}

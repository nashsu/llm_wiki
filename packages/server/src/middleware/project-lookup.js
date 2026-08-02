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

import { getProject } from "../store/projects.js"
import { resolveProjectRoot } from "../store/project-paths.js"
import { ApiError, ErrorCode } from "../errors.js"

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

    const projectId = parseInt(raw, 10)
    if (Number.isNaN(projectId)) {
      return next(new ApiError(ErrorCode.VALIDATION_ERROR, `Invalid project id: ${raw}`))
    }

    const project = getProject(projectId)
    if (!project && required) {
      return next(new ApiError(ErrorCode.NOT_FOUND, `Project ${projectId} not found`))
    }

    if (project) {
      try {
        resolveProjectRoot(projectId) // ensure directory exists on disk
      } catch {
        // non-fatal — project dir may be temporarily unmounted
      }
    }

    req.projectId = projectId
    req.projectRoot = project ? resolveProjectRoot(projectId) : undefined
    req.project = project ?? undefined
    next()
  }
}
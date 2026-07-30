// Project path resolution + containment guard for the v2 API.
//
// The v2 API addresses files by project-relative paths (e.g. "wiki/foo.md")
// under /api/v2/projects/:id/files. This module resolves a project id to its
// on-disk root (via the projects table) and safely joins relative paths into
// it, refusing any traversal that would escape the project directory. The
// containment logic mirrors api-v1.js safeJoin (which mirrors the desktop's
// is_public_project_rel / safe_join), so the security posture is identical.

import fs from "node:fs"
import path from "node:path"
import { getProject } from "./projects.js"
import { ApiError, ErrorCode } from "../errors.js"

/**
 * Resolve a project id to its on-disk root directory.
 * @param {number} id
 * @returns {string} absolute project root path
 */
export function resolveProjectRoot(id) {
  const project = getProject(id)
  if (!project) throw new ApiError(ErrorCode.NOT_FOUND, "Project not found")
  if (!fs.existsSync(project.path)) {
    throw new ApiError(ErrorCode.NOT_FOUND, `Project directory does not exist: ${project.path}`)
  }
  return project.path
}

/**
 * Safely join a project-relative path to the project root, refusing traversal.
 * @param {string} projectRoot absolute project root
 * @param {string} rel project-relative path (e.g. "wiki/foo.md")
 * @returns {string} absolute path within the project
 */
export function safeJoin(projectRoot, rel) {
  const r = String(rel || "").replace(/^\/+/, "")
  const rp = path.normalize(r)
  if (path.isAbsolute(rp) || rp.split(path.sep).some((c) => c === "..")) {
    throw new ApiError(ErrorCode.FORBIDDEN, "Path traversal is not allowed")
  }
  const joined = path.join(projectRoot, rp)
  const rootCanon = fs.realpathSync(projectRoot)
  if (fs.existsSync(joined)) {
    const jc = fs.realpathSync(joined)
    if (jc !== rootCanon && !jc.startsWith(rootCanon + path.sep)) {
      throw new ApiError(ErrorCode.FORBIDDEN, "Resolved path escapes the project directory")
    }
    return jc
  }
  const parent = path.dirname(joined)
  if (fs.existsSync(parent)) {
    const pc = fs.realpathSync(parent)
    if (pc !== rootCanon && !pc.startsWith(rootCanon + path.sep)) {
      throw new ApiError(ErrorCode.FORBIDDEN, "Resolved parent escapes the project directory")
    }
  }
  return joined
}

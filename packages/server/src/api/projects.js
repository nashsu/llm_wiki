// Express router for the projects API (Phase 2.3).
//
// CRUD over the projects table, validated by Zod schemas. Demonstrates the
// route-group pattern: schema → validate middleware → store call → JSON.
// Errors thrown as ApiError are normalized by the global error handler.

import { Router } from "express"
import fs from "node:fs"
import path from "node:path"
import { validate } from "../middleware/validate.js"
import {
  CreateProjectSchema,
  UpdateProjectSchema,
  ProjectIdParamSchema,
} from "@llm-wiki/api-types"
import * as store from "../store/projects.js"
import { scaffoldWikiProject } from "../commands/project.js"
import { vectorCommands } from "../commands/vectorstore.js"
import { ApiError, ErrorCode } from "../errors.js"

const router = Router()

// GET /api/v2/projects — list all
router.get("/", (req, res) => {
  res.json({ projects: store.listProjects() })
})

// GET /api/v2/projects/:id — read one
router.get("/:id", validate({ params: ProjectIdParamSchema }), (req, res) => {
  const project = store.getProject(req.validated.params.id)
  if (!project) throw new ApiError(ErrorCode.NOT_FOUND, "Project not found")
  res.json({ project })
})

// POST /api/v2/projects — create
//
// Unlike the legacy `create_project` command (where `path` is the *parent* and
// the project dir is join(path,name)), the v2 contract stores `path` as the
// project ROOT itself (see store/project-paths.js resolveProjectRoot). We
// scaffold the wiki tree at that root so the project is immediately usable;
// without this the row would point at a non-existent (or empty) dir and every
// subsequent lookup would fail validation (issue #2).
//
// Clobber guard: refuse only when the target is ALREADY a wiki project
// (schema.md is the app's canonical marker — see validateWikiProjectRoot), so
// re-creating over an existing project can't overwrite its seed files. A
// populated folder that isn't yet a wiki project may still be adopted: the
// scaffold adds the tree alongside the existing content.
router.post("/", validate({ body: CreateProjectSchema }), (req, res) => {
  const { name, path: root } = req.validated.body
  if (fs.existsSync(path.join(root, "schema.md"))) {
    throw new ApiError(ErrorCode.CONFLICT, `A wiki project already exists at: '${root}'`)
  }
  const project = store.createProject({ name, path: root })
  try {
    scaffoldWikiProject(root)
  } catch (err) {
    // Roll back the DB row so we never leave a project pointing at a
    // half-scaffolded / missing directory.
    try { store.deleteProject(project.id) } catch { /* best effort */ }
    throw new ApiError(
      ErrorCode.INTERNAL_ERROR,
      `Failed to scaffold project directory: ${err && err.message ? err.message : err}`,
    )
  }
  res.status(201).json({ project })
})

// PATCH /api/v2/projects/:id — update
router.patch(
  "/:id",
  validate({ params: ProjectIdParamSchema, body: UpdateProjectSchema }),
  (req, res) => {
    const { id } = req.validated.params
    if (!store.getProject(id)) throw new ApiError(ErrorCode.NOT_FOUND, "Project not found")
    const project = store.updateProject(id, req.validated.body)
    res.json({ project })
  }
)

// DELETE /api/v2/projects/:id — delete
//
// Best-effort cleanup of the shared vec_chunks table (rows are keyed by the
// project UUID, or the path fallback for rows written before project.json
// existed) so a deleted project does not leave orphaned embeddings behind.
// Cleanup must never fail the delete itself.
router.delete("/:id", validate({ params: ProjectIdParamSchema }), async (req, res) => {
  const { id } = req.validated.params
  const project = store.getProject(id)
  if (!project) throw new ApiError(ErrorCode.NOT_FOUND, "Project not found")
  try {
    await vectorCommands.vector_delete_project({ projectPath: project.path, projectUuid: project.uuid })
  } catch { /* best-effort vector cleanup */ }
  store.deleteProject(id)
  res.status(204).end()
})

export { router as projectsRouter }

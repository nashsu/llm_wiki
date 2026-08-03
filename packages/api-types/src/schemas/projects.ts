// Zod schemas for the projects API (Phase 2.3).

import { z } from "zod"

export const CreateProjectSchema = z.object({
  name: z.string().min(1).max(255),
  path: z.string().min(1),
})

export const UpdateProjectSchema = z.object({
  name: z.string().min(1).max(255).optional(),
})

export const ProjectIdParamSchema = z.object({
  id: z.coerce.number().int().positive(),
})

export const ProjectSchema = z.object({
  id: z.number(),
  name: z.string(),
  path: z.string(),
  owner_id: z.number().nullable(),
  created_at: z.number(),
  updated_at: z.number(),
})

export type CreateProject = z.infer<typeof CreateProjectSchema>
export type UpdateProject = z.infer<typeof UpdateProjectSchema>
export type ProjectIdParam = z.infer<typeof ProjectIdParamSchema>
export type Project = z.infer<typeof ProjectSchema>

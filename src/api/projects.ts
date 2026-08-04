// Project CRUD — /api/v2/projects

import { request } from "./client"

export interface Project {
  id: number
  /** Client UUID backfill (migration 011); null until a UUID lookup binds it. */
  uuid: string | null
  name: string
  path: string
  owner_id: number | null
  created_at: number
  updated_at: number
}

/** GET /api/v2/projects */
export function listProjects(): Promise<{ projects: Project[] }> {
  return request<{ projects: Project[] }>("/api/v2/projects")
}

/** GET /api/v2/projects/:id */
export function getProject(id: number): Promise<Project> {
  return request<Project>(`/api/v2/projects/${id}`)
}

/** POST /api/v2/projects */
export function createProject(name: string, path: string): Promise<Project> {
  return request<Project>("/api/v2/projects", {
    method: "POST",
    json: { name, path },
  })
}

/** PATCH /api/v2/projects/:id */
export function updateProject(id: number, name: string): Promise<Project> {
  return request<Project>(`/api/v2/projects/${id}`, {
    method: "PATCH",
    json: { name },
  })
}

/** DELETE /api/v2/projects/:id */
export function deleteProject(id: number): Promise<void> {
  return request<void>(`/api/v2/projects/${id}`, { method: "DELETE" })
}

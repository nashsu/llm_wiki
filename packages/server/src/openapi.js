// OpenAPI 3.1 spec generation from Zod schemas (Phase 2.5).
//
// Uses @asteasolutions/zod-to-openapi to turn the Zod schemas (the API's source
// of truth, decision #8 / issue #20 — they live in @llm-wiki/api-types) into
// an OpenAPI document, served at /api/v2/openapi.json. Adding a route group =
// registering its schemas + paths here; the spec stays in sync with validation
// automatically.

import {
  z,
  OpenAPIRegistry,
  OpenApiGeneratorV31,
  CreateProjectSchema,
  UpdateProjectSchema,
  ProjectIdParamSchema,
  ProjectSchema,
  ErrorEnvelopeSchema,
} from "@llm-wiki/api-types"

const registry = new OpenAPIRegistry()

// ── register component schemas ────────────────────────────────────────────
const ProjectRef = registry.register("Project", ProjectSchema)
registry.register("CreateProject", CreateProjectSchema)
registry.register("UpdateProject", UpdateProjectSchema)
registry.register("Error", ErrorEnvelopeSchema)

// ── register paths ────────────────────────────────────────────────────────
registry.registerPath({
  method: "get",
  path: "/api/v2/projects",
  summary: "List all projects",
  responses: {
    200: {
      description: "Project list",
      content: { "application/json": { schema: z.object({ projects: z.array(ProjectRef) }) } },
    },
  },
})

registry.registerPath({
  method: "get",
  path: "/api/v2/projects/{id}",
  summary: "Get one project",
  request: { params: ProjectIdParamSchema },
  responses: {
    200: {
      description: "The project",
      content: { "application/json": { schema: z.object({ project: ProjectRef }) } },
    },
    404: { description: "Project not found" },
  },
})

registry.registerPath({
  method: "post",
  path: "/api/v2/projects",
  summary: "Create a project",
  request: { body: { content: { "application/json": { schema: CreateProjectSchema } } } },
  responses: {
    201: {
      description: "Created project",
      content: { "application/json": { schema: z.object({ project: ProjectRef }) } },
    },
    400: { description: "Validation error" },
  },
})

registry.registerPath({
  method: "patch",
  path: "/api/v2/projects/{id}",
  summary: "Update a project",
  request: { params: ProjectIdParamSchema, body: { content: { "application/json": { schema: UpdateProjectSchema } } } },
  responses: {
    200: {
      description: "Updated project",
      content: { "application/json": { schema: z.object({ project: ProjectRef }) } },
    },
    404: { description: "Project not found" },
  },
})

registry.registerPath({
  method: "delete",
  path: "/api/v2/projects/{id}",
  summary: "Delete a project",
  request: { params: ProjectIdParamSchema },
  responses: {
    204: { description: "Deleted" },
    404: { description: "Project not found" },
  },
})

/** Generate the OpenAPI 3.1 document. */
export function generateOpenApiDocument() {
  const generator = new OpenApiGeneratorV31(registry.definitions)
  return generator.generateDocument({
    openapi: "3.1.0",
    info: {
      title: "LLM Wiki API",
      version: "0.6.6",
      description: "Client-server REST API for LLM Wiki (v2, Express + Zod).",
    },
    servers: [{ url: "/" }],
  })
}

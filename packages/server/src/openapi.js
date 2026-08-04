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
  ChatSessionSchema,
  ChatMessageSchema,
  ChatSessionParamsSchema,
  ChatCreateSessionBodySchema,
  ChatRenameSessionBodySchema,
  ChunkedUploadInitBodySchema,
  ChunkedUploadInitResponseSchema,
  ChunkedUploadChunkQuerySchema,
  ChunkedUploadChunkResponseSchema,
  ChunkedUploadCompleteResponseSchema,
} from "@llm-wiki/api-types"

const registry = new OpenAPIRegistry()

// ── register component schemas ────────────────────────────────────────────
const ProjectRef = registry.register("Project", ProjectSchema)
registry.register("CreateProject", CreateProjectSchema)
registry.register("UpdateProject", UpdateProjectSchema)
registry.register("Error", ErrorEnvelopeSchema)
const ChatSessionRef = registry.register("ChatSession", ChatSessionSchema)
const ChatMessageRef = registry.register("ChatMessage", ChatMessageSchema)
const ChunkedUploadInitRef = registry.register("ChunkedUploadInit", ChunkedUploadInitBodySchema)
const ChunkedUploadInitResponseRef = registry.register("ChunkedUploadInitResponse", ChunkedUploadInitResponseSchema)
const ChunkedUploadChunkResponseRef = registry.register("ChunkedUploadChunkResponse", ChunkedUploadChunkResponseSchema)
const ChunkedUploadCompleteResponseRef = registry.register("ChunkedUploadCompleteResponse", ChunkedUploadCompleteResponseSchema)

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

// ── chat session paths (issue #21) ────────────────────────────────────────
// The {id} segment on chat routes accepts either the integer projects-table
// id or the client project UUID, so it is described inline rather than with
// ProjectIdParamSchema (which coerces to a positive integer).
const chatProjectIdParam = z.object({ id: z.string().min(1) })

registry.registerPath({
  method: "get",
  path: "/api/v2/projects/{id}/chat/sessions",
  summary: "List chat sessions for a project (most recently updated first)",
  request: { params: chatProjectIdParam },
  responses: {
    200: {
      description: "Session list",
      content: { "application/json": { schema: z.object({ sessions: z.array(ChatSessionRef) }) } },
    },
    404: { description: "Project not found" },
  },
})

registry.registerPath({
  method: "post",
  path: "/api/v2/projects/{id}/chat/sessions",
  summary: "Create an empty chat session",
  request: {
    params: chatProjectIdParam,
    body: { content: { "application/json": { schema: ChatCreateSessionBodySchema } } },
  },
  responses: {
    201: {
      description: "Created session",
      content: { "application/json": { schema: z.object({ session: ChatSessionRef }) } },
    },
    404: { description: "Project not found" },
  },
})

registry.registerPath({
  method: "get",
  path: "/api/v2/projects/{id}/chat/sessions/{sessionId}",
  summary: "Get one chat session with its persisted messages",
  request: { params: chatProjectIdParam.extend({ sessionId: ChatSessionParamsSchema.shape.sessionId }) },
  responses: {
    200: {
      description: "The session and its messages",
      content: {
        "application/json": {
          schema: z.object({ session: ChatSessionRef, messages: z.array(ChatMessageRef) }),
        },
      },
    },
    404: { description: "Project or session not found" },
  },
})

registry.registerPath({
  method: "patch",
  path: "/api/v2/projects/{id}/chat/sessions/{sessionId}",
  summary: "Rename a chat session",
  request: {
    params: chatProjectIdParam.extend({ sessionId: ChatSessionParamsSchema.shape.sessionId }),
    body: { content: { "application/json": { schema: ChatRenameSessionBodySchema } } },
  },
  responses: {
    200: {
      description: "Renamed session",
      content: { "application/json": { schema: z.object({ session: ChatSessionRef }) } },
    },
    404: { description: "Project or session not found" },
  },
})

registry.registerPath({
  method: "delete",
  path: "/api/v2/projects/{id}/chat/sessions/{sessionId}",
  summary: "Delete a chat session (messages cascade)",
  request: { params: chatProjectIdParam.extend({ sessionId: ChatSessionParamsSchema.shape.sessionId }) },
  responses: {
    204: { description: "Deleted" },
    404: { description: "Project or session not found" },
  },
})

// ── chunked upload paths (issue #14 P2, Decision 15) ─────────────────────
// Large files (>10MB) take the charter's chunked protocol: init → chunk PUTs
// → complete. The {id} segment accepts either the integer projects-table id
// or the client project UUID, so it is described inline rather than with
// ProjectIdParamSchema (same rationale as the chat routes above).
const chunkedUploadIdParam = z.object({ uploadId: z.string().min(1) })

registry.registerPath({
  method: "post",
  path: "/api/v2/projects/{id}/files/upload/init",
  summary: "Open a chunked-upload session (large files, issue #14 P2)",
  request: {
    params: chatProjectIdParam,
    body: { content: { "application/json": { schema: ChunkedUploadInitRef } } },
  },
  responses: {
    201: {
      description: "Session opened",
      content: { "application/json": { schema: ChunkedUploadInitResponseRef } },
    },
    400: { description: "Validation error" },
    404: { description: "Project not found" },
    413: { description: "fileSize exceeds the upload cap" },
  },
})

registry.registerPath({
  method: "put",
  path: "/api/v2/projects/{id}/files/upload/{uploadId}/chunk",
  summary: "Append one octet-stream chunk (offset must equal server byte count)",
  request: {
    params: chatProjectIdParam.extend(chunkedUploadIdParam.shape),
    query: ChunkedUploadChunkQuerySchema,
    body: { content: { "application/octet-stream": { schema: z.string() } } },
  },
  responses: {
    200: {
      description: "Chunk appended; received = total bytes stored so far",
      content: { "application/json": { schema: ChunkedUploadChunkResponseRef } },
    },
    400: {
      description:
        "Offset mismatch (details.received carries the resume point) or chunk overflow",
    },
    404: { description: "Upload session not found, expired, or other project" },
  },
})

registry.registerPath({
  method: "post",
  path: "/api/v2/projects/{id}/files/upload/{uploadId}/complete",
  summary: "Finalize the upload: staging → destPath, emits file:created/modified",
  request: {
    params: chatProjectIdParam.extend(chunkedUploadIdParam.shape),
  },
  responses: {
    200: {
      description: "File written into the project",
      content: { "application/json": { schema: ChunkedUploadCompleteResponseRef } },
    },
    400: { description: "Upload incomplete (received < fileSize)" },
    403: { description: "destPath escapes the project directory" },
    404: { description: "Upload session not found, expired, or other project" },
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

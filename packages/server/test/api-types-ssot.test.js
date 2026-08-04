// Issue #20 — api-types schema package SSOT.
//
// These guards are intentionally RED on origin/main: today the runtime Zod
// schemas live in packages/server/src/schemas/*.js (plain JS, no types) and
// packages/api-types hand-mirrors only the error enum ("keep in sync" —
// exactly the drift the chartered pipeline was supposed to eliminate).
//
// After the migration:
//   1. No schema definitions remain in packages/server.
//   2. Every runtime schema is exported by @llm-wiki/api-types (built JS),
//      which the server imports for validation and the client imports for
//      z.infer types — one source of truth, zero drift by construction.
//   3. The server's ErrorCode object is DERIVED from the package's
//      ERROR_CODES, not hand-mirrored.

import { describe, it, expect } from "vitest"
import { existsSync } from "node:fs"
import path from "node:path"

// The full export surface of the 11 former packages/server/src/schemas/*.js
// modules (45 named exports), grouped by origin file.
const EXPECTED_SCHEMA_EXPORTS = [
  // common.js
  "DynamicValue",
  "ErrorEnvelopeSchema",
  "PaginationQuerySchema",
  "PaginatedMetaSchema",
  "HealthResponseSchema",
  "VersionResponseSchema",
  // auth.js
  "LoginRequestSchema",
  "LoginResponseSchema",
  // projects.js
  "CreateProjectSchema",
  "UpdateProjectSchema",
  "ProjectIdParamSchema",
  "ProjectSchema",
  // files.js
  "FileTreeQuerySchema",
  "FileContentQuerySchema",
  "FileUploadBodySchema",
  "FileDownloadQuerySchema",
  "FileRawQuerySchema",
  // chat.js
  "ChatRequestSchema",
  "ChatStartResponseSchema",
  "ChatCancelParamsSchema",
  "ChatSessionParamsSchema",
  // graph.js
  "GraphQuerySchema",
  "GraphNodeSchema",
  "GraphEdgeSchema",
  "GraphResponseSchema",
  // ingest.js
  "IngestQueueQuerySchema",
  "IngestTaskIdParamSchema",
  "IngestClearBodySchema",
  "IngestTaskSchema",
  "IngestQueueResponseSchema",
  "IngestUploadResponseSchema",
  "IngestEnqueueBodySchema",
  "IngestEnqueueResponseSchema",
  // maintenance.js
  "RebuildIndexResponseSchema",
  "ExportBodySchema",
  "ImportBodySchema",
  "FileHistoryQuerySchema",
  "RestoreHistoryBodySchema",
  // reviews.js
  "ReviewQuerySchema",
  "ReviewItemSchema",
  "ReviewListResponseSchema",
  // search.js
  "SearchRequestSchema",
  "SearchResponseSchema",
  "SearchResultSchema",
  // settings.js
  "SettingKeyParamSchema",
  "SettingWriteBodySchema",
  "SettingWriteManyBodySchema",
]

describe("issue #20 — schema SSOT", () => {
  it("no local schemas directory remains in packages/server", () => {
    expect(existsSync(path.resolve("src/schemas"))).toBe(false)
  })

  it("@llm-wiki/api-types exports all 47 runtime schemas (built package)", async () => {
    expect(EXPECTED_SCHEMA_EXPORTS).toHaveLength(47)
    const pkg = await import("@llm-wiki/api-types")
    for (const name of EXPECTED_SCHEMA_EXPORTS) {
      expect(pkg[name], `missing export: ${name}`).toBeDefined()
    }
  })

  it("server ErrorCode is derived from the package ERROR_CODES", async () => {
    const { ERROR_CODES } = await import("@llm-wiki/api-types")
    const { ErrorCode } = await import("../src/errors.js")
    expect([...Object.values(ErrorCode)].sort()).toEqual(
      [...Object.values(ERROR_CODES)].sort(),
    )
  })
})

// Zod OpenAPI wiring for the schema package (issue #20).
//
// `@asteasolutions/zod-to-openapi`'s OpenAPIRegistry calls `schema.openapi(...)`
// when registering schemas, so Zod must be extended BEFORE any schema built by
// this package is handed to a registry. Importing this module first (index.ts
// does) guarantees the extension regardless of consumer import order.
//
// The extension only adds the `.openapi()` metadata helper; it does not change
// validation semantics, so runtime validation on the server is unaffected.
import { z } from "zod"
import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi"

extendZodWithOpenApi(z)

export { z }

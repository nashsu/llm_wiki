// Zod setup: extend with OpenAPI methods (must run before any schemas are created).
import { z } from "zod"
import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi"

extendZodWithOpenApi(z)

export { z }

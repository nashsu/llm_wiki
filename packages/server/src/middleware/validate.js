// Zod validation middleware for the v2 Express server.
//
// Validates request body/params/query against Zod schemas and attaches the
// parsed (typed) result to req.validated. Throws ZodError on failure, which
// the error handler normalizes to VALIDATION_ERROR with the issue array.

// (ZodError is not imported here: this middleware just forwards whatever the
// schema throws via next(err); error.js does the instanceof ZodError check.
// Schema types below resolve to @llm-wiki/api-types' single zod instance.)

/**
 * @param {object} schemas
 * @param {import("@llm-wiki/api-types").ZodSchema} [schemas.body]
 * @param {import("@llm-wiki/api-types").ZodSchema} [schemas.params]
 * @param {import("@llm-wiki/api-types").ZodSchema} [schemas.query]
 */
export function validate(schemas) {
  return (req, res, next) => {
    const validated = {}
    try {
      if (schemas.body) validated.body = schemas.body.parse(req.body)
      if (schemas.params) validated.params = schemas.params.parse(req.params)
      if (schemas.query) validated.query = schemas.query.parse(req.query)
      req.validated = validated
      next()
    } catch (err) {
      next(err)
    }
  }
}

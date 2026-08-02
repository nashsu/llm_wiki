// Zod validation middleware for the v2 Express server.
//
// Validates request body/params/query against Zod schemas and attaches the
// parsed (typed) result to req.validated. Throws ZodError on failure, which
// the error handler normalizes to VALIDATION_ERROR with the issue array.

import { ZodError } from "zod"

/**
 * @param {object} schemas
 * @param {import("zod").ZodSchema} [schemas.body]
 * @param {import("zod").ZodSchema} [schemas.params]
 * @param {import("zod").ZodSchema} [schemas.query]
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

// Auth middleware for the v2 Express server.
//
// Enforces the token contract from auth/config.js on all routes except the
// public ones (health, version). Throws UNAUTHORIZED on failure.

import { isAuthorized } from "../auth/config.js"
import { ApiError, ErrorCode } from "../errors.js"

const PUBLIC_PATHS = new Set([
  "/api/v2/health",
  "/api/v2/version",
  "/api/v2/auth/login",
  "/api/v2/auth/status",
])

export function authMiddleware(req, res, next) {
  if (PUBLIC_PATHS.has(req.path)) {
    return next()
  }
  // The web client (SPA HTML + static assets) lives outside /api/* and must be
  // served unauthenticated so the client-side LoginScreen can render in token
  // mode. The actual data API is entirely under /api/*, which stays gated.
  if (!req.path.startsWith("/api/")) {
    return next()
  }
  if (!isAuthorized(req)) {
    return next(new ApiError(ErrorCode.UNAUTHORIZED, "Authentication required"))
  }
  next()
}

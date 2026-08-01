// Auth configuration + verification for the v2 Express server (decision #14).
//
// Mirrors the desktop's external-API auth contract (api_server.rs) so a token
// set in the desktop's Settings (shared store `apiConfig.token`) or the
// LLM_WIKI_API_TOKEN env var is enforced identically here. Accepted via
// `?token=`, header `x-llm-wiki-token`, or `Authorization: Bearer <token>`.
//
// Auth mode (GOAL.md §14):
//   AUTH_MODE=none   → server is always open (no auth required)
//   AUTH_MODE=token  → token required on all non-public routes
//   unset/empty      → heuristic: open when no token configured, required when
//                       a token is set (backward-compatible default)
//
// When AUTH_MODE=token but no token is configured (env or store), the server
// is effectively closed — every non-public route returns 401.

import { constantTimeEq } from "../lib/crypto-utils.js"
import { readStore } from "../store.js"
import { SHARED_STORE_NAME } from "../config.js"

/** Read the explicit auth mode from AUTH_MODE env var. */
function getAuthMode() {
  const raw = (process.env.AUTH_MODE || "").trim().toLowerCase()
  if (raw === "none") return "none"
  if (raw === "token") return "token"
  return "auto"
}

/** Resolve the effective auth config from env + the shared store. */
export function resolveAuth() {
  const store = readStore(SHARED_STORE_NAME)
  const envT = (process.env.LLM_WIKI_API_TOKEN || "").trim()
  const cfg = (store && store.apiConfig) || {}
  const storeT = typeof cfg.token === "string" ? cfg.token.trim() : ""
  const token = envT || storeT
  const source = envT ? "env" : storeT ? "store" : "none"
  const allowUnauth = cfg.allowUnauthenticated === true
  const mode = getAuthMode()
  const authRequired =
    mode === "token"
      ? true // explicitly required regardless of allowUnauth
      : mode === "none"
        ? false // explicitly open
        : !!token && !allowUnauth // auto: require only when a token is configured
  const authConfigured = !!token || mode === "token"
  return { token, source, mode, allowUnauth, authRequired, authConfigured }
}

/**
 * Check whether an incoming request is authorized.
 *
 * Auth model (decision #14):
 *   AUTH_MODE=none  → always open (zero-friction local mode)
 *   AUTH_MODE=token → token required on every non-public route
 *   unset/empty     → open when no token is configured, required when a token
 *                      is set (heuristic: backward-compatible default)
 * @param {import("express").Request} req
 * @returns {boolean}
 */
export function isAuthorized(req) {
  const a = resolveAuth()
  if (!a.authRequired) return true // AUTH_MODE=none or open heuristic
  if (!a.token) return false // AUTH_MODE=token but nothing to validate against
  if (a.allowUnauth && a.mode !== "token") return true // explicitly re-opened in heuristic mode
  const qtok = req.query.token
  if (typeof qtok === "string" && constantTimeEq(qtok, a.token)) return true
  const x = req.headers["x-llm-wiki-token"]
  if (typeof x === "string" && constantTimeEq(x, a.token)) return true
  const auth = req.headers["authorization"]
  if (typeof auth === "string" && auth.startsWith("Bearer ") && constantTimeEq(auth.slice(7), a.token)) return true
  return false
}

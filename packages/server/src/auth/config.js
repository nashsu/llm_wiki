// Auth configuration + verification for the v2 Express server (decision #14).
//
// Mirrors the desktop's external-API auth contract (api_server.rs) so a token
// set in the desktop's Settings (shared store `apiConfig.token`) or the
// LLM_WIKI_API_TOKEN env var is enforced identically here. Accepted via
// `?token=`, header `x-llm-wiki-token`, or `Authorization: Bearer <token>`.
//
// Auth mode (GOAL.md §14, chartered name per V1_CHARTERED_ARCHITECTURE.md §4.5):
//   LLM_WIKI_AUTH_MODE=none   → server is always open (no auth required)
//   LLM_WIKI_AUTH_MODE=token  → token required on all non-public routes
//   unset/empty               → heuristic ("auto"): open when no token
//                                configured, required when a token is set
//                                (backward-compatible default)
//   "open" is accepted as a synonym of "none" (docker-compose default).
//
// AUTH_MODE is a DEPRECATED alias: it still works when LLM_WIKI_AUTH_MODE is
// unset, and the primary wins when both are set. Using the alias logs a
// warn-once deprecation notice.
//
// When the mode is token but no token is configured (env or store), the
// server is effectively closed — every non-public route returns 401.

import { constantTimeEq } from "../lib/crypto-utils.js"
import { readStore } from "../store.js"
import { SHARED_STORE_NAME } from "../config.js"

/** Warn once per process when the deprecated AUTH_MODE alias is set. */
let aliasWarned = false
function warnAliasOnce() {
  if (aliasWarned) return
  aliasWarned = true
  console.warn(
    "[auth] AUTH_MODE is deprecated and will be removed in a future release; " +
      "use LLM_WIKI_AUTH_MODE instead (values: none|token). " +
      "When both are set, LLM_WIKI_AUTH_MODE wins.",
  )
}

function parseModeValue(raw) {
  const v = (raw || "").trim().toLowerCase()
  if (v === "none" || v === "open") return "none" // "open": compose-default compat
  if (v === "token") return "token"
  if (v === "") return null // unset → caller decides (alias fallback / auto)
  return "auto" // explicitly set but unrecognized → heuristic
}

/**
 * Read the auth mode: LLM_WIKI_AUTH_MODE (chartered primary) first,
 * AUTH_MODE as deprecated alias. Warns once when the alias is set.
 */
function getAuthMode() {
  if ((process.env.AUTH_MODE || "").trim()) warnAliasOnce()
  const primary = parseModeValue(process.env.LLM_WIKI_AUTH_MODE)
  if (primary !== null) return primary
  const legacy = parseModeValue(process.env.AUTH_MODE)
  if (legacy !== null) return legacy
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
 * Auth model (decision #14; chartered env var per §4.5):
 *   LLM_WIKI_AUTH_MODE=none  → always open (zero-friction local mode)
 *   LLM_WIKI_AUTH_MODE=token → token required on every non-public route
 *   unset/empty (auto)       → open when no token is configured, required
 *                              when a token is set (backward-compatible)
 *   AUTH_MODE is honored as a deprecated alias (see header).
 * @param {import("express").Request} req
 * @returns {boolean}
 */
export function isAuthorized(req) {
  const a = resolveAuth()
  if (!a.authRequired) return true // mode none/open or open heuristic
  if (!a.token) return false // mode token but nothing to validate against
  if (a.allowUnauth && a.mode !== "token") return true // explicitly re-opened in heuristic mode
  const qtok = req.query.token
  if (typeof qtok === "string" && constantTimeEq(qtok, a.token)) return true
  const x = req.headers["x-llm-wiki-token"]
  if (typeof x === "string" && constantTimeEq(x, a.token)) return true
  const auth = req.headers["authorization"]
  if (typeof auth === "string" && auth.startsWith("Bearer ") && constantTimeEq(auth.slice(7), a.token)) return true
  return false
}

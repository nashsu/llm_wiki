// Auth configuration + verification for the v2 Express server (decision #14).
//
// Mirrors the desktop's external-API auth contract (api_server.rs) so a token
// set in the desktop's Settings (shared store `apiConfig.token`) or the
// LLM_WIKI_API_TOKEN env var is enforced identically here. Accepted via
// `?token=`, header `x-llm-wiki-token`, or `Authorization: Bearer <token>`.
//
// No auth by default: when no token is configured and allowUnauthenticated is
// not explicitly false, requests pass through (zero-friction local mode).

import crypto from "node:crypto"
import { readStore } from "../store.js"
import { SHARED_STORE_NAME } from "../config.js"

function constantTimeEq(a, b) {
  const A = Buffer.from(String(a))
  const B = Buffer.from(String(b))
  if (A.length !== B.length) return false
  let d = 0
  for (let i = 0; i < A.length; i++) d |= A[i] ^ B[i]
  return d === 0
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
  return {
    token,
    source,
    allowUnauth,
    authRequired: !allowUnauth,
    authConfigured: !!token,
  }
}

/**
 * Check whether an incoming request is authorized.
 *
 * "No auth by default" (decision #14): when no token is configured the server
 * is open (zero-friction local mode). A token only becomes required once one is
 * actually set (env or shared store), unless allowUnauthenticated re-opens it.
 * @param {import("express").Request} req
 * @returns {boolean}
 */
export function isAuthorized(req) {
  const a = resolveAuth()
  if (!a.authConfigured) return true // no token set → open
  if (a.allowUnauth) return true // explicitly opened despite a token
  const qtok = req.query.token
  if (typeof qtok === "string" && constantTimeEq(qtok, a.token)) return true
  const x = req.headers["x-llm-wiki-token"]
  if (typeof x === "string" && constantTimeEq(x, a.token)) return true
  const auth = req.headers["authorization"]
  if (typeof auth === "string" && auth.startsWith("Bearer ") && constantTimeEq(auth.slice(7), a.token)) return true
  return false
}

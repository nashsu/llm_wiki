// Connection helpers for the LLM Wiki web client.
//
// Thin layer over the API client's token store (localStorage) and the
// /api/v2/auth/status endpoint, so the login flow and any future
// reconnect logic share one definition of "are we connected?".

import { getAuthStatus, type AuthStatus } from "@/api/auth"
import {
  getBaseUrl,
  getToken,
  setToken as persistToken,
  TOKEN_STORAGE_KEY,
} from "@/api/client"

export { TOKEN_STORAGE_KEY }

export interface ConnectionState {
  /** A token is present in localStorage (not yet validated). */
  hasToken: boolean
  /** The server says no login is required (auth disabled / open access). */
  authRequired: boolean
  /** A token has been configured server-side. */
  authConfigured: boolean
  /** The client can proceed to the app without logging in. */
  connected: boolean
}

/**
 * Snapshot of the current connection: reads the stored token, then asks
 * the server whether auth is enforced. When the server is unreachable the
 * promise rejects — callers decide how to surface that.
 */
export async function getConnectionState(): Promise<ConnectionState> {
  const hasToken = getToken() !== null
  const status: AuthStatus = await getAuthStatus()
  return {
    hasToken,
    authRequired: status.authRequired,
    authConfigured: status.authConfigured,
    // No login screen needed when the server does not enforce auth, or
    // when a previously stored token is already in place.
    connected: !status.authRequired || hasToken,
  }
}

/** Persist the auth token for all subsequent API requests. */
export function setToken(token: string): void {
  persistToken(token)
}

/** Forget the stored token (client-side logout). */
export function clearToken(): void {
  persistToken(null)
}

/**
 * True when the client talks to the API on the same origin — i.e.
 * VITE_API_URL is unset or empty and requests resolve against the
 * page's own host (the default web-client deployment).
 */
export function isSameOrigin(): boolean {
  return getBaseUrl() === ""
}

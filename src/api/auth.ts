// Auth — /api/v2/auth/*

import { request, setToken as persistToken } from "./client"

export interface AuthStatus {
  authRequired: boolean
  authConfigured: boolean
  allowUnauthenticated?: boolean
}

export interface LoginResponse {
  success: boolean
  message?: string
}

/** GET /api/v2/auth/status — public; reports whether a login screen is needed. */
export function getAuthStatus(): Promise<AuthStatus> {
  return request<AuthStatus>("/api/v2/auth/status")
}

/**
 * POST /api/v2/auth/login — validate a token. On success the token is stored
 * in localStorage so subsequent requests carry it as a Bearer header.
 */
export async function login(token: string): Promise<LoginResponse> {
  const res = await request<LoginResponse>("/api/v2/auth/login", {
    method: "POST",
    json: { token },
  })
  if (res.success) persistToken(token)
  return res
}

/** Forget the stored token (client-side logout). */
export function logout(): void {
  persistToken(null)
}

/**
 * Generate a cryptographically random API token using the Web Crypto API.
 *
 * Uses 32 bytes (256 bits) of randomness and base64url-encodes them so the
 * result is URL-safe and free of `+` / `/` / `=` — paste-safe into shell,
 * env vars, headers, query strings, and chat tools without escaping.
 */
export function generateApiToken(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return base64UrlEncode(bytes)
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = ""
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "")
}

// Shared cryptographic utilities used across route handlers.
// Centralising constant-time comparison so every auth path uses the same impl.

import crypto from "node:crypto"

/**
 * Byte-by-byte constant-time comparison. Used for API token validation so
 * the comparison latency does not leak information about the expected token.
 */
export function constantTimeEq(a, b) {
  const A = Buffer.from(String(a))
  const B = Buffer.from(String(b))
  if (A.length !== B.length) return false
  let d = 0
  for (let i = 0; i < A.length; i++) d |= A[i] ^ B[i]
  return d === 0
}
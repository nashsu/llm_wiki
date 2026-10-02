export const MIN_USER_CONCURRENCY = 1
export const MAX_USER_CONCURRENCY = 64

export function clampUserConcurrency(value: number, fallback = MIN_USER_CONCURRENCY): number {
  const resolved = Number.isFinite(value) ? Math.floor(value) : Math.floor(fallback)
  return Math.max(
    MIN_USER_CONCURRENCY,
    Math.min(MAX_USER_CONCURRENCY, resolved),
  )
}

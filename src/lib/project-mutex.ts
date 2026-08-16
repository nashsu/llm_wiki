/**
 * Per-project async mutex.
 *
 * Why this exists: multiple ingest and Save-to-Wiki entry points can mutate
 * shared project files such as `wiki/index.md`, `wiki/log.md`, page bodies,
 * and ingest caches. Those read-modify-write operations must not overlap.
 *
 * Expensive source preparation may run concurrently, but commit sections use
 * this mutex so queue, Save-to-Wiki, and deep-research writes take turns.
 *
 * The lock is a simple promise chain. No timeouts, no fairness, no
 * re-entrancy detection — those would all be overkill. If `fn`
 * hangs, the lock is held until it resolves; we'd rather have
 * back-pressure than corruption.
 */

const locks = new Map<string, Promise<unknown>>()

/**
 * Run `fn` while holding the per-`projectPath` lock. Returns the
 * value `fn` resolves to. If `fn` throws, the lock is released and
 * the rejection is propagated.
 */
export async function withProjectLock<T>(
  projectPath: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = locks.get(projectPath) ?? Promise.resolve()
  // We have to install our own promise into the map BEFORE awaiting
  // `prev`, otherwise a third caller can race in and find the map
  // still pointing at `prev`, and chain off the wrong slot.
  let release!: () => void
  const next = new Promise<void>((resolve) => {
    release = resolve
  })
  const tail = prev.then(() => next)
  locks.set(projectPath, tail)
  try {
    // Wait for the previous holder. Swallow rejections from `prev`
    // (a previous caller's failure shouldn't prevent us from running).
    await prev.catch(() => {})
    return await fn()
  } finally {
    release()
    // Best-effort cleanup: if our promise is still the tail, drop the
    // map entry. Otherwise a later caller has chained on; leave it.
    if (locks.get(projectPath) === tail) {
      // Defer the delete one tick so a caller that just chained on
      // doesn't see us yank the entry mid-chain.
      Promise.resolve().then(() => {
        if (locks.get(projectPath) === tail) {
          locks.delete(projectPath)
        }
      })
    }
  }
}

/** Test-only — drop all live locks. Used by `beforeEach` so test
 *  isolation is preserved across files that share the module-level
 *  `locks` map. */
export function __resetProjectLocksForTesting(): void {
  locks.clear()
}

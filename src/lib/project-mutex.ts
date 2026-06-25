/**
 * Per-project async mutex.
 *
 * Why this exists: `autoIngest` reads `wiki/index.md` at analysis
 * time, asks the LLM to emit an updated `index.md`, then overwrites
 * the file at write time. If two ingests run concurrently for the
 * SAME project (queue-driven ingest happening while a Save-to-Wiki
 * or deep-research auto-ingest fires), each LLM sees the same
 * pre-state of `index.md`, each emits its own "updated" version,
 * and whichever finishes second silently overwrites the first.
 * Net effect: pages from the first ingest disappear from the index
 * with no error surfaced anywhere.
 *
 * The queue itself is already serial — but Save-to-Wiki and
 * deep-research bypass the queue (`autoIngest(...).catch(...)`).
 * Wrapping `autoIngest`'s body in `withProjectLock(projectPath, …)`
 * forces all entry points to take turns.
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
  locks.set(
    projectPath,
    prev.then(() => next),
  )
  try {
    // Wait for the previous holder. Swallow rejections from `prev`
    // (a previous caller's failure shouldn't prevent us from running).
    await prev.catch(() => {})
    return await fn()
  } finally {
    release()
    // Best-effort cleanup: if our promise is still the tail, drop the
    // map entry. Otherwise a later caller has chained on; leave it.
    if (locks.get(projectPath) === next || locks.size > 1024) {
      // Tail check is approximate (the map stores prev.then(() => next),
      // not next directly). The size guard prevents pathological
      // unbounded growth if many distinct projectPaths cycle through.
      const tail = locks.get(projectPath)
      if (tail) {
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
}

/** Test-only — drop all live locks. Used by `beforeEach` so test
 *  isolation is preserved across files that share the module-level
 *  `locks` map. */
export function __resetProjectLocksForTesting(): void {
  locks.clear()
}

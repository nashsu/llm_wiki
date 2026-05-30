/**
 * Simple async mutex for serializing lint+fix operations (Phase 3.65-C).
 * Prevents concurrent runLintAndReport + fixLintReport calls.
 */

export function createAsyncMutex(): {
  acquire: () => Promise<() => void>
  locked: () => boolean
} {
  let locked = false
  let queue: Array<{ resolve: (release: () => void) => void }> = []

  function acquire(): Promise<() => void> {
    return new Promise((resolve) => {
      queue.push({ resolve })
      tryNext()
    })
  }

  function tryNext() {
    if (locked || queue.length === 0) return
    locked = true
    const entry = queue.shift()!
    entry.resolve(() => {
      locked = false
      tryNext()
    })
  }

  return {
    acquire,
    locked: () => locked,
  }
}

/** Singleton mutex for lint+fix operations across the app. */
export const lintFixMutex = createAsyncMutex()

/**
 * Per-project async mutex — Node.js port.
 * Ensures only one ingest runs at a time per project path.
 */
const locks = new Map<string, Promise<unknown>>()

export async function withProjectLock<T>(
  projectPath: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = locks.get(projectPath) ?? Promise.resolve()
  let release!: () => void
  const next = new Promise<void>((resolve) => { release = resolve })
  locks.set(projectPath, prev.then(() => next))

  try {
    await prev.catch(() => {})
    return await fn()
  } finally {
    release()
    if (locks.size > 128) {
      const tail = locks.get(projectPath)
      if (tail) {
        Promise.resolve().then(() => {
          if (locks.get(projectPath) === tail) locks.delete(projectPath)
        })
      }
    }
  }
}

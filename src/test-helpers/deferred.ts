/**
 * A promise whose resolve/reject handles are exposed so tests can drive
 * completion timing manually. Essential for race/abort/concurrency tests
 * where we need to pause a long-running operation at a specific await point.
 */
export interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
  settled: boolean
}

export function createDeferred<T = void>(): Deferred<T> {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  const d: Deferred<T> = {
    promise,
    resolve: (v) => {
      if (d.settled) return
      d.settled = true
      resolve(v)
    },
    reject: (e) => {
      if (d.settled) return
      d.settled = true
      reject(e)
    },
    settled: false,
  }
  return d
}

/**
 * Yield to the microtask queue so pending .then / await continuations run.
 * Use after triggering an async operation you want to observe mid-flight.
 */
export async function flushMicrotasks(ticks: number = 5): Promise<void> {
  for (let i = 0; i < ticks; i++) {
    await Promise.resolve()
  }
}

/**
 * Yield to the event loop (macrotasks) so real I/O promises (fs.writeFile,
 * network, etc.) get a chance to settle. Use after triggering an async
 * operation backed by libuv rather than pure promise continuations.
 */
export async function flushIO(ticks: number = 3): Promise<void> {
  for (let i = 0; i < ticks; i++) {
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
}

/**
 * Wait until `predicate()` returns true, or throw after `maxAttempts`.
 * Yields the event loop between attempts so real I/O can land.
 */
export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  maxAttempts: number = 100,
): Promise<void> {
  for (let i = 0; i < maxAttempts; i++) {
    if (await predicate()) return
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  throw new Error(`waitFor: predicate never became true after ${maxAttempts} attempts`)
}

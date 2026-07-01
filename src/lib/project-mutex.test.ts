/**
 * Per-project mutex tests.
 *
 * Pinning: two simultaneous calls for the SAME project must serialize
 * (second waits for first's promise to resolve before starting),
 * while two calls for DIFFERENT projects must run in parallel. The
 * tests use a Deferred helper to control resolution order so we can
 * observe ordering deterministically without racing on real I/O.
 */
import { describe, it, expect, beforeEach } from "vitest"
import { withProjectLock, __resetProjectLocksForTesting } from "./project-mutex"

beforeEach(() => {
  __resetProjectLocksForTesting()
})

/** Manual-resolve promise — like the project's deferred helper but
 *  we don't pull it in to keep this test self-contained. */
function defer<T = void>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe("withProjectLock — same-project serialization", () => {
  it("two calls for the same project run in order, second waits for first", async () => {
    const order: string[] = []
    const aRunning = defer()
    const aRelease = defer()

    // First call enters the critical section, signals "started", then
    // blocks on aRelease.
    const callA = withProjectLock("/proj", async () => {
      order.push("A:start")
      aRunning.resolve()
      await aRelease.promise
      order.push("A:end")
      return "A"
    })

    // Wait until A is actually inside its critical section before
    // launching B — this lets us guarantee B has to wait on A.
    await aRunning.promise
    expect(order).toEqual(["A:start"])

    const callB = withProjectLock("/proj", async () => {
      order.push("B:start")
      order.push("B:end")
      return "B"
    })

    // B must NOT have run yet — A still holds the lock.
    // A short tick to ensure B has had every opportunity to start.
    await Promise.resolve()
    await Promise.resolve()
    expect(order).toEqual(["A:start"])

    // Release A; both should finish in order A → B.
    aRelease.resolve()
    expect(await callA).toBe("A")
    expect(await callB).toBe("B")
    expect(order).toEqual(["A:start", "A:end", "B:start", "B:end"])
  })

  it("propagates exceptions from fn AND still releases the lock", async () => {
    const order: string[] = []

    const callFails = withProjectLock("/proj", async () => {
      order.push("failer:start")
      throw new Error("boom")
    })

    const callOK = withProjectLock("/proj", async () => {
      order.push("ok:start")
      return "ok"
    })

    await expect(callFails).rejects.toThrow("boom")
    expect(await callOK).toBe("ok")
    // Both ran, in order — the exception did NOT poison the lock.
    expect(order).toEqual(["failer:start", "ok:start"])
  })

  it("a third caller chained onto a still-pending second waits behind both", async () => {
    const order: string[] = []
    const aRelease = defer()
    const bRelease = defer()

    const a = withProjectLock("/proj", async () => {
      order.push("A:start")
      await aRelease.promise
      order.push("A:end")
    })
    const b = withProjectLock("/proj", async () => {
      order.push("B:start")
      await bRelease.promise
      order.push("B:end")
    })
    const c = withProjectLock("/proj", async () => {
      order.push("C:start")
      order.push("C:end")
    })

    // Let the microtask queue settle so A can enter its body. The
    // mutex involves several chained `await`s before fn() runs, so
    // a single tick isn't enough — drain a handful.
    for (let i = 0; i < 5; i++) await Promise.resolve()
    expect(order).toEqual(["A:start"])

    aRelease.resolve()
    await a
    // After A resolves, B starts.
    await Promise.resolve()
    await Promise.resolve()
    expect(order).toEqual(["A:start", "A:end", "B:start"])

    bRelease.resolve()
    await b
    await c
    expect(order).toEqual([
      "A:start", "A:end",
      "B:start", "B:end",
      "C:start", "C:end",
    ])
  })
})

describe("withProjectLock — cross-project parallelism", () => {
  it("calls for different projectPaths run concurrently (no shared lock)", async () => {
    const order: string[] = []
    const aRunning = defer()
    const bRunning = defer()
    const release = defer()

    const a = withProjectLock("/proj-A", async () => {
      order.push("A:start")
      aRunning.resolve()
      await release.promise
      order.push("A:end")
    })
    const b = withProjectLock("/proj-B", async () => {
      order.push("B:start")
      bRunning.resolve()
      await release.promise
      order.push("B:end")
    })

    // Both must enter the critical section before either finishes —
    // this is only possible if they DON'T share a lock.
    await Promise.all([aRunning.promise, bRunning.promise])
    expect(order).toContain("A:start")
    expect(order).toContain("B:start")
    expect(order).not.toContain("A:end")
    expect(order).not.toContain("B:end")

    release.resolve()
    await Promise.all([a, b])
    expect(order).toContain("A:end")
    expect(order).toContain("B:end")
  })
})

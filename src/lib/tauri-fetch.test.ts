/**
 * Node-fallback contract for tauri-fetch.
 *
 * In production (Tauri webview) `getHttpFetch()` returns the
 * `@tauri-apps/plugin-http` fetch so CORS-unfriendly endpoints work.
 * In tests / SSR / storybook `window` is undefined and we must route
 * through `globalThis.fetch` instead.
 *
 * A previous implementation `.catch()`ed the dynamic import — which
 * never fires because the import SUCCEEDS under Node but the plugin's
 * internals touch `window` later at call time. The fix is to detect
 * the Node env BEFORE importing. This test pins that behavior so the
 * fallback doesn't regress silently (you'd only notice via a vitest
 * run crash with "window is not defined").
 */
import { describe, it, expect } from "vitest"
import { getHttpFetch, isFetchNetworkError } from "./tauri-fetch"

describe("getHttpFetch — Node fallback", () => {
  it("returns a callable function under Node (typeof window === undefined)", async () => {
    expect(typeof window).toBe("undefined")
    const fn = await getHttpFetch()
    expect(typeof fn).toBe("function")
  })

  it("does not throw 'window is not defined' when invoked under Node", async () => {
    const fn = await getHttpFetch()
    // Hit a guaranteed-fail address so we don't make a real network
    // request — the point is to prove the fetch fn can be CALLED
    // without the plugin's browser-only globals blowing up. A real
    // network error or a fetch rejection is fine; a ReferenceError
    // for `window` is the regression we're catching.
    try {
      await fn("http://127.0.0.1:1/", { method: "GET" })
    } catch (err) {
      if (err instanceof ReferenceError && /window/i.test(err.message)) {
        throw new Error(
          `Node fallback regressed — getHttpFetch() returned something that touches window: ${err.message}`,
        )
      }
      // Any other error (ECONNREFUSED / TypeError) is expected and fine.
    }
  })

  it("is cached: two calls return the same function reference", async () => {
    const a = await getHttpFetch()
    const b = await getHttpFetch()
    expect(a).toBe(b)
  })
})

describe("isFetchNetworkError", () => {
  it("recognizes WebKit 'Load failed'", () => {
    const err = new Error("Load failed")
    expect(isFetchNetworkError(err)).toBe(true)
  })

  it("recognizes Chromium TypeError", () => {
    const err = new TypeError("Failed to fetch")
    expect(isFetchNetworkError(err)).toBe(true)
  })

  it("rejects AbortError (user cancel) — retries there would loop the cancellation", () => {
    const err = new Error("The user aborted a request.")
    err.name = "AbortError"
    expect(isFetchNetworkError(err)).toBe(false)
  })

  it("rejects non-Error values (null / string / undefined)", () => {
    expect(isFetchNetworkError(null)).toBe(false)
    expect(isFetchNetworkError("oops")).toBe(false)
    expect(isFetchNetworkError(undefined)).toBe(false)
  })

  it("matches generic 'network error' substring for less-common backends", () => {
    const err = new Error("there was a network error while connecting")
    expect(isFetchNetworkError(err)).toBe(true)
  })
})

// Auth env reconciliation (issue #19): LLM_WIKI_AUTH_MODE is the chartered
// primary, AUTH_MODE a deprecated alias, "open" normalizes to "none".
//
// The chartered design (V1_CHARTERED_ARCHITECTURE.md §4.5) specifies
// LLM_WIKI_AUTH_MODE=none|token, but the server historically read only
// AUTH_MODE while docker-compose.yml set LLM_WIKI_AUTH_MODE — which was
// ignored. This pins the reconciled resolution matrix:
//
//   LLM_WIKI_AUTH_MODE is primary; AUTH_MODE is a deprecated alias that
//   still works (with a warn-once deprecation notice); the primary wins on
//   conflict; "open" (the compose default) behaves exactly as "none";
//   unset/unknown → auto heuristic (required iff a token is configured).

import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

const DATA_DIR = mkdtempSync(path.join(tmpdir(), "llmwiki-authenv-"))
process.env.LLM_WIKI_DATA_DIR = DATA_DIR
process.env.LLM_WIKI_NO_SHARE = "1"

afterAll(() => {
  try { rmSync(DATA_DIR, { recursive: true, force: true }) } catch { /* noop */ }
})

const ENV_KEYS = ["LLM_WIKI_AUTH_MODE", "AUTH_MODE", "LLM_WIKI_API_TOKEN"]
let savedEnv = {}

beforeEach(() => {
  savedEnv = {}
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k]
    delete process.env[k]
  }
})

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
  vi.restoreAllMocks()
})

/** Fresh module instance (resetModules clears any warn-once module state). */
async function freshAuth() {
  vi.resetModules()
  return await import("../src/auth/config.js")
}

describe("LLM_WIKI_AUTH_MODE (chartered primary)", () => {
  it("=token requires auth", async () => {
    process.env.LLM_WIKI_AUTH_MODE = "token"
    process.env.LLM_WIKI_API_TOKEN = "secret-123"
    const { resolveAuth } = await freshAuth()
    const a = resolveAuth()
    expect(a.mode).toBe("token")
    expect(a.authRequired).toBe(true)
  })

  it("=none is open even when a token is configured", async () => {
    process.env.LLM_WIKI_AUTH_MODE = "none"
    process.env.LLM_WIKI_API_TOKEN = "secret-123"
    const { resolveAuth } = await freshAuth()
    const a = resolveAuth()
    expect(a.mode).toBe("none")
    expect(a.authRequired).toBe(false)
  })

  it('normalizes "open" (compose default) to none — open even with a token', async () => {
    process.env.LLM_WIKI_AUTH_MODE = "open"
    process.env.LLM_WIKI_API_TOKEN = "secret-123"
    const { resolveAuth } = await freshAuth()
    const a = resolveAuth()
    expect(a.mode).toBe("none")
    expect(a.authRequired).toBe(false)
  })

  it("wins over AUTH_MODE when both are set", async () => {
    process.env.LLM_WIKI_AUTH_MODE = "none"
    process.env.AUTH_MODE = "token"
    const { resolveAuth } = await freshAuth()
    const a = resolveAuth()
    expect(a.mode).toBe("none")
    expect(a.authRequired).toBe(false)
  })

  it("is trimmed and case-insensitive", async () => {
    process.env.LLM_WIKI_AUTH_MODE = "  TOKEN "
    const { resolveAuth } = await freshAuth()
    expect(resolveAuth().mode).toBe("token")
  })
})

describe("AUTH_MODE (deprecated alias)", () => {
  it("still enforces token mode", async () => {
    process.env.AUTH_MODE = "token"
    process.env.LLM_WIKI_API_TOKEN = "secret-123"
    const { resolveAuth } = await freshAuth()
    const a = resolveAuth()
    expect(a.mode).toBe("token")
    expect(a.authRequired).toBe(true)
  })

  it("emits a warn-once deprecation notice naming both variables", async () => {
    process.env.AUTH_MODE = "token"
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const { resolveAuth } = await freshAuth()
    resolveAuth()
    resolveAuth() // second resolve within the same process: must not re-warn
    expect(warn).toHaveBeenCalledTimes(1)
    const msg = String(warn.mock.calls[0]?.[0] ?? "")
    expect(msg).toContain("AUTH_MODE")
    expect(msg).toContain("LLM_WIKI_AUTH_MODE")
  })

  it("does not warn when only the primary is used", async () => {
    process.env.LLM_WIKI_AUTH_MODE = "token"
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const { resolveAuth } = await freshAuth()
    resolveAuth()
    expect(warn).not.toHaveBeenCalled()
  })
})

describe("auto (unset) — backward-compatible heuristic", () => {
  it("requires auth when a token is configured", async () => {
    process.env.LLM_WIKI_API_TOKEN = "secret-123"
    const { resolveAuth } = await freshAuth()
    const a = resolveAuth()
    expect(a.mode).toBe("auto")
    expect(a.authRequired).toBe(true)
  })

  it("is open when no token is configured", async () => {
    const { resolveAuth } = await freshAuth()
    const a = resolveAuth()
    expect(a.mode).toBe("auto")
    expect(a.authRequired).toBe(false)
  })
})

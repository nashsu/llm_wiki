import { describe, it, expect } from "vitest"
import {
  validateProxyUrl,
  buildNoProxyValue,
  isProxyActive,
  DEFAULT_BYPASS_LIST,
  type ProxyConfig,
} from "./proxy-config"

describe("validateProxyUrl", () => {
  it("accepts http:// URLs", () => {
    expect(validateProxyUrl("http://127.0.0.1:7890")).toEqual({ ok: true })
    expect(validateProxyUrl("http://proxy.corp.local:8080")).toEqual({ ok: true })
  })

  it("accepts https:// URLs", () => {
    expect(validateProxyUrl("https://proxy.corp:443")).toEqual({ ok: true })
  })

  it("accepts URLs with embedded auth", () => {
    expect(validateProxyUrl("http://user:pass@127.0.0.1:7890")).toEqual({ ok: true })
  })

  it("rejects URLs with no scheme", () => {
    // URL parser behaves differently across Node versions ("127.0.0.1:7890"
    // throws on some, parses to protocol="127.0.0.1:" on others). Either
    // way the URL must be REJECTED — the exact error message isn't part
    // of the contract.
    expect(validateProxyUrl("127.0.0.1:7890").ok).toBe(false)
    expect(validateProxyUrl("proxy.example.com:8080").ok).toBe(false)
  })

  it("rejects unsupported schemes (v1: HTTP/HTTPS only)", () => {
    expect(validateProxyUrl("socks5://127.0.0.1:1080")).toMatchObject({
      ok: false,
    })
    expect(validateProxyUrl("ftp://x")).toMatchObject({ ok: false })
  })

  it("rejects empty / whitespace input", () => {
    expect(validateProxyUrl("")).toMatchObject({ ok: false })
    expect(validateProxyUrl("   ")).toMatchObject({ ok: false })
  })

  it("rejects malformed URLs", () => {
    expect(validateProxyUrl("http://").ok).toBe(false)
    expect(validateProxyUrl("not-a-url").ok).toBe(false)
    expect(validateProxyUrl("http:").ok).toBe(false)
  })

  it("rejects URLs missing a host", () => {
    expect(validateProxyUrl("http://:7890")).toMatchObject({ ok: false })
  })
})

describe("buildNoProxyValue", () => {
  it("returns the default bypass list when bypassLocal is true", () => {
    expect(buildNoProxyValue(true)).toBe(DEFAULT_BYPASS_LIST)
  })

  it("returns null when bypassLocal is false (no NO_PROXY env var should be set)", () => {
    expect(buildNoProxyValue(false)).toBeNull()
  })

  it("default list covers the standard private networks and localhost", () => {
    const v = buildNoProxyValue(true)!
    expect(v).toContain("localhost")
    expect(v).toContain("127.0.0.0/8")
    expect(v).toContain("10.0.0.0/8")
    expect(v).toContain("172.16.0.0/12")
    expect(v).toContain("192.168.0.0/16")
    expect(v).toContain("*.local")
  })
})

describe("isProxyActive", () => {
  it("is false when disabled", () => {
    const cfg: ProxyConfig = { enabled: false, url: "http://x:1", bypassLocal: true }
    expect(isProxyActive(cfg)).toBe(false)
  })

  it("is false when enabled but URL is empty / whitespace", () => {
    expect(isProxyActive({ enabled: true, url: "", bypassLocal: true })).toBe(false)
    expect(isProxyActive({ enabled: true, url: "   ", bypassLocal: true })).toBe(false)
  })

  it("is false when enabled and URL is malformed", () => {
    expect(
      isProxyActive({ enabled: true, url: "not-a-url", bypassLocal: true }),
    ).toBe(false)
    expect(
      isProxyActive({ enabled: true, url: "ftp://x:1", bypassLocal: true }),
    ).toBe(false)
  })

  it("is true when enabled with a valid http(s) URL", () => {
    expect(
      isProxyActive({ enabled: true, url: "http://127.0.0.1:7890", bypassLocal: true }),
    ).toBe(true)
    expect(
      isProxyActive({ enabled: true, url: "https://proxy.corp:443", bypassLocal: false }),
    ).toBe(true)
  })
})

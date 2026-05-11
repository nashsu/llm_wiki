import { describe, expect, it } from "vitest"
import {
  decideWebAccessUrl,
  normalizeDomainList,
  normalizeWebAccessConfig,
  validateWebAccessEndpoint,
} from "./policy"

describe("WebAccess policy", () => {
  it("only allows a local WebAccess proxy endpoint", () => {
    expect(validateWebAccessEndpoint("http://localhost:3456").allowed).toBe(true)
    expect(validateWebAccessEndpoint("http://127.0.0.1:3456").allowed).toBe(true)
    expect(validateWebAccessEndpoint("https://example.com").allowed).toBe(false)
  })

  it("blocks unsafe protocols and private network targets", () => {
    const config = normalizeWebAccessConfig({ enabled: true, allowReadOnlyBrowser: true })

    expect(decideWebAccessUrl("file:///C:/secret.txt", config).allowed).toBe(false)
    expect(decideWebAccessUrl("javascript:alert(1)", config).allowed).toBe(false)
    expect(decideWebAccessUrl("http://localhost:8080", config).allowed).toBe(false)
    expect(decideWebAccessUrl("http://192.168.1.2/admin", config).allowed).toBe(false)
    expect(decideWebAccessUrl("http://169.254.169.254/latest/meta-data", config).allowed).toBe(false)
  })

  it("applies deny before allow and supports subdomain matching", () => {
    const config = normalizeWebAccessConfig({
      allowedDomains: ["example.com"],
      blockedDomains: ["private.example.com"],
    })

    expect(decideWebAccessUrl("https://docs.example.com/page", config).allowed).toBe(true)
    expect(decideWebAccessUrl("https://private.example.com/page", config).allowed).toBe(false)
    expect(decideWebAccessUrl("https://other.com/page", config).allowed).toBe(false)
  })

  it("normalizes newline, comma and wildcard domain lists", () => {
    expect(normalizeDomainList("https://example.com/a\n*.foo.com, bar.com")).toEqual([
      "example.com",
      "foo.com",
      "bar.com",
    ])
  })
})

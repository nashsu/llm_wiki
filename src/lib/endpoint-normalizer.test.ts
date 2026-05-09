import { describe, it, expect } from "vitest"
import { normalizeEndpoint } from "./endpoint-normalizer"

describe("normalizeEndpoint — chat_completions mode", () => {
  it("leaves a well-formed URL untouched", () => {
    const r = normalizeEndpoint("https://api.openai.com/v1", "chat_completions")
    expect(r.normalized).toBe("https://api.openai.com/v1")
    expect(r.changed).toBe(false)
    expect(r.warning).toBeUndefined()
  })

  it("strips trailing slash", () => {
    const r = normalizeEndpoint("https://api.openai.com/v1/", "chat_completions")
    expect(r.normalized).toBe("https://api.openai.com/v1")
    expect(r.changed).toBe(true)
  })

  it("strips pasted /chat/completions", () => {
    const r = normalizeEndpoint(
      "https://api.openai.com/v1/chat/completions",
      "chat_completions",
    )
    expect(r.normalized).toBe("https://api.openai.com/v1")
    expect(r.changed).toBe(true)
    expect(r.warning).toMatch(/chat\/completions/)
  })

  it("strips pasted /chat/completions with trailing slash", () => {
    const r = normalizeEndpoint(
      "https://api.openai.com/v1/chat/completions/",
      "chat_completions",
    )
    expect(r.normalized).toBe("https://api.openai.com/v1")
  })

  it("strips pasted /embeddings", () => {
    const r = normalizeEndpoint(
      "https://api.openai.com/v1/embeddings",
      "chat_completions",
    )
    expect(r.normalized).toBe("https://api.openai.com/v1")
  })

  it("preserves non-/v1 version segments (Zhipu, Arcee, etc.)", () => {
    const r = normalizeEndpoint(
      "https://open.bigmodel.cn/api/paas/v4",
      "chat_completions",
    )
    expect(r.normalized).toBe("https://open.bigmodel.cn/api/paas/v4")
    expect(r.changed).toBe(false)
  })

  it("strips /chat/completions while keeping a non-/v1 version segment", () => {
    const r = normalizeEndpoint(
      "https://open.bigmodel.cn/api/paas/v4/chat/completions",
      "chat_completions",
    )
    expect(r.normalized).toBe("https://open.bigmodel.cn/api/paas/v4")
  })

  it("warns when the URL is a bare host with no version path", () => {
    const r = normalizeEndpoint("https://api.openai.com", "chat_completions")
    // Don't auto-add /v1 — different providers use different segments.
    expect(r.normalized).toBe("https://api.openai.com")
    expect(r.warning).toMatch(/v1|version/i)
  })

  it("warns when protocol is missing", () => {
    const r = normalizeEndpoint("api.openai.com/v1", "chat_completions")
    expect(r.warning).toMatch(/https?:\/\//i)
  })

  it("handles empty / whitespace input", () => {
    expect(normalizeEndpoint("", "chat_completions").normalized).toBe("")
    expect(normalizeEndpoint("   ", "chat_completions").normalized).toBe("")
  })

  it("strips enclosing whitespace", () => {
    const r = normalizeEndpoint("  https://api.openai.com/v1  ", "chat_completions")
    expect(r.normalized).toBe("https://api.openai.com/v1")
  })

  it("handles localhost with a port and version segment", () => {
    const r = normalizeEndpoint("http://localhost:8080/v1", "chat_completions")
    expect(r.normalized).toBe("http://localhost:8080/v1")
    expect(r.changed).toBe(false)
  })

  it("strips /chat/completions on a localhost llama.cpp URL", () => {
    const r = normalizeEndpoint(
      "http://192.168.1.50:8080/v1/chat/completions",
      "chat_completions",
    )
    expect(r.normalized).toBe("http://192.168.1.50:8080/v1")
  })
})

describe("normalizeEndpoint — anthropic_messages mode", () => {
  it("keeps a bare /anthropic base as-is (dispatch appends /v1/messages)", () => {
    const r = normalizeEndpoint("https://api.minimax.io/anthropic", "anthropic_messages")
    expect(r.normalized).toBe("https://api.minimax.io/anthropic")
    expect(r.changed).toBe(false)
  })

  it("keeps a full /v1/messages URL as-is (dispatch uses it verbatim)", () => {
    const r = normalizeEndpoint(
      "https://api.anthropic.com/v1/messages",
      "anthropic_messages",
    )
    expect(r.normalized).toBe("https://api.anthropic.com/v1/messages")
    expect(r.changed).toBe(false)
  })

  it("strips trailing slash on an anthropic base", () => {
    const r = normalizeEndpoint("https://api.minimax.io/anthropic/", "anthropic_messages")
    expect(r.normalized).toBe("https://api.minimax.io/anthropic")
    expect(r.changed).toBe(true)
  })

  it("strips stray /chat/completions (user pasted the wrong shape)", () => {
    const r = normalizeEndpoint(
      "https://api.anthropic.com/v1/chat/completions",
      "anthropic_messages",
    )
    expect(r.warning).toMatch(/chat\/completions/)
    expect(r.normalized).toBe("https://api.anthropic.com/v1")
  })
})

describe("normalizeEndpoint — ollama_native mode", () => {
  it("accepts the native Ollama bare host without a /v1 warning", () => {
    const r = normalizeEndpoint("http://localhost:11434", "ollama_native")
    expect(r.normalized).toBe("http://localhost:11434")
    expect(r.changed).toBe(false)
    expect(r.warning).toBeUndefined()
  })

  it("still strips pasted request paths", () => {
    const r = normalizeEndpoint(
      "http://localhost:11434/v1/chat/completions",
      "ollama_native",
    )
    expect(r.normalized).toBe("http://localhost:11434/v1")
    expect(r.changed).toBe(true)
    expect(r.warning).toMatch(/chat\/completions/)
  })
})

describe("normalizeEndpoint — URL well-formedness catches", () => {
  it("flags a 5-octet IP-shaped host as malformed (real user paste)", () => {
    // Real user paste: "http://192.168.1.1.50:8000/v1".
    // WHATWG URL's IPv4 parser actually rejects this at `new URL()`
    // time with a TypeError, so it surfaces via the generic
    // "URL not well-formed" branch — but it DOES surface, which is the
    // point. Before this guard, the browser fetch failure was the
    // user's only signal, with nothing to say it was a typo.
    const r = normalizeEndpoint("http://192.168.1.1.50:8000/v1", "chat_completions")
    expect(r.warning).toBeDefined()
    expect(r.warning!.toLowerCase()).toMatch(/well-formed|typo|ipv4|octets/)
  })

  // 3-octet hosts like "10.0.0" are silently normalised to "10.0.0.0"
  // by WHATWG URL parsing (IPv4 shorthand expansion), so they don't
  // actually reach our regex as 3-octet. Not an issue in practice.

  it("rejects an octet > 255 at the URL-parsing layer", () => {
    // WHATWG URL treats "999" as invalid IPv4 too, so `new URL()`
    // throws outright — our malformed-URL branch catches it first
    // with the generic "not well-formed" message. Either way the user
    // is informed the URL is broken before the HTTP client sees it.
    const r = normalizeEndpoint("http://192.168.1.999:8080/v1", "chat_completions")
    expect(r.warning).toBeDefined()
    expect(r.warning!.toLowerCase()).toMatch(/well-formed|typo|ipv4|255/)
  })

  it("accepts a well-formed IPv4 host with port and path", () => {
    const r = normalizeEndpoint("http://192.168.1.50:8080/v1", "chat_completions")
    expect(r.warning).toBeUndefined()
    expect(r.normalized).toBe("http://192.168.1.50:8080/v1")
  })

  it("does NOT flag DNS-name-shaped hosts that contain dots", () => {
    // `api.openai.com` has dots but isn't IP-shaped (non-numeric
    // labels) — shouldn't trigger the IPv4 check.
    const r = normalizeEndpoint("https://api.openai.com/v1", "chat_completions")
    expect(r.warning).toBeUndefined()
  })

  it("rejects an unparseable URL (triple-t protocol typo)", () => {
    const r = normalizeEndpoint("htttp://api.openai.com/v1", "chat_completions")
    // missingProtocol fires first since /^https?:\/\//i doesn't match.
    expect(r.warning).toMatch(/https?:\/\//i)
  })

  it("rejects URL with illegal characters", () => {
    const r = normalizeEndpoint("https://api.openai.com:port/v1", "chat_completions")
    // Port "port" isn't numeric → new URL throws.
    expect(r.warning).toBeDefined()
    expect(r.warning!.toLowerCase()).toMatch(/well-formed|typo/)
  })

  it("accepts localhost host (non-IP) without flagging", () => {
    const r = normalizeEndpoint("http://localhost:11434/v1", "chat_completions")
    expect(r.warning).toBeUndefined()
  })
})

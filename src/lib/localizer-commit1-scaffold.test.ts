import { describe, it, expect } from "vitest"

// This test file exists solely as the Commit 1 scaffold gate for the
// markdown-image-localizer feature (plans/markdown-image-localizer.md
// v3.3 §Commit table row 1). It asserts:
//
//   1. `buildIngestHashInput` is exported from ingest.ts and folds
//      `localizeMarkdownImages` into the hash input as documented.
//   2. `validateHttpUrl`, `isPrivateNetworkHost`, `safeSlug` are exported
//      from url-source-import.ts — Commit 3 will import them verbatim.
//   3. `isInsideProject` is exported from markdown-image-resolver.ts —
//      Commit 3 will import it verbatim.
//
// When Commit 3 lands and imports these directly, this scaffold test
// can be removed (its assertions will be covered by the localizer's own
// test file). Kept here now purely as a compile-time export gate.

import { buildIngestHashInput } from "@/lib/ingest"
import type { MultimodalConfig } from "@/stores/wiki-store"
import {
  validateHttpUrl,
  isPrivateNetworkHost,
  safeSlug,
} from "@/lib/url-source-import"
import { isInsideProject } from "@/lib/markdown-image-resolver"

function mkMmCfg(overrides: Partial<MultimodalConfig> = {}): MultimodalConfig {
  return {
    enabled: true,
    useMainLlm: true,
    provider: "custom",
    apiKey: "",
    model: "",
    ollamaUrl: "http://localhost:11434",
    customEndpoint: "",
    azureApiVersion: "2024-10-21",
    apiMode: "chat_completions",
    concurrency: 4,
    localizeMarkdownImages: true,
    minImagePixelSize: 100,
    urlCacheTtlDays: 45,
    imageFetchTimeoutMs: 30_000,
    ...overrides,
  }
}

describe("commit-1 scaffold — buildIngestHashInput", () => {
  it("includes the localize=1 fingerprint when both enabled and localizeMarkdownImages are true", () => {
    const out = buildIngestHashInput("body", mkMmCfg())
    expect(out).toBe("body\n\n---cache-fingerprint---\nlocalize=1\n")
  })

  it("produces localize=0 when enabled=false (multimodal off)", () => {
    const out = buildIngestHashInput("body", mkMmCfg({ enabled: false }))
    expect(out).toBe("body\n\n---cache-fingerprint---\nlocalize=0\n")
  })

  it("produces localize=0 when localizeMarkdownImages=false (feature toggled off)", () => {
    const out = buildIngestHashInput("body", mkMmCfg({ localizeMarkdownImages: false }))
    expect(out).toBe("body\n\n---cache-fingerprint---\nlocalize=0\n")
  })

  it("produces distinct outputs for the same content across toggle states", () => {
    const bodyA = buildIngestHashInput("same content", mkMmCfg({ localizeMarkdownImages: true }))
    const bodyB = buildIngestHashInput("same content", mkMmCfg({ localizeMarkdownImages: false }))
    expect(bodyA).not.toBe(bodyB)
  })

  it("does NOT fold minImagePixelSize or urlCacheTtlDays into the fingerprint (per §8)", () => {
    const a = buildIngestHashInput("body", mkMmCfg({ minImagePixelSize: 100, urlCacheTtlDays: 45 }))
    const b = buildIngestHashInput("body", mkMmCfg({ minImagePixelSize: 500, urlCacheTtlDays: 7 }))
    expect(a).toBe(b)
  })
})

describe("commit-1 scaffold — url-source-import exports", () => {
  it("validateHttpUrl accepts http/https and rejects other schemes", () => {
    expect(() => validateHttpUrl("https://example.com/x.png")).not.toThrow()
    expect(() => validateHttpUrl("http://example.com/x.png")).not.toThrow()
    expect(() => validateHttpUrl("ftp://example.com/x.png")).toThrow()
    expect(() => validateHttpUrl("javascript:alert(1)")).toThrow()
  })

  it("validateHttpUrl rejects embedded credentials", () => {
    expect(() => validateHttpUrl("https://user:pass@example.com/")).toThrow()
  })

  it("isPrivateNetworkHost catches localhost and RFC1918", () => {
    expect(isPrivateNetworkHost("localhost")).toBe(true)
    expect(isPrivateNetworkHost("127.0.0.1")).toBe(true)
    expect(isPrivateNetworkHost("10.0.0.1")).toBe(true)
    expect(isPrivateNetworkHost("192.168.1.1")).toBe(true)
    expect(isPrivateNetworkHost("example.com")).toBe(false)
  })

  it("safeSlug normalises and handles Windows reserved names", () => {
    expect(safeSlug("Hello World.png")).toMatch(/^Hello-World/)
    // Windows-reserved stem gets '-web' suffix
    expect(safeSlug("con.png")).toBe("con.png-web")
  })
})

describe("commit-1 scaffold — markdown-image-resolver export", () => {
  it("isInsideProject accepts subpaths of the project root", () => {
    expect(isInsideProject("/project/wiki/media/img.png", "/project")).toBe(true)
    expect(isInsideProject("/project", "/project")).toBe(true)
  })

  it("isInsideProject rejects paths outside the project root", () => {
    expect(isInsideProject("/other/x.png", "/project")).toBe(false)
    // Sibling-with-prefix must not be classified as inside
    expect(isInsideProject("/projectroot/x.png", "/project")).toBe(false)
  })
})

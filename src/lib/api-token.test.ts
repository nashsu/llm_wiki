import { describe, expect, it } from "vitest"
import { generateApiToken } from "@/lib/api-token"

describe("generateApiToken", () => {
  it("produces URL-safe base64 with no padding", () => {
    for (let i = 0; i < 32; i++) {
      const token = generateApiToken()
      expect(token).toMatch(/^[A-Za-z0-9_-]+$/)
      expect(token).not.toContain("=")
      expect(token).not.toContain("+")
      expect(token).not.toContain("/")
    }
  })

  it("emits at least 32 bytes of entropy (>= 43 chars base64url)", () => {
    const token = generateApiToken()
    // 32 bytes -> 43 chars unpadded base64url.
    expect(token.length).toBeGreaterThanOrEqual(43)
  })

  it("is overwhelmingly unique across calls", () => {
    const tokens = new Set<string>()
    for (let i = 0; i < 100; i++) tokens.add(generateApiToken())
    expect(tokens.size).toBe(100)
  })
})

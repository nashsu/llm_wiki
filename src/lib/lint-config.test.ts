import { describe, expect, it } from "vitest"
import { DEFAULT_LINT_CONFIG, normalizeLintConfig } from "./lint-config"

describe("lint config", () => {
  it("preserves existing lint behavior by default", () => {
    expect(normalizeLintConfig()).toEqual(DEFAULT_LINT_CONFIG)
  })

  it("normalizes comma and newline separated ignored pages", () => {
    expect(normalizeLintConfig({
      ignoreOrphan: true,
      ignorePages: ["alpha, beta", "beta\nfolder/gamma.md", ""],
    })).toEqual({
      ignoreOrphan: true,
      ignoreNoOutlinks: false,
      ignorePages: ["alpha", "beta", "folder/gamma.md"],
    })
  })
})

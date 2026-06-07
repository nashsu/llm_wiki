import { describe, expect, it } from "vitest"
import { __projectStoreTest } from "./project-store"

describe("project-store MinerU config normalization", () => {
  it("preserves valid MinerU config values", () => {
    expect(__projectStoreTest.normalizeMineruConfig({
      enabled: true,
      token: "token-123",
      modelVersion: "pipeline",
    })).toEqual({
      enabled: true,
      token: "token-123",
      modelVersion: "pipeline",
    })
  })

  it("migrates legacy and malformed MinerU config values to safe defaults", () => {
    expect(__projectStoreTest.normalizeMineruConfig({
      enabled: "yes" as unknown as boolean,
      token: 123 as unknown as string,
      modelVersion: "mineru-html" as "vlm",
    })).toEqual({
      enabled: false,
      token: "",
      modelVersion: "vlm",
    })
  })
})

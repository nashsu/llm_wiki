import { describe, expect, it } from "vitest"
import {
  buildAzureOpenAiUrl,
  normalizeActivePresetId,
} from "./llm-config-normalize"

describe("buildAzureOpenAiUrl", () => {
  it("builds deployment chat URL with api-version", () => {
    expect(
      buildAzureOpenAiUrl(
        "https://my-resource.openai.azure.com",
        "gpt-5",
        "2024-10-21",
      ),
    ).toBe(
      "https://my-resource.openai.azure.com/openai/deployments/gpt-5/chat/completions?api-version=2024-10-21",
    )
  })

  it("reuses deployment embedded in the stored endpoint path", () => {
    expect(
      buildAzureOpenAiUrl(
        "https://my-resource.openai.azure.com/openai/deployments/my-gpt5",
        "wrong-model",
        "2024-10-21",
      ),
    ).toBe(
      "https://my-resource.openai.azure.com/openai/deployments/my-gpt5/chat/completions?api-version=2024-10-21",
    )
  })
})

describe("normalizeActivePresetId", () => {
  it("maps legacy azure-openai preset id to azure", () => {
    expect(normalizeActivePresetId("azure-openai")).toBe("azure")
  })
})

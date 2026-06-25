import { describe, it, expect } from "vitest"
import { buildAzureOpenAiUrl, isAzureOpenAiEndpoint } from "./azure-openai"

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

  it("detects only real Azure OpenAI hostnames", () => {
    expect(isAzureOpenAiEndpoint("https://my-resource.openai.azure.com")).toBe(true)
    expect(isAzureOpenAiEndpoint("my-resource.openai.azure.com/openai/deployments/wiki")).toBe(true)
    expect(isAzureOpenAiEndpoint("https://my-resource.openai.azure.com.evil.com")).toBe(false)
    expect(isAzureOpenAiEndpoint("https://example.com/path/openai.azure.com")).toBe(false)
  })
})

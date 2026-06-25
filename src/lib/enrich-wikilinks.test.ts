import { describe, expect, it, vi, beforeEach } from "vitest"
import { enrichWithWikilinks } from "./enrich-wikilinks"
import { shouldSkipWikilinkEnrichment } from "./ingest"

// Mock dependencies
vi.mock("@/commands/fs", () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
}))

vi.mock("./llm-client", () => ({
  streamChat: vi.fn(),
}))

const mockBumpDataVersion = vi.fn()
vi.mock("@/stores/wiki-store", () => ({
  useWikiStore: {
    getState: vi.fn(() => ({
      bumpDataVersion: mockBumpDataVersion,
      outputLanguage: "English",
    })),
  },
}))

// Do NOT mock output-language — use real implementation
// This ensures we test the actual language directive behavior

describe("enrichWithWikilinks", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // ── Language directive tests (restored semantics) ──

  it("uses the language configured at call time, not at module load", async () => {
    const { readFile } = await import("@/commands/fs")
    const { streamChat } = await import("./llm-client")
    const { useWikiStore } = await import("@/stores/wiki-store")

    // Mock store to return Chinese
    vi.mocked(useWikiStore.getState).mockReturnValue({
      outputLanguage: "Chinese",
      bumpDataVersion: vi.fn(),
    } as any)

    const content = `---
type: concept
title: Test
---
# Test

This mentions Transformer.
`
    const index = `- transformer`

    vi.mocked(readFile).mockImplementation(async (path: string) => {
      if (String(path).includes("index.md")) return index
      return content
    })
    vi.mocked(streamChat).mockImplementation(async (_config, _messages, callbacks) => {
      const cb = callbacks as { onToken: (t: string) => void; onDone: () => void }
      cb.onToken(JSON.stringify({ links: [] }))
      cb.onDone()
    })

    await enrichWithWikilinks("/project", "/project/wiki/test.md", {} as any)

    // Check that streamChat received system message with Chinese directive
    const systemMsg = vi.mocked(streamChat).mock.calls[0]?.[1]?.[0]
    expect(systemMsg?.role).toBe("system")
    expect(systemMsg?.content).toContain("MANDATORY OUTPUT LANGUAGE")
    expect(systemMsg?.content).toContain("Chinese")
  })

  it("picks up a language change between two successive calls", async () => {
    const { readFile } = await import("@/commands/fs")
    const { streamChat } = await import("./llm-client")
    const { useWikiStore } = await import("@/stores/wiki-store")

    const content = `---
type: concept
title: Test
---
# Test

This mentions Transformer.
`
    const index = `- transformer`

    vi.mocked(readFile).mockImplementation(async (path: string) => {
      if (String(path).includes("index.md")) return index
      return content
    })
    vi.mocked(streamChat).mockImplementation(async (_config, _messages, callbacks) => {
      const cb = callbacks as { onToken: (t: string) => void; onDone: () => void }
      cb.onToken(JSON.stringify({ links: [] }))
      cb.onDone()
    })

    // First call: English
    vi.mocked(useWikiStore.getState).mockReturnValue({
      outputLanguage: "English",
      bumpDataVersion: vi.fn(),
    } as any)
    await enrichWithWikilinks("/project", "/project/wiki/test.md", {} as any)

    const firstSystemMsg = vi.mocked(streamChat).mock.calls[0]?.[1]?.[0]
    expect(firstSystemMsg?.content).toContain("English")

    // Second call: Chinese
    vi.mocked(useWikiStore.getState).mockReturnValue({
      outputLanguage: "Chinese",
      bumpDataVersion: vi.fn(),
    } as any)
    await enrichWithWikilinks("/project", "/project/wiki/test.md", {} as any)

    const secondSystemMsg = vi.mocked(streamChat).mock.calls[1]?.[1]?.[0]
    expect(secondSystemMsg?.content).toContain("Chinese")
  })

  // ── Existing new tests ──

  it("does not modify frontmatter", async () => {
    const { readFile, writeFile } = await import("@/commands/fs")
    const { streamChat } = await import("./llm-client")

    const frontmatter = `---
type: concept
title: Test Page
tags: [test]
related: [other-page]
---`
    const body = `
# Test Page

This mentions Transformer in the text.
`
    const content = `${frontmatter}${body}`
    const index = `- other-page\n- transformer`

    vi.mocked(readFile).mockImplementation(async (path: string) => {
      if (String(path).includes("index.md")) return index
      return content
    })
    vi.mocked(streamChat).mockImplementation(async (_config, _messages, callbacks) => {
      const cb = callbacks as { onToken: (t: string) => void; onDone: () => void }
      cb.onToken(JSON.stringify({ links: [{ term: "Transformer", target: "transformer" }] }))
      cb.onDone()
    })

    await enrichWithWikilinks("/project", "/project/wiki/test-page.md", {} as any)

    const written = vi.mocked(writeFile).mock.calls[0]?.[1] as string
    // Frontmatter should be preserved exactly
    expect(written.startsWith(frontmatter)).toBe(true)
    expect(written).toMatch(/type: concept/)
    expect(written).toMatch(/title: Test Page/)
  })

  it("does not insert links inside existing [[...]] blocks (target/alias parts)", async () => {
    const { readFile, writeFile } = await import("@/commands/fs")
    const { streamChat } = await import("./llm-client")

    const content = `---
type: concept
title: Test
---
# Test

[[Transformer Architecture|Transformer]]
`
    const index = `- transformer\n- architecture`

    vi.mocked(readFile).mockImplementation(async (path: string) => {
      if (String(path).includes("index.md")) return index
      return content
    })
    vi.mocked(streamChat).mockImplementation(async (_config, _messages, callbacks) => {
      const cb = callbacks as { onToken: (t: string) => void; onDone: () => void }
      cb.onToken(JSON.stringify({ links: [
        { term: "Architecture", target: "architecture" },
        { term: "Transformer", target: "transformer" },
      ] }))
      cb.onDone()
    })

    await enrichWithWikilinks("/project", "/project/wiki/test.md", {} as any)

    // No other occurrence of Architecture or Transformer in body
    // So no file should be written
    expect(writeFile).not.toHaveBeenCalled()
  })

  it("skips links with targets not in wiki index", async () => {
    const { readFile, writeFile } = await import("@/commands/fs")
    const { streamChat } = await import("./llm-client")

    const content = `---
type: concept
title: Test
---
# Test

This mentions Transformer and NonExistent.
`
    const index = `- transformer`

    vi.mocked(readFile).mockImplementation(async (path: string) => {
      if (String(path).includes("index.md")) return index
      return content
    })
    vi.mocked(streamChat).mockImplementation(async (_config, _messages, callbacks) => {
      const cb = callbacks as { onToken: (t: string) => void; onDone: () => void }
      cb.onToken(JSON.stringify({ links: [
        { term: "Transformer", target: "transformer" },
        { term: "NonExistent", target: "nonexistent" },
      ] }))
      cb.onDone()
    })

    await enrichWithWikilinks("/project", "/project/wiki/test.md", {} as any)

    const written = vi.mocked(writeFile).mock.calls[0]?.[1] as string
    expect(written).toContain("[[Transformer]]")
    expect(written).not.toContain("[[NonExistent]]")
  })

  it("does not write file if no valid links", async () => {
    const { readFile, writeFile } = await import("@/commands/fs")
    const { streamChat } = await import("./llm-client")

    const content = `---
type: concept
title: Test
---
# Test

This mentions something.
`
    const index = `- other-page`

    vi.mocked(readFile).mockImplementation(async (path: string) => {
      if (String(path).includes("index.md")) return index
      return content
    })
    vi.mocked(streamChat).mockImplementation(async (_config, _messages, callbacks) => {
      const cb = callbacks as { onToken: (t: string) => void; onDone: () => void }
      cb.onToken(JSON.stringify({ links: [] }))
      cb.onDone()
    })

    await enrichWithWikilinks("/project", "/project/wiki/test.md", {} as any)

    expect(writeFile).not.toHaveBeenCalled()
  })

  it("supports AbortSignal - early abort before readFile", async () => {
    const { readFile, writeFile } = await import("@/commands/fs")
    const { streamChat } = await import("./llm-client")

    const content = `---
type: concept
title: Test
---
# Test

This mentions Transformer.
`
    const index = `- transformer`

    vi.mocked(readFile).mockImplementation(async (path: string) => {
      if (String(path).includes("index.md")) return index
      return content
    })
    
    const abortController = new AbortController()
    abortController.abort()
    
    vi.mocked(streamChat).mockImplementation(async () => {
      throw new Error("Should not be called when aborted")
    })

    await enrichWithWikilinks("/project", "/project/wiki/test.md", {} as any, abortController.signal)

    expect(streamChat).not.toHaveBeenCalled()
    expect(writeFile).not.toHaveBeenCalled()
  })

  it("supports AbortSignal - abort after streamChat returns", async () => {
    const { readFile, writeFile } = await import("@/commands/fs")
    const { streamChat } = await import("./llm-client")

    const content = `---
type: concept
title: Test
---
# Test

This mentions Transformer.
`
    const index = `- transformer`

    vi.mocked(readFile).mockImplementation(async (path: string) => {
      if (String(path).includes("index.md")) return index
      return content
    })
    
    const abortController = new AbortController()
    
    vi.mocked(streamChat).mockImplementation(async (_config, _messages, callbacks) => {
      const cb = callbacks as { onToken: (t: string) => void; onDone: () => void }
      cb.onToken(JSON.stringify({ links: [{ term: "Transformer", target: "transformer" }] }))
      // Abort during streamChat
      abortController.abort()
      cb.onDone()
    })

    await enrichWithWikilinks("/project", "/project/wiki/test.md", {} as any, abortController.signal)

    // Should not write because signal was aborted
    expect(writeFile).not.toHaveBeenCalled()
  })
})

// ── Skip helper tests ──

describe("shouldSkipWikilinkEnrichment", () => {
  it("skips wiki/index.md", () => {
    expect(shouldSkipWikilinkEnrichment("wiki/index.md")).toBe(true)
  })

  it("skips wiki/log.md", () => {
    expect(shouldSkipWikilinkEnrichment("wiki/log.md")).toBe(true)
  })

  it("skips wiki/overview.md", () => {
    expect(shouldSkipWikilinkEnrichment("wiki/overview.md")).toBe(true)
  })

  it("skips wiki/sources/*", () => {
    expect(shouldSkipWikilinkEnrichment("wiki/sources/source-a.md")).toBe(true)
    expect(shouldSkipWikilinkEnrichment("wiki/sources/another-source.md")).toBe(true)
  })

  it("skips nested log.md", () => {
    expect(shouldSkipWikilinkEnrichment("wiki/entities/log.md")).toBe(true)
  })

  it("skips nested index.md", () => {
    expect(shouldSkipWikilinkEnrichment("wiki/entities/index.md")).toBe(true)
  })

  it("does not skip normal concept pages", () => {
    expect(shouldSkipWikilinkEnrichment("wiki/concepts/transformer.md")).toBe(false)
  })

  it("does not skip normal entity pages", () => {
    expect(shouldSkipWikilinkEnrichment("wiki/entities/openai.md")).toBe(false)
  })

  it("does not skip notes pages", () => {
    expect(shouldSkipWikilinkEnrichment("wiki/notes/foo.md")).toBe(false)
  })
})

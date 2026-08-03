import { beforeEach, describe, expect, it, vi } from "vitest"

const preprocessFile = vi.hoisted(() => vi.fn())
vi.mock("@/commands/fs", () => ({ preprocessFile }))

import { normalizeParsingConcurrency, preprocessSourceFiles } from "./source-preprocess"

describe("source preprocessing", () => {
  beforeEach(() => vi.clearAllMocks())

  it("normalizes concurrency into the supported integer range", () => {
    expect(normalizeParsingConcurrency(Number.NaN)).toBe(1)
    expect(normalizeParsingConcurrency(0)).toBe(1)
    expect(normalizeParsingConcurrency(3.9)).toBe(3)
    expect(normalizeParsingConcurrency(99)).toBe(8)
  })

  it("never exceeds the configured concurrency and de-duplicates paths", async () => {
    let active = 0
    let peak = 0
    preprocessFile.mockImplementation(async () => {
      active += 1
      peak = Math.max(peak, active)
      await new Promise((resolve) => setTimeout(resolve, 5))
      active -= 1
    })

    await preprocessSourceFiles(["a.pdf", "b.docx", "a.pdf", "c.epub", "d.org"], 2)

    expect(peak).toBe(2)
    expect(preprocessFile).toHaveBeenCalledTimes(4)
  })

  it("shares the concurrency ceiling across simultaneous batches", async () => {
    let active = 0
    let peak = 0
    preprocessFile.mockImplementation(async () => {
      active += 1
      peak = Math.max(peak, active)
      await new Promise((resolve) => setTimeout(resolve, 5))
      active -= 1
    })

    await Promise.all([
      preprocessSourceFiles(["a.pdf", "b.pdf", "c.pdf"], 2),
      preprocessSourceFiles(["d.docx", "e.docx", "f.docx"], 2),
    ])

    expect(peak).toBe(2)
  })

  it("continues after one extractor fails", async () => {
    preprocessFile.mockRejectedValueOnce(new Error("bad file")).mockResolvedValue("")
    await expect(preprocessSourceFiles(["bad.pdf", "good.docx"], 1)).resolves.toBeUndefined()
    expect(preprocessFile).toHaveBeenCalledTimes(2)
  })
})

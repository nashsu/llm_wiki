import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/commands/fs", () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  createDirectory: vi.fn(),
}))

import { createDirectory, readFile, writeFile } from "@/commands/fs"
import {
  addIgnoredPair,
  addIgnoredTerm,
  isIgnoredPair,
  isIgnoredTerm,
  loadAutoLinkIgnoreRules,
  normalizeIgnoreRules,
  saveAutoLinkIgnoreRules,
} from "./auto-link-ignore"

const mockReadFile = vi.mocked(readFile)
const mockWriteFile = vi.mocked(writeFile)
const mockCreateDirectory = vi.mocked(createDirectory)

beforeEach(() => {
  mockReadFile.mockReset()
  mockWriteFile.mockReset()
  mockCreateDirectory.mockReset()
  mockWriteFile.mockResolvedValue(undefined)
  mockCreateDirectory.mockResolvedValue(undefined)
})

describe("loadAutoLinkIgnoreRules", () => {
  it("returns empty rules when the project ignore file is missing", async () => {
    mockReadFile.mockRejectedValue(new Error("file not found"))

    await expect(loadAutoLinkIgnoreRules("/project")).resolves.toEqual({
      terms: [],
      pairs: [],
    })
    expect(mockReadFile).toHaveBeenCalledWith(
      "/project/.llm-wiki/auto-link-ignore.json",
    )
  })

  it("returns empty rules when the project ignore file contains invalid JSON", async () => {
    mockReadFile.mockResolvedValue("not json")

    await expect(loadAutoLinkIgnoreRules("/project")).resolves.toEqual({
      terms: [],
      pairs: [],
    })
  })
})

describe("normalizeIgnoreRules", () => {
  it("normalizes malformed arrays to empty arrays", () => {
    expect(normalizeIgnoreRules({ terms: "alpha", pairs: {} })).toEqual({
      terms: [],
      pairs: [],
    })
  })

  it("trims and retains valid terms and pairs from mixed arrays", () => {
    expect(
      normalizeIgnoreRules({
        terms: ["  Alpha  ", 42, "", " Beta "],
        pairs: [
          { term: "  EMP ", target: " early-emp " },
          { term: "", target: "blank-term" },
          { term: "missing-target" },
          null,
        ],
      }),
    ).toEqual({
      terms: ["Alpha", "Beta"],
      pairs: [{ term: "EMP", target: "early-emp" }],
    })
  })
})

describe("ignore matching", () => {
  it("matches ignored terms case-insensitively after trimming", () => {
    expect(
      isIgnoredTerm("  alpha ", { terms: [" Alpha "], pairs: [] }),
    ).toBe(true)
  })

  it("matches ignored pairs case-insensitively after trimming", () => {
    expect(
      isIgnoredPair(" emp ", " EARLY-EMP ", {
        terms: [],
        pairs: [{ term: " EMP", target: "early-emp " }],
      }),
    ).toBe(true)
  })
})

describe("add ignore rules", () => {
  it("adds, returns, and persists a new ignored term", async () => {
    mockReadFile.mockResolvedValue(JSON.stringify({ terms: [], pairs: [] }))

    await expect(addIgnoredTerm("/project", "  Alpha  ")).resolves.toEqual({
      terms: ["Alpha"],
      pairs: [],
    })
    expect(mockWriteFile).toHaveBeenCalledWith(
      "/project/.llm-wiki/auto-link-ignore.json",
      '{\n  "terms": [\n    "Alpha"\n  ],\n  "pairs": []\n}\n',
    )
  })

  it("adds, returns, and persists a new ignored pair", async () => {
    mockReadFile.mockResolvedValue(JSON.stringify({ terms: [], pairs: [] }))

    await expect(
      addIgnoredPair("/project", { term: "  EMP ", target: " early-emp  " }),
    ).resolves.toEqual({
      terms: [],
      pairs: [{ term: "EMP", target: "early-emp" }],
    })
    expect(mockWriteFile).toHaveBeenCalledWith(
      "/project/.llm-wiki/auto-link-ignore.json",
      '{\n  "terms": [],\n  "pairs": [\n    {\n      "term": "EMP",\n      "target": "early-emp"\n    }\n  ]\n}\n',
    )
  })

  it("does not duplicate an existing ignored term", async () => {
    mockReadFile.mockResolvedValue(
      JSON.stringify({ terms: [" Alpha "], pairs: [] }),
    )

    await expect(addIgnoredTerm("/project", " alpha ")).resolves.toEqual({
      terms: ["Alpha"],
      pairs: [],
    })
    expect(mockWriteFile).toHaveBeenCalledWith(
      "/project/.llm-wiki/auto-link-ignore.json",
      '{\n  "terms": [\n    "Alpha"\n  ],\n  "pairs": []\n}\n',
    )
  })

  it("does not duplicate an existing ignored pair", async () => {
    mockReadFile.mockResolvedValue(
      JSON.stringify({
        terms: [],
        pairs: [{ term: " EMP ", target: " Early-EMP " }],
      }),
    )

    await expect(
      addIgnoredPair("/project", { term: "emp", target: " early-emp " }),
    ).resolves.toEqual({
      terms: [],
      pairs: [{ term: "EMP", target: "Early-EMP" }],
    })
    expect(mockWriteFile).toHaveBeenCalledWith(
      "/project/.llm-wiki/auto-link-ignore.json",
      '{\n  "terms": [],\n  "pairs": [\n    {\n      "term": "EMP",\n      "target": "Early-EMP"\n    }\n  ]\n}\n',
    )
  })
})

describe("saveAutoLinkIgnoreRules", () => {
  it("writes normalized pretty JSON with a trailing newline", async () => {
    await saveAutoLinkIgnoreRules("/project", {
      terms: [" Alpha "],
      pairs: [{ term: " EMP ", target: " early-emp " }],
    })

    expect(mockCreateDirectory).toHaveBeenCalledWith("/project/.llm-wiki")
    expect(mockWriteFile).toHaveBeenCalledWith(
      "/project/.llm-wiki/auto-link-ignore.json",
      '{\n  "terms": [\n    "Alpha"\n  ],\n  "pairs": [\n    {\n      "term": "EMP",\n      "target": "early-emp"\n    }\n  ]\n}\n',
    )
  })

  it("still writes when creating the existing ignore directory rejects", async () => {
    mockCreateDirectory.mockRejectedValue(new Error("already exists"))

    await expect(
      saveAutoLinkIgnoreRules("/project", { terms: [], pairs: [] }),
    ).resolves.toBeUndefined()
    expect(mockCreateDirectory).toHaveBeenCalledWith("/project/.llm-wiki")
    expect(mockWriteFile).toHaveBeenCalledWith(
      "/project/.llm-wiki/auto-link-ignore.json",
      '{\n  "terms": [],\n  "pairs": []\n}\n',
    )
  })
})

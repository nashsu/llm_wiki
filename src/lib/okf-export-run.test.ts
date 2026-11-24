import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  copyFile: vi.fn(),
  createDirectory: vi.fn(),
  listDirectory: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
}))

vi.mock("@/commands/fs", async () => {
  const actual = await vi.importActual<typeof import("@/commands/fs")>("@/commands/fs")
  return {
    ...actual,
    copyFile: mocks.copyFile,
    createDirectory: mocks.createDirectory,
    listDirectory: mocks.listDirectory,
    readFile: mocks.readFile,
    writeFile: mocks.writeFile,
  }
})

import { runOkfExport } from "./okf-export-run"

const WIKI_TREE = [
  {
    name: "index.md",
    path: "/proj/wiki/index.md",
    is_dir: false,
    children: null,
  },
  {
    name: "entities",
    path: "/proj/wiki/entities",
    is_dir: true,
    children: [
      {
        name: "dpao.md",
        path: "/proj/wiki/entities/dpao.md",
        is_dir: false,
        children: null,
      },
      {
        name: "photo.png",
        path: "/proj/wiki/entities/photo.png",
        is_dir: false,
        children: null,
      },
    ],
  },
]

const DPAO = `---
type: entity
title: DPAO
created: 2026-04-09
sources: ["paper.pdf"]
---

Body.
`

beforeEach(() => {
  vi.clearAllMocks()
  mocks.readFile.mockImplementation(async (path: string) => {
    if (path.endsWith("index.md")) return "# Wiki Index\n\n- [[entities/dpao|DPAO]]\n"
    if (path.endsWith("dpao.md")) return DPAO
    throw new Error(`unexpected readFile: ${path}`)
  })
  mocks.listDirectory.mockImplementation(async (path: string) => {
    if (path === "/proj/wiki") return WIKI_TREE
    if (path === "/out/okf") throw new Error("Path does not exist: '/out/okf'")
    if (path === "/out/busy") return [{ name: "x", path: "/out/busy/x", is_dir: false }]
    throw new Error(`unexpected listDirectory: ${path}`)
  })
})

describe("runOkfExport", () => {
  it("writes the transformed bundle and copies assets byte-for-byte", async () => {
    const result = await runOkfExport("/proj", "/out/okf")

    expect(mocks.createDirectory).toHaveBeenCalledWith("/out/okf")
    expect(result.filesWritten).toBe(3)
    expect(result.conceptCount).toBe(1)

    const writes = mocks.writeFile.mock.calls.map(([p, c]) => [p, c] as const)
    const index = writes.find(([p]) => p === "/out/okf/index.md")
    expect(index?.[1]).toMatch(/okf_version: ["']0\.2["']/)
    const page = writes.find(([p]) => p === "/out/okf/entities/dpao.md")
    expect(page?.[1]).toContain("type: entity")

    // Binary assets bypass readFile (which would return placeholder text).
    expect(mocks.readFile.mock.calls.some(([p]) => p.endsWith("photo.png"))).toBe(false)
    expect(mocks.copyFile).toHaveBeenCalledWith(
      "/proj/wiki/entities/photo.png",
      "/out/okf/entities/photo.png",
    )
  })

  it("refuses a destination inside the project", async () => {
    await expect(runOkfExport("/proj", "/proj/export")).rejects.toThrow("outside the project")
    expect(mocks.writeFile).not.toHaveBeenCalled()
  })

  it("refuses a non-empty destination", async () => {
    await expect(runOkfExport("/proj", "/out/busy")).rejects.toThrow("not empty")
    expect(mocks.writeFile).not.toHaveBeenCalled()
  })
})

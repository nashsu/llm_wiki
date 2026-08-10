import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  createDirectory: vi.fn(),
  deleteFile: vi.fn(),
  readFile: vi.fn(),
  writeFileAtomic: vi.fn(),
}))

vi.mock("@/commands/fs", () => mocks)

import {
  moveParsedMarkdown,
  parsedMarkdownOutputPath,
  persistParsedMarkdown,
  removeParsedMarkdown,
} from "./parsed-source-output"

describe("parsed source output", () => {
  beforeEach(() => vi.clearAllMocks())

  it("mirrors nested source paths without dropping the original extension", () => {
    expect(
      parsedMarkdownOutputPath("/project", "/project/raw/sources/reports/a.pdf"),
    ).toBe("/project/raw/parsed/reports/a.pdf.md")
    expect(
      parsedMarkdownOutputPath("C:\\Project", "c:\\project\\raw\\sources\\A.DOCX"),
    ).toBe("C:/Project/raw/parsed/A.DOCX.md")
    expect(parsedMarkdownOutputPath("/project", "raw/sources/a.pdf"))
      .toBe("/project/raw/parsed/a.pdf.md")
  })

  it("rejects sources outside the project and formats that are already text", () => {
    expect(parsedMarkdownOutputPath("/project", "/other/report.pdf")).toBeNull()
    expect(parsedMarkdownOutputPath("/project", "/project/raw/sources/note.md")).toBeNull()
    expect(parsedMarkdownOutputPath("/project", "/project/raw/sources/data.json")).toBeNull()
  })

  it("supports AnyDoc-only Office variants and RTF", () => {
    for (const fileName of ["a.docm", "a.ppt", "a.ppsm", "a.xlsb", "a.rtf"]) {
      expect(
        parsedMarkdownOutputPath("/project", `/project/raw/sources/${fileName}`),
      ).toBe(`/project/raw/parsed/${fileName}.md`)
    }
  })

  it("creates the mirrored directory and writes atomically", async () => {
    await expect(
      persistParsedMarkdown(
        "/project",
        "/project/raw/sources/nested/report.pdf",
        "# Parsed",
      ),
    ).resolves.toBe("/project/raw/parsed/nested/report.pdf.md")
    expect(mocks.createDirectory).toHaveBeenCalledWith("/project/raw/parsed/nested")
    expect(mocks.writeFileAtomic).toHaveBeenCalledWith(
      "/project/raw/parsed/nested/report.pdf.md",
      "# Parsed",
    )
  })

  it("removes and moves generated copies with their source lifecycle", async () => {
    mocks.readFile.mockResolvedValue("# Parsed")

    await removeParsedMarkdown("/project", "/project/raw/sources/old/report.pdf")
    expect(mocks.deleteFile).toHaveBeenCalledWith(
      "/project/raw/parsed/old/report.pdf.md",
    )

    mocks.deleteFile.mockClear()
    await moveParsedMarkdown(
      "/project",
      "/project/raw/sources/old/report.pdf",
      "/project/raw/sources/new/report.pdf",
    )
    expect(mocks.readFile).toHaveBeenCalledWith("/project/raw/parsed/old/report.pdf.md")
    expect(mocks.writeFileAtomic).toHaveBeenCalledWith(
      "/project/raw/parsed/new/report.pdf.md",
      "# Parsed",
    )
    expect(mocks.deleteFile).toHaveBeenCalledWith("/project/raw/parsed/old/report.pdf.md")
  })
})

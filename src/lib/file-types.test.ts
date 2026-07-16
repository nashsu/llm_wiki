import { describe, expect, it } from "vitest"
import {
  getCodeLanguage,
  getFileCategory,
  getFileExtension,
  isExtractedTextPreviewFile,
} from "@/lib/file-types"

describe("file types", () => {
  it("recognizes backend-extracted document previews", () => {
    expect(isExtractedTextPreviewFile("/project/raw/sources/report.doc")).toBe(true)
    expect(isExtractedTextPreviewFile("/project/raw/sources/report.docx")).toBe(true)
    expect(isExtractedTextPreviewFile("/project/raw/sources/slides.pptx")).toBe(true)
    expect(isExtractedTextPreviewFile("/project/raw/sources/sheet.xlsx")).toBe(true)
    expect(isExtractedTextPreviewFile("/project/raw/sources/book.epub")).toBe(true)
    expect(isExtractedTextPreviewFile("C:\\books\\book.MOBI")).toBe(true)
    expect(isExtractedTextPreviewFile("/project/raw/sources/archive.zip")).toBe(false)
  })

  it("classifies EPUB and MOBI as extracted documents", () => {
    expect(getFileCategory("/project/book.epub")).toBe("document")
    expect(getFileCategory("C:\\books\\book.MOBI")).toBe("document")
  })

  it("extracts extensions from windows and unix paths", () => {
    expect(getFileExtension("C:\\Users\\me\\report.DOC")).toBe("doc")
    expect(getFileExtension("/Users/me/report.docx")).toBe("docx")
    expect(getFileExtension("/Users/me/README")).toBe("")
  })

  it("routes standalone Mermaid sources through the code preview pipeline", () => {
    expect(getFileCategory("/project/diagram.mmd")).toBe("code")
    expect(getFileCategory("C:\\project\\diagram.MERMAID")).toBe("code")
    expect(getCodeLanguage("/project/diagram.mmd")).toBe("mermaid")
  })
})

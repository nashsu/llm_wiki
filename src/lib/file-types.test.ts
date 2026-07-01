import { describe, expect, it } from "vitest"
import {
  getFileExtension,
  isExtractedTextPreviewFile,
} from "@/lib/file-types"

describe("file types", () => {
  it("recognizes backend-extracted document previews", () => {
    expect(isExtractedTextPreviewFile("/project/raw/sources/report.doc")).toBe(true)
    expect(isExtractedTextPreviewFile("/project/raw/sources/report.docx")).toBe(true)
    expect(isExtractedTextPreviewFile("/project/raw/sources/slides.pptx")).toBe(true)
    expect(isExtractedTextPreviewFile("/project/raw/sources/sheet.xlsx")).toBe(true)
    expect(isExtractedTextPreviewFile("/project/raw/sources/archive.zip")).toBe(false)
  })

  it("extracts extensions from windows and unix paths", () => {
    expect(getFileExtension("C:\\Users\\me\\report.DOC")).toBe("doc")
    expect(getFileExtension("/Users/me/report.docx")).toBe("docx")
    expect(getFileExtension("/Users/me/README")).toBe("")
  })
})

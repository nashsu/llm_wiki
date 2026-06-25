import { describe, expect, it } from "vitest"
import {
  getHtmlLang,
  getLanguagePromptName,
  getTextDirection,
  sameScriptFamily,
} from "./language-metadata"

describe("language metadata", () => {
  it("marks Persian as RTL Farsi for rendering and prompts", () => {
    expect(getLanguagePromptName("Persian")).toBe("Persian (Farsi / فارسی)")
    expect(getTextDirection("Persian")).toBe("rtl")
    expect(getHtmlLang("Persian")).toBe("fa")
  })

  it("keeps Persian and Arabic in the same script family", () => {
    expect(sameScriptFamily("Persian", "Arabic")).toBe(true)
  })

  it("defaults unknown languages to LTR with the original prompt name", () => {
    expect(getLanguagePromptName("Vietnamese")).toBe("Vietnamese")
    expect(getTextDirection("Vietnamese")).toBe("ltr")
  })
})

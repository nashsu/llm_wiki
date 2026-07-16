import { describe, it, expect, beforeEach } from "vitest"
import { getOutputLanguage, buildLanguageDirective, buildLanguageReminder } from "./output-language"
import { useWikiStore } from "@/stores/wiki-store"

// Reset the outputLanguage back to "auto" before each test so tests can't
// leak state into one another via the shared Zustand store.
beforeEach(() => {
  useWikiStore.getState().setOutputLanguage("auto")
})

describe("getOutputLanguage", () => {
  it("uses the explicit user setting verbatim (Chinese)", () => {
    useWikiStore.getState().setOutputLanguage("Chinese")
    expect(getOutputLanguage("whatever fallback text")).toBe("Chinese")
  })

  it("explicit user setting beats fallback detection (source is English, setting is Japanese)", () => {
    useWikiStore.getState().setOutputLanguage("Japanese")
    expect(getOutputLanguage("This is clearly English text")).toBe("Japanese")
  })

  it("auto mode falls back to detectLanguage on the fallback text", () => {
    useWikiStore.getState().setOutputLanguage("auto")
    expect(getOutputLanguage("注意力机制是什么")).toBe("Chinese")
  })

  it("auto mode detects Persian separately from Arabic", () => {
    useWikiStore.getState().setOutputLanguage("auto")
    expect(getOutputLanguage("پردازش زبان طبیعی در فارسی کاربردهای زیادی دارد")).toBe("Persian")
  })

  it("supports Czech as both an explicit and auto-detected output language", () => {
    useWikiStore.getState().setOutputLanguage("Czech")
    expect(getOutputLanguage("English fallback text")).toBe("Czech")

    useWikiStore.getState().setOutputLanguage("auto")
    expect(getOutputLanguage("Příliš žluťoučký kůň úpěl ďábelské ódy")).toBe("Czech")
  })

  it("auto mode with empty fallback defaults to English", () => {
    useWikiStore.getState().setOutputLanguage("auto")
    expect(getOutputLanguage("")).toBe("English")
  })

  it("auto mode with no fallback arg defaults to English", () => {
    useWikiStore.getState().setOutputLanguage("auto")
    expect(getOutputLanguage()).toBe("English")
  })
})

describe("buildLanguageDirective", () => {
  it("contains the MANDATORY OUTPUT LANGUAGE header", () => {
    useWikiStore.getState().setOutputLanguage("Chinese")
    const directive = buildLanguageDirective()
    expect(directive).toContain("MANDATORY OUTPUT LANGUAGE: Chinese")
  })

  it("keeps the target prose language prominent without requiring proper noun translation", () => {
    useWikiStore.getState().setOutputLanguage("Japanese")
    const directive = buildLanguageDirective()
    const count = (directive.match(/Japanese/g) || []).length
    expect(count).toBeGreaterThanOrEqual(3)
    expect(directive).toContain("Write surrounding natural-language prose")
    expect(directive).toContain("prose titles and section headings")
    expect(directive).toContain("Preserve organization names")
    expect(directive).toContain("model names")
    expect(directive).toContain("paper titles")
    expect(directive).toContain("technical terms that have no widely-used localized equivalent")
    expect(directive).toContain("does not override the proper-noun and technical-identifier preservation rule")
    expect(directive).not.toMatch(/transliteration when appropriate/i)
    expect(directive).not.toContain("overrides all other instructions")
  })

  it("follows the explicit setting even when fallback text is in another language", () => {
    useWikiStore.getState().setOutputLanguage("Vietnamese")
    const directive = buildLanguageDirective("这段文字是中文")
    expect(directive).toContain("Vietnamese")
    expect(directive).not.toContain("MANDATORY OUTPUT LANGUAGE: Chinese")
  })

  it("uses detected language in auto mode", () => {
    useWikiStore.getState().setOutputLanguage("auto")
    const directive = buildLanguageDirective("Xử lý nước thải là vấn đề quan trọng")
    expect(directive).toContain("Vietnamese")
  })

  it("uses an explicit Persian/Farsi prompt name", () => {
    useWikiStore.getState().setOutputLanguage("Persian")
    const directive = buildLanguageDirective()
    expect(directive).toContain("MANDATORY OUTPUT LANGUAGE: Persian (Farsi / فارسی)")
  })

  it("uses the explicit Czech prompt name", () => {
    useWikiStore.getState().setOutputLanguage("Czech")
    expect(buildLanguageDirective()).toContain("MANDATORY OUTPUT LANGUAGE: Czech / čeština")
  })

  it("uses the source as evidence without translating proper nouns", () => {
    useWikiStore.getState().setOutputLanguage("English")
    const directive = buildLanguageDirective()
    expect(directive).toContain("use it as evidence")
    expect(directive).toContain("proper nouns and technical identifiers")
  })
})

describe("buildLanguageReminder", () => {
  it("is a concise reminder, not a full directive", () => {
    useWikiStore.getState().setOutputLanguage("Chinese")
    const reminder = buildLanguageReminder()
    expect(reminder).toMatch(/Write prose in Chinese/)
    expect(reminder).toContain("preserve names")
    expect(reminder).not.toContain("Do not use any other language")
    // Reminder should be ONE line, not a multi-line block
    expect(reminder.split("\n").length).toBe(1)
  })

  it("uses the explicit setting", () => {
    useWikiStore.getState().setOutputLanguage("Korean")
    expect(buildLanguageReminder("ignored fallback")).toContain("Korean")
  })

  it("uses detected language in auto mode", () => {
    useWikiStore.getState().setOutputLanguage("auto")
    expect(buildLanguageReminder("これは日本語です")).toContain("Japanese")
  })

  it("reminds Persian as Persian/Farsi", () => {
    useWikiStore.getState().setOutputLanguage("Persian")
    expect(buildLanguageReminder()).toContain("Persian (Farsi / فارسی)")
  })
})

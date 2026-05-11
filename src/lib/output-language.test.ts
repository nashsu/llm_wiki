import { describe, it, expect, beforeEach } from "vitest"
import {
  CHINESE_PRESERVE_ENGLISH_MODE,
  getOutputLanguage,
  buildLanguageDirective,
  buildLanguageReminder,
} from "./output-language"
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

  it("uses the explicit Chinese-first mixed mode verbatim", () => {
    useWikiStore.getState().setOutputLanguage(CHINESE_PRESERVE_ENGLISH_MODE)
    expect(getOutputLanguage("This is clearly English text")).toBe(CHINESE_PRESERVE_ENGLISH_MODE)
  })

  it("auto mode falls back to detectLanguage on the fallback text", () => {
    useWikiStore.getState().setOutputLanguage("auto")
    expect(getOutputLanguage("注意力机制是什么")).toBe("Chinese")
  })

  it("auto mode detects Persian separately from Arabic", () => {
    useWikiStore.getState().setOutputLanguage("auto")
    expect(getOutputLanguage("پردازش زبان طبیعی در فارسی کاربردهای زیادی دارد")).toBe("Persian")
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

  it("names the language multiple times for emphasis", () => {
    useWikiStore.getState().setOutputLanguage("Japanese")
    const directive = buildLanguageDirective()
    // Should include 'Japanese' at least 4× (header + instructions)
    const count = (directive.match(/Japanese/g) || []).length
    expect(count).toBeGreaterThanOrEqual(4)
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

  it("builds a Chinese-first mixed directive that preserves English terms", () => {
    useWikiStore.getState().setOutputLanguage(CHINESE_PRESERVE_ENGLISH_MODE)
    const directive = buildLanguageDirective("Transformer attention")
    expect(directive).toContain("MANDATORY OUTPUT MODE: Chinese-first with preserved English technical terms")
    expect(directive).toContain("Write the main narrative in **Simplified Chinese**.")
    expect(directive).toContain("Preserve necessary English terms instead of translating them away")
    expect(directive).toContain("Do NOT drift into a third language such as Korean, French, Arabic, or others")
  })

  it("explicitly overrides source content language", () => {
    useWikiStore.getState().setOutputLanguage("English")
    const directive = buildLanguageDirective()
    expect(directive).toContain("IRRELEVANT to your output language")
  })
})

describe("buildLanguageReminder", () => {
  it("is a concise reminder, not a full directive", () => {
    useWikiStore.getState().setOutputLanguage("Chinese")
    const reminder = buildLanguageReminder()
    expect(reminder).toMatch(/All output must be in Chinese/)
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

  it("uses a Chinese-first mixed reminder without third-language drift", () => {
    useWikiStore.getState().setOutputLanguage(CHINESE_PRESERVE_ENGLISH_MODE)
    const reminder = buildLanguageReminder("ignored fallback")
    expect(reminder).toContain("Use Simplified Chinese as the main language")
    expect(reminder).toContain("preserve necessary English technical terms")
    expect(reminder).toContain("do not drift into a third language")
  })

  it("reminds Persian as Persian/Farsi", () => {
    useWikiStore.getState().setOutputLanguage("Persian")
    expect(buildLanguageReminder()).toContain("Persian (Farsi / فارسی)")
  })
})

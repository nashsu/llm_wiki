// Server-side tests for ingest/language.js (ported for issue #14's P0
// server-driven ingest cutover).
//
// Assertions ported from the client suites:
//   - src/lib/detect-language.test.ts
//   - src/lib/detect-language.property.test.ts (fast-check replaced with a
//     deterministic seeded loop — fast-check is not a dependency of
//     @llm-wiki/server; the asserted properties are unchanged)
//   - src/lib/language-metadata.test.ts
//   - src/lib/output-language.test.ts (the Zustand store plumbing is dropped:
//     instead of useWikiStore.getState().setOutputLanguage(x), the setting
//     value x is passed as the first parameter of the ported functions)

import { describe, it, expect } from "vitest"
import {
  detectLanguage,
  getLanguagePromptName,
  getTextDirection,
  getHtmlLang,
  sameScriptFamily,
  getOutputLanguage,
  buildLanguageDirective,
  buildLanguageReminder,
} from "../src/ingest/language.js"

describe("detectLanguage", () => {
  describe("defaults", () => {
    it("returns English for empty string", () => {
      expect(detectLanguage("")).toBe("English")
    })

    it("returns English for pure ASCII without language clues", () => {
      expect(detectLanguage("abc xyz 123")).toBe("English")
    })
  })

  describe("non-Latin scripts", () => {
    it("detects Chinese (CJK Unified Ideographs)", () => {
      expect(detectLanguage("注意力机制是什么")).toBe("Chinese")
    })

    it("detects Japanese (Hiragana)", () => {
      expect(detectLanguage("これはテストです")).toBe("Japanese")
    })

    it("detects Korean (Hangul)", () => {
      expect(detectLanguage("안녕하세요")).toBe("Korean")
    })

    it("detects Arabic", () => {
      expect(detectLanguage("مرحبا بالعالم")).toBe("Arabic")
    })

    it("detects Persian via Persian-specific letters and words", () => {
      expect(detectLanguage("سلام دنیا، این یک متن فارسی برای آزمایش است")).toBe("Persian")
    })

    it("keeps Arabic distinct from Persian", () => {
      expect(detectLanguage("اللغة العربية مهمة في العالم")).toBe("Arabic")
    })

    it("keeps ambiguous short Arabic-script snippets conservative", () => {
      expect(detectLanguage("سلام")).toBe("Arabic")
    })

    it("detects Thai", () => {
      expect(detectLanguage("สวัสดีครับ")).toBe("Thai")
    })

    it("detects Hindi (Devanagari)", () => {
      expect(detectLanguage("नमस्ते दुनिया")).toBe("Hindi")
    })

    it("detects Russian (Cyrillic)", () => {
      expect(detectLanguage("привет мир")).toBe("Russian")
    })

    it("detects Greek", () => {
      expect(detectLanguage("Γειά σου κόσμε")).toBe("Greek")
    })

    it("requires at least 2 non-Latin chars to commit", () => {
      // Single CJK char alone falls through to Latin detection, then English
      expect(detectLanguage("x中")).toBe("English")
    })

    it("picks the dominant script when mixed", () => {
      // Mostly Chinese with a few English words
      expect(detectLanguage("机器学习 machine learning 深度学习 神经网络")).toBe("Chinese")
    })
  })

  describe("Latin-script languages", () => {
    it("detects Vietnamese via hook mark (ử, ả)", () => {
      expect(detectLanguage("Xử lý nước thải")).toBe("Vietnamese")
    })

    it("detects Vietnamese via tone-combination marks (ệ, ớ)", () => {
      expect(detectLanguage("Việt Nam là một quốc gia xinh đẹp")).toBe("Vietnamese")
    })

    it("detects Czech without treating its shared ó as Polish", () => {
      expect(detectLanguage("Příliš žluťoučký kůň úpěl ďábelské ódy")).toBe("Czech")
    })

    it("detects French via word patterns (no shared diacritics)", () => {
      expect(detectLanguage("le chat noir et les chiens blancs, un homme et une femme")).toBe("French")
    })

    it("detects French via its own diacritics (é, è, ê, à)", () => {
      // Regression guard: these chars must NOT be misclassified as Vietnamese.
      expect(detectLanguage("le chat est là, les étudiants préfèrent le café")).toBe("French")
    })

    it("detects German via word patterns", () => {
      expect(detectLanguage("der Hund und die Katze sind nicht das Problem")).toBe("German")
    })

    it("detects Spanish via word patterns", () => {
      expect(detectLanguage("el nino y los libros del colegio que son para todos")).toBe("Spanish")
    })

    it("detects Polish via diacritics", () => {
      expect(detectLanguage("dzień dobry świat")).toBe("Polish")
    })

    it("detects Portuguese with ã / ç (regression: no longer misclassified as VN)", () => {
      expect(detectLanguage("o coração do Brasil é um lugar de paz e que encanta")).toBe("Portuguese")
    })
  })

  describe("edge cases", () => {
    it("ignores plain ASCII digits and punctuation", () => {
      expect(detectLanguage("123 !@#$")).toBe("English")
    })

    it("handles very long pure-ASCII strings", () => {
      expect(detectLanguage("a".repeat(10000))).toBe("English")
    })
  })
})

describe("detectLanguage — properties", () => {
  // Deterministic stand-in for fast-check: a small seeded LCG so the suite is
  // reproducible. The asserted properties are the ones from
  // detect-language.property.test.ts.
  let seed = 0x2f6e2b1
  const rand = () => {
    // Park–Miller-ish LCG, good enough for test sampling
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0
    return seed / 0x100000000
  }
  const randInt = (min, max) => min + Math.floor(rand() * (max - min + 1))

  it("pure ASCII random text returns some known Latin-script language name", () => {
    const knownLatin = new Set([
      "English", "French", "German", "Spanish", "Portuguese",
      "Italian", "Dutch", "Swedish", "Norwegian", "Danish",
      "Finnish", "Indonesian", "Swahili", "Polish", "Czech",
      "Romanian", "Hungarian", "Vietnamese", "Turkish",
    ])
    for (let i = 0; i < 100; i++) {
      const len = randInt(0, 200)
      let input = ""
      for (let j = 0; j < len; j++) input += String.fromCharCode(randInt(0x20, 0x7e))
      const lang = detectLanguage(input)
      // ASCII-only input may hit French/German/Spanish/Dutch/etc. heuristics
      // if it contains those trigger words. But for truly random strings,
      // hits are rare. We assert the weaker property: the result is SOME
      // known Latin-script language name.
      expect(knownLatin.has(lang)).toBe(true)
    }
  })

  it("2+ CJK characters yield Chinese", () => {
    for (let i = 0; i < 100; i++) {
      const len = randInt(2, 50)
      const text = Array.from({ length: len }, () => String.fromCodePoint(randInt(0x4e00, 0x9fff))).join("")
      expect(detectLanguage(text)).toBe("Chinese")
    }
  })

  it("2+ Hiragana characters yield Japanese", () => {
    for (let i = 0; i < 100; i++) {
      const len = randInt(2, 50)
      const text = Array.from({ length: len }, () => String.fromCodePoint(randInt(0x3041, 0x3096))).join("")
      expect(detectLanguage(text)).toBe("Japanese")
    }
  })

  it("2+ Hangul characters yield Korean", () => {
    for (let i = 0; i < 100; i++) {
      const len = randInt(2, 50)
      const text = Array.from({ length: len }, () => String.fromCodePoint(randInt(0xac00, 0xd7af))).join("")
      expect(detectLanguage(text)).toBe("Korean")
    }
  })

  it("never throws on arbitrary strings", () => {
    const samples = [
      "",
      "a",
      "abc",
      "中文",
      "こんにちは",
      "\ud800", // lone surrogate
      "\udc00", // lone surrogate
      "\u{10ffff}",
      "\u{20000}", // CJK Extension B
      "🎉🔥💯",
      " mixed 中文 and English and 123 !@# ",
    ]
    for (const s of samples) {
      expect(() => detectLanguage(s)).not.toThrow()
    }
    for (let i = 0; i < 100; i++) {
      const len = randInt(0, 60)
      let input = ""
      for (let j = 0; j < len; j++) input += String.fromCharCode(randInt(0, 0xffff))
      expect(() => detectLanguage(input)).not.toThrow()
    }
  })
})

describe("language metadata", () => {
  it("marks Persian as RTL Farsi for rendering and prompts", () => {
    expect(getLanguagePromptName("Persian")).toBe("Persian (Farsi / فارسی)")
    expect(getTextDirection("Persian")).toBe("rtl")
    expect(getHtmlLang("Persian")).toBe("fa")
  })

  it("keeps Persian and Arabic in the same script family", () => {
    expect(sameScriptFamily("Persian", "Arabic")).toBe(true)
  })

  it("provides Czech rendering and prompt metadata", () => {
    expect(getLanguagePromptName("Czech")).toBe("Czech / čeština")
    expect(getTextDirection("Czech")).toBe("ltr")
    expect(getHtmlLang("Czech")).toBe("cs")
    expect(sameScriptFamily("Czech", "English")).toBe(true)
  })

  it("defaults unknown languages to LTR with the original prompt name", () => {
    expect(getLanguagePromptName("Vietnamese")).toBe("Vietnamese")
    expect(getTextDirection("Vietnamese")).toBe("ltr")
  })

  it("sameScriptFamily covers CJK vs latin vs other", () => {
    expect(sameScriptFamily("Chinese", "Japanese")).toBe(true)
    expect(sameScriptFamily("Japanese", "Korean")).toBe(true)
    expect(sameScriptFamily("Chinese", "English")).toBe(false)
    expect(sameScriptFamily("English", "Vietnamese")).toBe(true)
    expect(sameScriptFamily("Hebrew", "English")).toBe(false)
    // Unknown languages default to the "latin" family.
    expect(sameScriptFamily("Vietnamese", "English")).toBe(true)
    expect(sameScriptFamily("", "")).toBe(true)
  })
})

describe("getOutputLanguage", () => {
  it("uses the explicit user setting verbatim (Chinese)", () => {
    expect(getOutputLanguage("Chinese", "whatever fallback text")).toBe("Chinese")
  })

  it("explicit user setting beats fallback detection (source is English, setting is Japanese)", () => {
    expect(getOutputLanguage("Japanese", "This is clearly English text")).toBe("Japanese")
  })

  it("auto mode falls back to detectLanguage on the fallback text", () => {
    expect(getOutputLanguage("auto", "注意力机制是什么")).toBe("Chinese")
  })

  it("auto mode detects Persian separately from Arabic", () => {
    expect(getOutputLanguage("auto", "پردازش زبان طبیعی در فارسی کاربردهای زیادی دارد")).toBe("Persian")
  })

  it("supports Czech as both an explicit and auto-detected output language", () => {
    expect(getOutputLanguage("Czech", "English fallback text")).toBe("Czech")
    expect(getOutputLanguage("auto", "Příliš žluťoučký kůň úpěl ďábelské ódy")).toBe("Czech")
  })

  it("auto mode with empty fallback defaults to English", () => {
    expect(getOutputLanguage("auto", "")).toBe("English")
  })

  it("auto mode with no fallback arg defaults to English", () => {
    expect(getOutputLanguage("auto")).toBe("English")
  })
})

describe("buildLanguageDirective", () => {
  it("focused: zh setting", () => {
    const directive = buildLanguageDirective("Chinese")
    expect(directive).toContain("MANDATORY OUTPUT LANGUAGE: Chinese")
  })

  it("focused: en setting", () => {
    const directive = buildLanguageDirective("English")
    expect(directive).toContain("MANDATORY OUTPUT LANGUAGE: English")
  })

  it("focused: empty setting behaves like auto (detects from fallback, defaults to English)", () => {
    // The client treats a falsy configured value as auto:
    // `if (configured && configured !== "auto")`.
    expect(buildLanguageDirective("")).toContain("MANDATORY OUTPUT LANGUAGE: English")
    expect(buildLanguageDirective("", "注意力机制是什么")).toContain("MANDATORY OUTPUT LANGUAGE: Chinese")
    expect(buildLanguageDirective(undefined)).toContain("MANDATORY OUTPUT LANGUAGE: English")
  })

  it("contains the MANDATORY OUTPUT LANGUAGE header", () => {
    const directive = buildLanguageDirective("Chinese")
    expect(directive).toContain("MANDATORY OUTPUT LANGUAGE: Chinese")
  })

  it("keeps the target prose language prominent without requiring proper noun translation", () => {
    const directive = buildLanguageDirective("Japanese")
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
    const directive = buildLanguageDirective("Vietnamese", "这段文字是中文")
    expect(directive).toContain("Vietnamese")
    expect(directive).not.toContain("MANDATORY OUTPUT LANGUAGE: Chinese")
  })

  it("uses detected language in auto mode", () => {
    const directive = buildLanguageDirective("auto", "Xử lý nước thải là vấn đề quan trọng")
    expect(directive).toContain("Vietnamese")
  })

  it("uses an explicit Persian/Farsi prompt name", () => {
    const directive = buildLanguageDirective("Persian")
    expect(directive).toContain("MANDATORY OUTPUT LANGUAGE: Persian (Farsi / فارسی)")
  })

  it("uses the explicit Czech prompt name", () => {
    expect(buildLanguageDirective("Czech")).toContain("MANDATORY OUTPUT LANGUAGE: Czech / čeština")
  })

  it("uses the source as evidence without translating proper nouns", () => {
    const directive = buildLanguageDirective("English")
    expect(directive).toContain("use it as evidence")
    expect(directive).toContain("proper nouns and technical identifiers")
  })
})

describe("buildLanguageReminder", () => {
  it("is a concise reminder, not a full directive", () => {
    const reminder = buildLanguageReminder("Chinese")
    expect(reminder).toMatch(/Write prose in Chinese/)
    expect(reminder).toContain("preserve names")
    expect(reminder).not.toContain("Do not use any other language")
    // Reminder should be ONE line, not a multi-line block
    expect(reminder.split("\n").length).toBe(1)
  })

  it("uses the explicit setting", () => {
    expect(buildLanguageReminder("Korean", "ignored fallback")).toContain("Korean")
  })

  it("uses detected language in auto mode", () => {
    expect(buildLanguageReminder("auto", "これは日本語です")).toContain("Japanese")
  })

  it("reminds Persian as Persian/Farsi", () => {
    expect(buildLanguageReminder("Persian")).toContain("Persian (Farsi / فارسی)")
  })
})

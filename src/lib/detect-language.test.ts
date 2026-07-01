import { describe, it, expect } from "vitest"
import { detectLanguage } from "./detect-language"

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

/**
 * Detect the primary language of a text string based on Unicode script ranges.
 * Supports 20+ major languages. Returns an English language name.
 */
export function detectLanguage(text: string): string {
  // Count characters in each script range
  const counts: Record<string, number> = {}

  for (const ch of text) {
    const cp = ch.codePointAt(0)
    if (!cp || cp < 0x80) continue // skip ASCII initially

    const script = getScript(cp)
    if (script) {
      counts[script] = (counts[script] ?? 0) + 1
    }
  }

  // Special case: Japanese uses BOTH Hiragana/Katakana and Kanji. Pure
  // Chinese uses ONLY Kanji. If we see any Japanese script characters at
  // all alongside Kanji, the language is Japanese, regardless of which
  // count dominates. (Kanji-heavy Japanese text would otherwise be
  // misclassified as Chinese.)
  if ((counts.Japanese ?? 0) > 0 && (counts.Chinese ?? 0) > 0) {
    return "Japanese"
  }

  // If non-Latin scripts detected, return the dominant one
  let maxScript = ""
  let maxCount = 0
  for (const [script, count] of Object.entries(counts)) {
    if (count > maxCount) {
      maxScript = script
      maxCount = count
    }
  }

  if (maxScript === "Arabic" && maxCount >= 2) {
    return detectArabicScriptLanguage(text)
  }

  if (maxScript && maxCount >= 2) {
    return maxScript
  }

  // For Latin-script languages, use diacritics and common word patterns
  const latinLang = detectLatinLanguage(text)
  if (latinLang) return latinLang

  return "English"
}

function detectArabicScriptLanguage(text: string): "Arabic" | "Persian" {
  let persianScore = 0
  let arabicScore = 0

  for (const ch of text) {
    switch (ch) {
      case "پ":
      case "چ":
      case "ژ":
      case "گ":
        persianScore += 3
        break
      case "ک":
      case "ی":
        persianScore += 1
        break
      case "ك":
      case "ي":
      case "ة":
      case "ى":
      case "إ":
      case "أ":
      case "ؤ":
      case "ئ":
        arabicScore += 1
        break
    }
  }

  const normalized = ` ${text.replace(/[^\p{L}\p{N}]+/gu, " ")} `
  const persianWords = [
    "این",
    "است",
    "که",
    "برای",
    "های",
    "را",
    "در",
    "به",
    "از",
    "می",
    "یک",
  ]
  const arabicWords = [
    "ال",
    "في",
    "من",
    "على",
    "هذا",
    "هذه",
    "إلى",
    "التي",
    "الذي",
    "كان",
  ]

  for (const word of persianWords) {
    if (normalized.includes(` ${word} `)) persianScore += 2
  }
  for (const word of arabicWords) {
    if (normalized.includes(` ${word} `)) arabicScore += 2
  }

  // Be conservative: Persian has reliable orthographic clues, but short
  // Arabic-script snippets can be ambiguous. Fall back to Arabic unless the
  // Persian signal is clearly stronger.
  return persianScore >= 3 && persianScore > arabicScore ? "Persian" : "Arabic"
}

function getScript(cp: number): string | null {
  // CJK Unified Ideographs (Chinese/Japanese Kanji)
  if ((cp >= 0x4E00 && cp <= 0x9FFF) || (cp >= 0x3400 && cp <= 0x4DBF) ||
      (cp >= 0x20000 && cp <= 0x2A6DF) || (cp >= 0xF900 && cp <= 0xFAFF)) {
    return "Chinese"
  }
  // Japanese Hiragana + Katakana
  if ((cp >= 0x3040 && cp <= 0x309F) || (cp >= 0x30A0 && cp <= 0x30FF) ||
      (cp >= 0x31F0 && cp <= 0x31FF) || (cp >= 0xFF65 && cp <= 0xFF9F)) {
    return "Japanese"
  }
  // Korean Hangul
  if ((cp >= 0xAC00 && cp <= 0xD7AF) || (cp >= 0x1100 && cp <= 0x11FF) ||
      (cp >= 0x3130 && cp <= 0x318F)) {
    return "Korean"
  }
  // Arabic
  if ((cp >= 0x0600 && cp <= 0x06FF) || (cp >= 0x0750 && cp <= 0x077F) ||
      (cp >= 0x08A0 && cp <= 0x08FF) || (cp >= 0xFB50 && cp <= 0xFDFF) ||
      (cp >= 0xFE70 && cp <= 0xFEFF)) {
    return "Arabic"
  }
  // Hebrew
  if ((cp >= 0x0590 && cp <= 0x05FF) || (cp >= 0xFB1D && cp <= 0xFB4F)) {
    return "Hebrew"
  }
  // Thai
  if (cp >= 0x0E00 && cp <= 0x0E7F) {
    return "Thai"
  }
  // Devanagari (Hindi, Sanskrit, Marathi, Nepali)
  if (cp >= 0x0900 && cp <= 0x097F) {
    return "Hindi"
  }
  // Bengali
  if (cp >= 0x0980 && cp <= 0x09FF) {
    return "Bengali"
  }
  // Tamil
  if (cp >= 0x0B80 && cp <= 0x0BFF) {
    return "Tamil"
  }
  // Telugu
  if (cp >= 0x0C00 && cp <= 0x0C7F) {
    return "Telugu"
  }
  // Kannada
  if (cp >= 0x0C80 && cp <= 0x0CFF) {
    return "Kannada"
  }
  // Malayalam
  if (cp >= 0x0D00 && cp <= 0x0D7F) {
    return "Malayalam"
  }
  // Gujarati
  if (cp >= 0x0A80 && cp <= 0x0AFF) {
    return "Gujarati"
  }
  // Gurmukhi (Punjabi)
  if (cp >= 0x0A00 && cp <= 0x0A7F) {
    return "Punjabi"
  }
  // Myanmar (Burmese)
  if (cp >= 0x1000 && cp <= 0x109F) {
    return "Burmese"
  }
  // Khmer (Cambodian)
  if (cp >= 0x1780 && cp <= 0x17FF) {
    return "Khmer"
  }
  // Lao
  if (cp >= 0x0E80 && cp <= 0x0EFF) {
    return "Lao"
  }
  // Georgian
  if ((cp >= 0x10A0 && cp <= 0x10FF) || (cp >= 0x2D00 && cp <= 0x2D2F)) {
    return "Georgian"
  }
  // Armenian
  if (cp >= 0x0530 && cp <= 0x058F) {
    return "Armenian"
  }
  // Ethiopic (Amharic)
  if (cp >= 0x1200 && cp <= 0x137F) {
    return "Amharic"
  }
  // Tibetan
  if (cp >= 0x0F00 && cp <= 0x0FFF) {
    return "Tibetan"
  }
  // Sinhala
  if (cp >= 0x0D80 && cp <= 0x0DFF) {
    return "Sinhala"
  }
  // Cyrillic (Russian, Ukrainian, Bulgarian, etc.)
  if ((cp >= 0x0400 && cp <= 0x04FF) || (cp >= 0x0500 && cp <= 0x052F)) {
    return "Russian" // default Cyrillic to Russian; refined below
  }
  // Greek
  if ((cp >= 0x0370 && cp <= 0x03FF) || (cp >= 0x1F00 && cp <= 0x1FFF)) {
    return "Greek"
  }

  return null
}

/**
 * Detect Latin-script languages via diacritics and common word patterns.
 */
function detectLatinLanguage(text: string): string | null {
  const lower = text.toLowerCase()

  // Vietnamese — VN-EXCLUSIVE tone/hook marks only.
  // Earlier versions included shared Latin diacritics (à á â ã è é ê ì í ò ó ô õ
  // ù ú ă ý) which made any French / Portuguese / Spanish / Italian / Romanian
  // text with common diacritics false-positive as Vietnamese. The chars below
  // are Vietnamese-specific tone/hook/horn composites that don't appear in
  // other major languages detected here.
  if (/[ảạắằẳẵặấầẩẫậđẻẽẹếềểễệỉĩịỏọốồổỗộơớờởỡợủũụưứừửữựỷỹỵ]/.test(lower)) {
    return "Vietnamese"
  }

  // Turkish — require Turkish-unique chars (ğ, ı dotless, ş). Earlier versions
  // also matched ç/ö/ü, which are shared with French/German/Portuguese/Hungarian
  // and caused false positives on PT text like "coração".
  if (/[ğış]/.test(lower) && /\b(bir|ve|için|ile|bu|da|de|değil|ama)\b/.test(lower)) {
    return "Turkish"
  }

  // Polish — distinctive characters
  if (/[ąćęłńóśźż]/.test(lower)) {
    return "Polish"
  }

  // Czech/Slovak — háčky and čárky
  if (/[ěšžřďťňů]/.test(lower)) {
    return "Czech"
  }

  // Romanian — distinctive characters
  if (/[ăâîșț]/.test(lower) && /\b(și|este|sau|care|pentru)\b/.test(lower)) {
    return "Romanian"
  }

  // Hungarian — double acute accents
  if (/[őű]/.test(lower)) {
    return "Hungarian"
  }

  // German — common patterns
  if (/[äöüß]/.test(lower) || /\b(und|der|die|das|ist|nicht|ein|eine)\b/.test(lower)) {
    if (/\b(und|der|die|das|ist)\b/.test(lower)) return "German"
  }

  // French — common patterns
  if (/[àâçéèêëïîôùûüÿœæ]/.test(lower) || /\b(le|la|les|de|des|est|et|un|une|du|au)\b/.test(lower)) {
    if (/\b(le|la|les|est|une|des)\b/.test(lower)) return "French"
  }

  // Portuguese — must run BEFORE Spanish: PT has stricter char requirements
  // ([ãõç]) than ES, and their common-word sets overlap heavily (`que`, `de`,
  // `um`, etc.). Running ES first steals legitimate PT text.
  if (/[ãõç]/.test(lower) && /\b(o|a|os|as|de|do|da|é|em|um|uma|não|que)\b/.test(lower)) {
    return "Portuguese"
  }

  // Spanish — common patterns. The stage-2 word set is intentionally narrow
  // (words NOT shared with Portuguese): del/por/las/ñ-bearing/inverted-punct.
  if (/[áéíóúñ¿¡]/.test(lower) || /\b(el|la|los|las|de|del|es|en|por|que|un|una)\b/.test(lower)) {
    if (/\b(el|los|las|del|por)\b/.test(lower) || /[ñ¿¡]/.test(lower)) return "Spanish"
  }

  // Italian — common patterns
  if (/\b(il|lo|la|gli|le|di|del|della|è|e|un|una|che|non|per)\b/.test(lower)) {
    if (/\b(il|della|gli|che|è)\b/.test(lower)) return "Italian"
  }

  // Dutch — common patterns
  if (/\b(het|de|een|van|en|in|is|dat|op|te|met)\b/.test(lower)) {
    if (/\b(het|een|van|dat)\b/.test(lower)) return "Dutch"
  }

  // Swedish — common patterns
  if (/[åäö]/.test(lower) && /\b(och|att|det|en|ett|är|för|med)\b/.test(lower)) {
    return "Swedish"
  }

  // Norwegian — common patterns
  if (/[åæø]/.test(lower) && /\b(og|er|det|en|et|for|med|på)\b/.test(lower)) {
    return "Norwegian"
  }

  // Danish — similar to Norwegian
  if (/[åæø]/.test(lower) && /\b(og|er|det|en|et|til|med|af)\b/.test(lower)) {
    return "Danish"
  }

  // Finnish — common patterns
  if (/[äö]/.test(lower) && /\b(ja|on|ei|se|että|tai|kun|niin)\b/.test(lower)) {
    return "Finnish"
  }

  // Indonesian/Malay — common patterns
  if (/\b(dan|yang|di|dari|untuk|dengan|ini|itu|adalah|tidak|ada)\b/.test(lower)) {
    if (/\b(yang|dari|untuk|dengan|adalah)\b/.test(lower)) return "Indonesian"
  }

  // Swahili — common patterns
  if (/\b(na|ya|wa|ni|kwa|katika|hii|hiyo)\b/.test(lower)) {
    return "Swahili"
  }

  return null
}

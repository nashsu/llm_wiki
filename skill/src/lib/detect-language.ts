/**
 * Language detection — ported from nashsu/llm_wiki src/lib/detect-language.ts
 * Pure function, no external dependencies.
 */
export function detectLanguage(text: string): string {
  const counts: Record<string, number> = {}
  for (const ch of text) {
    const cp = ch.codePointAt(0)
    if (!cp || cp < 0x80) continue
    const script = getScript(cp)
    if (script) counts[script] = (counts[script] ?? 0) + 1
  }

  if ((counts.Japanese ?? 0) > 0 && (counts.Chinese ?? 0) > 0) return "Japanese"

  let maxScript = ""; let maxCount = 0
  for (const [script, count] of Object.entries(counts)) {
    if (count > maxCount) { maxScript = script; maxCount = count }
  }
  if (maxScript && maxCount >= 2) return maxScript

  const latinLang = detectLatinLanguage(text)
  if (latinLang) return latinLang
  return "English"
}

function getScript(cp: number): string | null {
  if ((cp >= 0x4E00 && cp <= 0x9FFF) || (cp >= 0x3400 && cp <= 0x4DBF) || (cp >= 0x20000 && cp <= 0x2A6DF) || (cp >= 0xF900 && cp <= 0xFAFF)) return "Chinese"
  if ((cp >= 0x3040 && cp <= 0x309F) || (cp >= 0x30A0 && cp <= 0x30FF) || (cp >= 0x31F0 && cp <= 0x31FF) || (cp >= 0xFF65 && cp <= 0xFF9F)) return "Japanese"
  if ((cp >= 0xAC00 && cp <= 0xD7AF) || (cp >= 0x1100 && cp <= 0x11FF) || (cp >= 0x3130 && cp <= 0x318F)) return "Korean"
  if ((cp >= 0x0600 && cp <= 0x06FF) || (cp >= 0x0750 && cp <= 0x077F) || (cp >= 0x08A0 && cp <= 0x08FF) || (cp >= 0xFB50 && cp <= 0xFDFF) || (cp >= 0xFE70 && cp <= 0xFEFF)) return "Arabic"
  if ((cp >= 0x0590 && cp <= 0x05FF) || (cp >= 0xFB1D && cp <= 0xFB4F)) return "Hebrew"
  if (cp >= 0x0E00 && cp <= 0x0E7F) return "Thai"
  if (cp >= 0x0900 && cp <= 0x097F) return "Hindi"
  if ((cp >= 0x0400 && cp <= 0x04FF) || (cp >= 0x0500 && cp <= 0x052F)) return "Russian"
  if ((cp >= 0x0370 && cp <= 0x03FF) || (cp >= 0x1F00 && cp <= 0x1FFF)) return "Greek"
  return null
}

function detectLatinLanguage(text: string): string | null {
  const lower = text.toLowerCase()
  if (/[ảạắằẳẵặấầẩẫậđẻẽẹếềểễệỉĩịỏọốồổỗộơớờởỡợủũụưứừửữựỷỹỵ]/.test(lower)) return "Vietnamese"
  if (/[ğış]/.test(lower) && /\b(bir|ve|için|ile|bu|da|de|değil|ama)\b/.test(lower)) return "Turkish"
  if (/[ąćęłńóśźż]/.test(lower)) return "Polish"
  if (/[ěšžřďťňů]/.test(lower)) return "Czech"
  if (/[äöüß]/.test(lower) && /\b(und|der|die|das|ist)\b/.test(lower)) return "German"
  if (/[àâçéèêëïîôùûüÿœæ]/.test(lower) && /\b(le|la|les|est|une|des)\b/.test(lower)) return "French"
  if (/[ãõç]/.test(lower) && /\b(o|a|os|as|de|do|da|é|em|um|uma|não|que)\b/.test(lower)) return "Portuguese"
  if ((/[áéíóúñ¿¡]/.test(lower) || /\b(el|la|los|las|de|del|es|en)\b/.test(lower)) && (/\b(el|los|las|del|por)\b/.test(lower) || /[ñ¿¡]/.test(lower))) return "Spanish"
  if (/\b(il|della|gli|che|è)\b/.test(lower)) return "Italian"
  return null
}

import { useWikiStore } from "@/stores/wiki-store"
import { detectLanguage } from "./detect-language"
import { getLanguagePromptName } from "./language-metadata"

export const CHINESE_PRESERVE_ENGLISH_MODE = "Chinese (preserve English terms)" as const

/**
 * Get the effective output language for LLM content generation.
 *
 * If user has explicitly set an outputLanguage, use it.
 * Otherwise (auto), fall back to detecting the language from the given text.
 */
export function getOutputLanguage(fallbackText: string = ""): string {
  const configured = useWikiStore.getState().outputLanguage
  if (configured && configured !== "auto") {
    return configured
  }
  return detectLanguage(fallbackText || "English")
}

export function buildLanguageDirectiveFromLanguage(language: string): string {
  if (language === CHINESE_PRESERVE_ENGLISH_MODE) {
    return [
      "## ⚠️ MANDATORY OUTPUT MODE: Chinese-first with preserved English technical terms",
      "",
      "Write the main narrative in **Simplified Chinese**.",
      "Preserve necessary English terms instead of translating them away: technical terms, paper titles, model names, tool/API names, commands, code, paths, abbreviations, and cited source titles.",
      "For concepts commonly used in both Chinese and English, prefer the first mention as `中文（English）` when it reads naturally.",
      "Do NOT drift into a third language such as Korean, French, Arabic, or others unless the user explicitly asks for that language.",
      "Do not turn the whole response into English. Keep the overall response Chinese-first while preserving necessary English.",
      "This output mode overrides conflicting style preferences from source material.",
    ].join("\n")
  }

  const promptLang = getLanguagePromptName(language)
  return [
    `## ⚠️ MANDATORY OUTPUT LANGUAGE: ${promptLang}`,
    "",
    `You MUST write your entire response (including wiki page titles, content, descriptions, summaries, and any generated text) in **${promptLang}**.`,
    `The source material or wiki content may be in a different language, but this is IRRELEVANT to your output language.`,
    `Ignore the language of any source content. Generate everything in ${promptLang} only.`,
    `Proper nouns should use standard ${promptLang} transliteration when appropriate.`,
    `DO NOT use any other language. This overrides all other instructions.`,
  ].join("\n")
}

/**
 * Build a strong language directive to inject into system prompts.
 */
export function buildLanguageDirective(fallbackText: string = ""): string {
  return buildLanguageDirectiveFromLanguage(getOutputLanguage(fallbackText))
}

/**
 * Short reminder version — for placing right before user's current message.
 */
export function buildLanguageReminderFromLanguage(language: string): string {
  if (language === CHINESE_PRESERVE_ENGLISH_MODE) {
    return "REMINDER: Use Simplified Chinese as the main language, preserve necessary English technical terms/titles/code/commands, and do not drift into a third language."
  }
  return `REMINDER: All output must be in ${getLanguagePromptName(language)}. Do not use any other language.`
}

export function buildLanguageReminder(fallbackText: string = ""): string {
  return buildLanguageReminderFromLanguage(getOutputLanguage(fallbackText))
}

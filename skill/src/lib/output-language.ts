/**
 * Output language directive builder.
 * Ported from nashsu/llm_wiki — uses configurable language or auto-detection.
 */
import { detectLanguage } from "./detect-language"

export function getOutputLanguage(fallbackText: string = ""): string {
  const configured = process.env.WIKI_OUTPUT_LANGUAGE
  if (configured && configured !== "auto") return configured
  return detectLanguage(fallbackText || "English")
}

export function buildLanguageDirective(fallbackText: string = ""): string {
  const lang = getOutputLanguage(fallbackText)
  return [
    `## ⚠️ MANDATORY OUTPUT LANGUAGE: ${lang}`,
    "",
    `You MUST write your entire response in **${lang}**.`,
    `The source material may be in a different language, but generate everything in ${lang} only.`,
  ].join("\n")
}

export function buildLanguageReminder(fallbackText: string = ""): string {
  const lang = getOutputLanguage(fallbackText)
  return `REMINDER: All output must be in ${lang}.`
}

/**
 * Best-effort system-locale detection for language defaults on a fresh
 * install — before the user has ever picked a language explicitly.
 * `navigator.language` reflects the OS locale in a Tauri webview without
 * needing a native plugin.
 */
import type { OutputLanguage } from "@/lib/output-language-options"

/** UI languages that actually have a translation file (see src/i18n/index.ts). */
const SUPPORTED_UI_LANGUAGES = ["en", "it", "zh", "ru"] as const
export type SupportedUiLanguage = (typeof SUPPORTED_UI_LANGUAGES)[number]

/** ISO 639-1 subtag -> OUTPUT_LANGUAGE_OPTIONS value (src/lib/output-language-options.ts). */
const OUTPUT_LANGUAGE_BY_SUBTAG: Record<string, OutputLanguage> = {
  en: "English",
  zh: "Chinese",
  ja: "Japanese",
  ko: "Korean",
  vi: "Vietnamese",
  fr: "French",
  de: "German",
  es: "Spanish",
  pt: "Portuguese",
  it: "Italian",
  ru: "Russian",
  ar: "Arabic",
  fa: "Persian",
  hi: "Hindi",
  tr: "Turkish",
  nl: "Dutch",
  pl: "Polish",
  cs: "Czech",
  sv: "Swedish",
  id: "Indonesian",
  th: "Thai",
  uk: "Ukrainian",
}

function systemLocale(): string {
  return typeof navigator !== "undefined" && navigator.language ? navigator.language : ""
}

function subtag(locale: string): string {
  return locale.split("-")[0]?.toLowerCase() ?? ""
}

/** Falls back to "en" when the OS locale isn't one of the translated UI languages. */
export function detectSystemUiLanguage(): SupportedUiLanguage {
  const tag = subtag(systemLocale())
  return (SUPPORTED_UI_LANGUAGES as readonly string[]).includes(tag) ? (tag as SupportedUiLanguage) : "en"
}

/** Falls back to "auto" (detect from source content) when the OS locale has no clean mapping. */
export function detectSystemOutputLanguage(): OutputLanguage {
  const locale = systemLocale()
  if (/^zh-(hant|tw|hk)/i.test(locale)) return "Traditional Chinese"
  const tag = subtag(locale)
  return OUTPUT_LANGUAGE_BY_SUBTAG[tag] ?? "auto"
}

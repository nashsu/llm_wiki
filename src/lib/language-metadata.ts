export type TextDirection = "ltr" | "rtl"

interface LanguageMetadata {
  promptName: string
  htmlLang?: string
  direction: TextDirection
  scriptFamily: "arabic" | "cjk" | "latin" | "other"
}

const LANGUAGE_METADATA: Record<string, LanguageMetadata> = {
  English: {
    promptName: "English",
    htmlLang: "en",
    direction: "ltr",
    scriptFamily: "latin",
  },
  Arabic: {
    promptName: "Arabic / العربية",
    htmlLang: "ar",
    direction: "rtl",
    scriptFamily: "arabic",
  },
  Persian: {
    promptName: "Persian (Farsi / فارسی)",
    htmlLang: "fa",
    direction: "rtl",
    scriptFamily: "arabic",
  },
  Hebrew: {
    promptName: "Hebrew / עברית",
    htmlLang: "he",
    direction: "rtl",
    scriptFamily: "other",
  },
  Chinese: {
    promptName: "Chinese",
    htmlLang: "zh-Hans",
    direction: "ltr",
    scriptFamily: "cjk",
  },
  "Chinese (preserve English terms)": {
    promptName: "Chinese-first with preserved English technical terms",
    htmlLang: "zh-Hans",
    direction: "ltr",
    scriptFamily: "cjk",
  },
  "Traditional Chinese": {
    promptName: "Traditional Chinese",
    htmlLang: "zh-Hant",
    direction: "ltr",
    scriptFamily: "cjk",
  },
  Japanese: {
    promptName: "Japanese",
    htmlLang: "ja",
    direction: "ltr",
    scriptFamily: "cjk",
  },
  Korean: {
    promptName: "Korean",
    htmlLang: "ko",
    direction: "ltr",
    scriptFamily: "cjk",
  },
}

const DEFAULT_METADATA: LanguageMetadata = {
  promptName: "English",
  direction: "ltr",
  scriptFamily: "latin",
}

export function getLanguageMetadata(language: string): LanguageMetadata {
  return LANGUAGE_METADATA[language] ?? {
    ...DEFAULT_METADATA,
    promptName: language || DEFAULT_METADATA.promptName,
  }
}

export function getLanguagePromptName(language: string): string {
  return getLanguageMetadata(language).promptName
}

export function getTextDirection(language: string): TextDirection {
  return getLanguageMetadata(language).direction
}

export function getHtmlLang(language: string): string | undefined {
  return getLanguageMetadata(language).htmlLang
}

export function sameScriptFamily(a: string, b: string): boolean {
  return getLanguageMetadata(a).scriptFamily === getLanguageMetadata(b).scriptFamily
}

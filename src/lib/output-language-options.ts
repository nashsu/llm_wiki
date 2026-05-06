/**
 * Shared list of selectable output-language values for any UI that
 * needs to ask the user "what language should the AI generate in?".
 *
 * Currently consumed by:
 *   - Settings → Output: post-create change of the preference
 *   - Create-Project dialog: required choice at project creation
 *     time so a fresh project never starts in the implicit
 *     "auto-detect from whatever text we see first" mode
 *
 * `value` strings are the exact tokens the rest of the codebase
 * compares against (`OutputLanguage` type in stores/wiki-store.ts);
 * keep them in sync. Labels mix the native script + the English
 * name so a user who can't read the native form still recognizes
 * the language.
 */
export const OUTPUT_LANGUAGE_OPTIONS = [
  { value: "auto", label: "Auto (detect from input/source)" },
  { value: "English", label: "English" },
  { value: "Chinese", label: "简体中文 (Simplified Chinese)" },
  { value: "Traditional Chinese", label: "繁體中文 (Traditional Chinese)" },
  { value: "Japanese", label: "日本語 (Japanese)" },
  { value: "Korean", label: "한국어 (Korean)" },
  { value: "Vietnamese", label: "Tiếng Việt (Vietnamese)" },
  { value: "French", label: "Français (French)" },
  { value: "German", label: "Deutsch (German)" },
  { value: "Spanish", label: "Español (Spanish)" },
  { value: "Portuguese", label: "Português (Portuguese)" },
  { value: "Italian", label: "Italiano (Italian)" },
  { value: "Russian", label: "Русский (Russian)" },
  { value: "Arabic", label: "العربية (Arabic)" },
  { value: "Hindi", label: "हिन्दी (Hindi)" },
  { value: "Turkish", label: "Türkçe (Turkish)" },
  { value: "Dutch", label: "Nederlands (Dutch)" },
  { value: "Polish", label: "Polski (Polish)" },
  { value: "Swedish", label: "Svenska (Swedish)" },
  { value: "Indonesian", label: "Bahasa Indonesia (Indonesian)" },
  { value: "Thai", label: "ไทย (Thai)" },
  { value: "Ukrainian", label: "Українська (Ukrainian)" },
] as const

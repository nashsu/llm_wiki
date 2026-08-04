// Ingest prompt builders + token budgets (issue #14 P0 server-driven ingest).
//
// Ported VERBATIM from the client's src/lib/ingest.ts (prompt builders,
// token-budget constants, compute* helpers, semantic chunk splitting) plus
// the small pure helpers they depend on:
//   - src/lib/context-budget.ts  -> computeContextBudget (ported locally)
//   - src/lib/output-language.ts -> buildLanguageDirective (folded into
//     languageRule with the store read replaced by a parameter)
//   - src/lib/detect-language.ts + src/lib/language-metadata.ts (ported
//     locally, used by languageRule in "auto" mode)
//   - src/lib/path-utils.ts      -> normalizePath (ported locally)
//   - GENERATION_WIKI_TYPES from src/lib/wiki-page-types.ts (ported locally)
//
// DEVIATION (per porting rules): every builder whose client version called
// buildLanguageDirective() internally (which read useWikiStore.getState()
// .outputLanguage) now takes the finished language directive string as its
// FIRST parameter (`languageDirective`). The pipeline resolves outputLanguage
// from the shared store and builds the directive via languageRule() before
// calling these builders. Prompt text output is otherwise byte-identical.
//
// Plain JS ESM. No TypeScript, no build step. Do not import browser/Tauri
// modules here — this module is pure logic (no fs, no DB, no network).

// ── Token-budget constants (byte-identical to src/lib/ingest.ts) ────────────

export const LONG_SOURCE_MIN_BUDGET = 8_000
export const LONG_SOURCE_MAX_SINGLE_PASS_BUDGET = 300_000
export const LONG_SOURCE_CHUNK_MIN = 12_000
export const LONG_SOURCE_CHUNK_MAX = 60_000
export const LONG_SOURCE_DIGEST_MAX = 15_000
export const LONG_SOURCE_CHUNK_ANALYSIS_MAX = 40_000
export const INGEST_GENERATION_TOKENS_DEFAULT = 8_192
export const INGEST_GENERATION_TOKENS_128K = 16_384
export const INGEST_GENERATION_TOKENS_256K = 24_576
export const INGEST_GENERATION_TOKENS_512K = 32_768
export const REVIEW_STAGE_MIN_SIGNAL_CHARS = 10_000
export const REVIEW_STAGE_MIN_FILE_BLOCKS = 4
export const AGGREGATE_WIKI_PATHS = ["wiki/index.md", "wiki/overview.md", "wiki/log.md"]

// From src/lib/wiki-page-types.ts (GENERATION_WIKI_TYPES), used by
// buildGenerationPrompt's frontmatter rules.
export const GENERATION_WIKI_TYPES = [
  "source",
  "entity",
  "concept",
  "comparison",
  "query",
  "synthesis",
  "thesis",
  "methodology",
  "finding",
]

// ── Language metadata (ported from src/lib/language-metadata.ts) ────────────

const LANGUAGE_METADATA = {
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
  Czech: {
    promptName: "Czech / čeština",
    htmlLang: "cs",
    direction: "ltr",
    scriptFamily: "latin",
  },
}

const DEFAULT_METADATA = {
  promptName: "English",
  direction: "ltr",
  scriptFamily: "latin",
}

function getLanguageMetadata(language) {
  return LANGUAGE_METADATA[language] ?? {
    ...DEFAULT_METADATA,
    promptName: language || DEFAULT_METADATA.promptName,
  }
}

function getLanguagePromptName(language) {
  return getLanguageMetadata(language).promptName
}

// ── Language detection (ported from src/lib/detect-language.ts) ─────────────

/**
 * Detect the primary language of a text string based on Unicode script ranges.
 * Supports 20+ major languages. Returns an English language name.
 */
function detectLanguage(text) {
  // Count characters in each script range
  const counts = {}

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

function detectArabicScriptLanguage(text) {
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

function getScript(cp) {
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
function detectLatinLanguage(text) {
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

  // Polish — use characters that distinguish it from neighboring
  // Latin-script languages. `ó` is intentionally excluded because
  // Czech also uses it; treating `ó` alone as Polish prevented common
  // Czech text from ever reaching the Czech detector below.
  if (/[ąćęłńśźż]/.test(lower)) {
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

// ── languageRule (server form of buildLanguageDirective) ────────────────────

/**
 * Build the language rule for ingest prompts.
 *
 * Server equivalent of the client's `languageRule(sourceContent)` /
 * `buildLanguageDirective(fallbackText)` pair: the zustand store read
 * (`useWikiStore.getState().outputLanguage`) is replaced by the
 * `outputLanguage` PARAMETER (the pipeline resolves it from the shared
 * store). Uses the user's configured output language, falling back to
 * source content detection when it is "auto" / empty.
 */
export function languageRule(outputLanguage, sourceContent = "") {
  const lang = outputLanguage && outputLanguage !== "auto"
    ? outputLanguage
    : detectLanguage(sourceContent || "English")
  const promptLang = getLanguagePromptName(lang)
  return [
    `## ⚠️ MANDATORY OUTPUT LANGUAGE: ${promptLang}`,
    "",
    `Write surrounding natural-language prose in **${promptLang}**.`,
    `All generated prose, including prose titles and section headings, must be in ${promptLang}.`,
    `Do not translate, transliterate, or describe proper nouns and technical identifiers unless the source already uses a well-established localized form.`,
    `Preserve organization names, product names, model names, dataset names, tool/library names, acronyms, code identifiers, file names, URLs, paper titles, citation strings, and technical terms that have no widely-used localized equivalent in their standard original form.`,
    `The source material or wiki content may be in a different language; use it as evidence, but keep generated prose in ${promptLang}.`,
    `This language rule overrides weaker style instructions, but it does not override the proper-noun and technical-identifier preservation rule above.`,
  ].join("\n")
}

// ── Context budget (ported from src/lib/context-budget.ts) ──────────────────

const DEFAULT_MAX_CTX = 204_800
const RESPONSE_RESERVE_FRAC = 0.15
const INDEX_BUDGET_FRAC = 0.05
const PAGE_BUDGET_FRAC = 0.5
const PER_PAGE_FRAC = 0.3
const PER_PAGE_FLOOR = 5_000

/**
 * Compute character budgets from the LLM's max context window.
 *
 * Falsy `maxContextSize` (0 / NaN / undefined) falls back to the
 * pre-Phase-1 default of 200K chars so existing configs don't break.
 */
export function computeContextBudget(maxContextSize) {
  const maxCtx =
    typeof maxContextSize === "number" && maxContextSize > 0
      ? maxContextSize
      : DEFAULT_MAX_CTX

  const responseReserve = Math.floor(maxCtx * RESPONSE_RESERVE_FRAC)
  const indexBudget = Math.floor(maxCtx * INDEX_BUDGET_FRAC)
  const pageBudget = Math.floor(maxCtx * PAGE_BUDGET_FRAC)

  // Per-page cap rules:
  //   - At minimum, allow PER_PAGE_FLOOR (5K) so a small config still
  //     fits one short page.
  //   - At maximum, never exceed pageBudget itself — for tiny configs
  //     where pageBudget < 5K, the floor would otherwise allow a
  //     single page bigger than the entire page budget, which then
  //     gets entirely rejected by tryAddPage in chat-panel.
  //   - Otherwise scale linearly with pageBudget at PER_PAGE_FRAC (30%).
  const maxPageSize = Math.min(
    pageBudget,
    Math.max(PER_PAGE_FLOOR, Math.floor(pageBudget * PER_PAGE_FRAC)),
  )

  return {
    maxCtx,
    responseReserve,
    indexBudget,
    pageBudget,
    maxPageSize,
  }
}

// ── Small shared helpers ────────────────────────────────────────────────────

// From src/lib/path-utils.ts (browser-free subset).
function normalizePath(p) {
  return p.replace(/\\/g, "/")
}

export function currentWikiDate(now = new Date()) {
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, "0")
  const day = String(now.getDate()).padStart(2, "0")
  return `${year}-${month}-${day}`
}

export function formatIngestWarningLogEntry(
  sourceIdentity,
  warnings,
  at = new Date(),
) {
  return [
    `## ${at.toISOString()} | ${sourceIdentity}`,
    "",
    ...warnings.map((warning, index) => `${index + 1}. ${warning}`),
    "",
  ].join("\n")
}

function clampNumber(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

export function trimLongText(text, maxChars) {
  if (text.length <= maxChars) return text
  return `${text.slice(0, maxChars).trimEnd()}\n\n[...trimmed for prompt budget...]`
}

// ── FILE block parsing (local copy for filterTruncatedFileRepairOutput) ─────
// Ported byte-identical from src/lib/ingest.ts. The pipeline's parser module
// owns the canonical server copy; this private copy exists so the repair
// output filter stays self-contained per the porting assignment rules.

// Line-level openers / closers. Both are case-insensitive, tolerant of
// extra interior whitespace (`--- END FILE ---`), and anchored to the
// whole trimmed line so a stray `---END FILE---` inside prose or a list
// item (`- ---END FILE---`) won't register.
const OPENER_LINE = /^---\s*FILE:\s*(.+?)\s*---\s*$/i
const CLOSER_LINE = /^---\s*END\s+FILE\s*---\s*$/i
// Fence delimiters per CommonMark (triple+ backticks or tildes). Leading
// indentation ≤ 3 spaces is still a fence; 4+ spaces is an indented code
// block and doesn't use fence markers.
const FENCE_LINE = /^\s{0,3}(```+|~~~+)/

/**
 * Reject FILE block paths that try to escape the project's `wiki/`
 * directory. Allowed: any path under `wiki/`. Rejected: paths not
 * starting with `wiki/`, absolute paths, any `..` segment,
 * Windows-invalid filename characters / reserved device names, segments
 * ending in space or `.`, NUL or control characters, empty /
 * whitespace-only paths.
 */
function isSafeIngestPath(p) {
  if (typeof p !== "string" || p.trim().length === 0) return false
  // No control / NUL bytes anywhere.
  if (/[\x00-\x1f]/.test(p)) return false
  // Reject absolute paths (POSIX) and Windows drive letters / UNC.
  if (p.startsWith("/") || p.startsWith("\\")) return false
  if (/^[a-zA-Z]:/.test(p)) return false
  // Normalize backslashes so a Windows-style payload doesn't sneak past.
  const normalized = p.replace(/\\/g, "/")
  // No `..` segments, regardless of position.
  const segments = normalized.split("/")
  if (segments.some((seg) => seg === "..")) return false
  if (segments.some((seg) => !isWindowsSafePathSegment(seg))) return false
  // Must live under wiki/ — the only tree the ingest pipeline writes to.
  if (!normalized.startsWith("wiki/")) return false
  return true
}

function isWindowsSafePathSegment(segment) {
  if (segment.length === 0) return false
  if (/[<>:"|?*]/.test(segment)) return false
  if (/[ .]$/.test(segment)) return false
  const stem = segment.split(".")[0]?.toUpperCase()
  if (!stem) return false
  if (
    stem === "CON" ||
    stem === "PRN" ||
    stem === "AUX" ||
    stem === "NUL" ||
    /^COM[1-9]$/.test(stem) ||
    /^LPT[1-9]$/.test(stem)
  ) {
    return false
  }
  return true
}

/**
 * Parse an LLM stage-2 generation into FILE blocks. Handles CRLF
 * normalization (H1), surfaces unclosed blocks as warnings (H2), tolerates
 * marker whitespace / case variants (H3), respects code fences so a literal
 * `---END FILE---` inside a fence doesn't close the block early (H5), and
 * surfaces empty-path blocks (H6).
 */
function parseFileBlocks(text) {
  // H1 fix: normalize CRLF to LF before anything else. Cheap and
  // covers the case where a proxy / server / LLM inserts Windows line
  // endings into the stream.
  const normalized = text.replace(/\r\n/g, "\n")
  const lines = normalized.split("\n")

  const blocks = []
  const warnings = []
  const truncatedPaths = []

  let i = 0
  while (i < lines.length) {
    const openerMatch = OPENER_LINE.exec(lines[i])
    if (!openerMatch) {
      i++
      continue
    }
    const path = openerMatch[1].trim()
    i++ // consume opener

    const contentLines = []
    let fenceMarker = null // tracks whether we're inside ``` or ~~~
    let fenceLen = 0
    let closed = false

    while (i < lines.length) {
      const line = lines[i]

      // H5 fix: update fence state before checking closer. Only close
      // the fence when we see the same character repeated at least as
      // many times — CommonMark rule. This lets docs-about-our-format
      // quote `---END FILE---` inside code fences without truncating
      // the outer block.
      const fenceMatch = FENCE_LINE.exec(line)
      if (fenceMatch) {
        const run = fenceMatch[1]
        const char = run[0] // '`' or '~'
        const len = run.length
        if (fenceMarker === null) {
          fenceMarker = char
          fenceLen = len
        } else if (char === fenceMarker && len >= fenceLen) {
          fenceMarker = null
          fenceLen = 0
        }
        contentLines.push(line)
        i++
        continue
      }

      // A line matching the closer ONLY counts when we're outside any
      // code fence. Inside a fence, treat it as ordinary body text.
      if (fenceMarker === null && CLOSER_LINE.test(line)) {
        closed = true
        i++
        break
      }

      contentLines.push(line)
      i++
    }

    if (!closed) {
      // H2 fix (partial): we can't fabricate content the LLM never
      // sent, but we surface the drop instead of silently hiding it.
      const pathLabel = path || "(unnamed)"
      const msg = `FILE block "${pathLabel}" was not closed before end of stream — likely truncation (model hit max_tokens, timeout, or connection dropped). Block dropped.`
      console.warn(`[ingest] ${msg}`)
      warnings.push(msg)
      if (isSafeIngestPath(path)) truncatedPaths.push(path)
      continue
    }

    if (!path) {
      // H6 fix: surface empty-path blocks.
      const msg = `FILE block with empty path skipped (LLM omitted the path after \`---FILE:\`).`
      console.warn(`[ingest] ${msg}`)
      warnings.push(msg)
      continue
    }

    if (!isSafeIngestPath(path)) {
      // Path-traversal guard. Drops blocks whose path tries to escape
      // wiki/ — see isSafeIngestPath for the threat model.
      const msg = `FILE block with unsafe path "${path}" rejected (must be under wiki/, no .., no absolute paths, and Windows-safe file names).`
      console.warn(`[ingest] ${msg}`)
      warnings.push(msg)
      continue
    }

    blocks.push({ path, content: contentLines.join("\n") })
  }

  return { blocks, warnings, truncatedPaths }
}

// ── Prompt builders ─────────────────────────────────────────────────────────

/**
 * Step 1 prompt: AI reads the source and produces a structured analysis.
 * This is the "discussion" step — the AI reasons about the source before writing wiki pages.
 *
 * DEVIATION: `languageDirective` (first parameter) replaces the client's
 * internal languageRule(sourceContent) call; see module header.
 */
export function buildAnalysisPrompt(
  languageDirective,
  purpose,
  index,
  schema = "",
) {
  return [
    "You are an expert research analyst. Read the source document and produce a structured analysis.",
    "Do not output chain-of-thought, hidden reasoning, or a thinking transcript. Reason internally and write only the concise final analysis.",
    "",
    languageDirective,
    "",
    "Your analysis should cover:",
    "",
    "## Key Entities",
    "List people, organizations, products, datasets, tools mentioned. For each:",
    "- Name and type",
    "- Role in the source (central vs. peripheral)",
    "- Whether it likely already exists in the wiki (check the index)",
    "",
    "## Key Concepts",
    "List theories, methods, techniques, phenomena. For each:",
    "- Name and brief definition",
    "- Why it matters in this source",
    "- Whether it likely already exists in the wiki",
    "",
    "## Main Arguments & Findings",
    "- What are the core claims or results?",
    "- What evidence supports them?",
    "- How strong is the evidence?",
    "- Which named subject is each claim about? Do not transfer claims, limits, or evaluations from one entity/model/product/method to another just because they share keywords.",
    "",
    "## Connections to Existing Wiki",
    "- What existing pages does this source relate to?",
    "- Does it strengthen, challenge, or extend existing knowledge?",
    "",
    "## Contradictions & Tensions",
    "- Does anything in this source conflict with existing wiki content?",
    "- Are there internal tensions or caveats?",
    "",
    "## Recommendations",
    "- What wiki pages should be created or updated?",
    "- If the project schema (below) defines page types beyond entity/concept (e.g. goal, habit, reflection, finding, decision, meeting), and the source genuinely contains matching content, recommend pages of those types — name the type explicitly. Only when the source actually supports it; never invent goals/habits/journal entries that aren't in the source.",
    "- What should be emphasized vs. de-emphasized?",
    "- Any open questions worth flagging for the user?",
    "",
    "Be thorough but concise. Focus on what's genuinely important.",
    "",
    "If a folder context is provided, use it as a hint for categorization — the folder structure often reflects the user's organizational intent (e.g., 'papers/energy' suggests the file is an energy-related paper).",
    "",
    schema
      ? `## Project Schema (page types available — map source content to schema-defined types when it fits)\n${schema}`
      : "",
    purpose ? `## Wiki Purpose (for context)\n${purpose}` : "",
    index ? `## Current Wiki Index (for checking existing content)\n${index}` : "",
  ].filter(Boolean).join("\n")
}

/**
 * Step 2 prompt: AI takes its own analysis and generates wiki files + review items.
 *
 * DEVIATION: `languageDirective` (first parameter) replaces the client's
 * internal languageRule(sourceContent) calls; see module header.
 */
export function buildGenerationPrompt(
  languageDirective,
  schema,
  purpose,
  index,
  sourceFileName,
  overview = "",
  sourceSummaryPath,
) {
  // Use original filename (without extension) as the source summary page name
  const sourceBaseName = sourceFileName.replace(/\.[^.]+$/, "")
  const summaryPath = sourceSummaryPath ?? `wiki/sources/${sourceBaseName}.md`
  const today = currentWikiDate()

  return [
    "You are a wiki maintainer. Based on the analysis provided, generate wiki files.",
    "Do not output chain-of-thought, hidden reasoning, or explanatory preamble. Reason internally and output only the requested FILE/REVIEW blocks.",
    "",
    languageDirective,
    "",
    `## IMPORTANT: Source File`,
    `The original source file is: **${sourceFileName}**`,
    `All wiki pages generated from this source MUST include this filename in their frontmatter \`sources\` field.`,
    `Today's date is **${today}**. Use this exact date for all new \`created\`, \`updated\`, and wiki/log.md ingest dates.`,
    "",
    schema
      ? [
          "## Project Schema and Routing (AUTHORITATIVE)",
          schema,
          "",
          "Use this schema as the primary routing rule for page types and directories.",
          "If it defines custom folders or distinctions (for example people, technologies, organizations, methods, or cases), write pages into those schema-defined folders instead of forcing them into wiki/entities/ or wiki/concepts/.",
          "Use wiki/entities/ and wiki/concepts/ only when the schema does not provide a more specific destination.",
          "Every generated page's frontmatter type must match the schema directory used in its FILE path.",
        ].join("\n")
      : "",
    "",
    "## What to generate",
    "",
    `1. A source summary page at **${summaryPath}** (MUST use this exact path)`,
    "2. Entity or schema-defined typed pages for key named things identified in the analysis. Prefer schema-defined directories when present; otherwise use wiki/entities/.",
    "3. Concept or schema-defined typed pages for key ideas, methods, techniques, and abstractions. Prefer schema-defined directories when present; otherwise use wiki/concepts/.",
    "4. A log entry for wiki/log.md (just the new entry to append, format: ## [YYYY-MM-DD] ingest | Title)",
    "Do not generate wiki/index.md or wiki/overview.md. The application maintains aggregate navigation separately so large wikis are never rewritten through model output.",
    "",
    "## Frontmatter Rules (CRITICAL — parser is strict)",
    "",
    "Every page begins with a YAML frontmatter block. Format rules, in order of importance:",
    "",
    "1. The VERY FIRST line of the file MUST be exactly `---` (three hyphens, nothing else).",
    "   Do NOT wrap the file in a ```yaml ... ``` code fence.",
    "   Do NOT prefix it with a `frontmatter:` key or any other line.",
    "2. Each frontmatter line is a `key: value` pair on its own line.",
    "3. The frontmatter ends with another `---` line on its own.",
    "4. The next line after the closing `---` is the start of the page body.",
    "5. Arrays use the standard YAML inline form `[a, b, c]` (no outer brackets around each item).",
    "   Wikilinks belong in the BODY only — never write `related: [[a]], [[b]]` (invalid YAML);",
    "   write `related: [a, b]` with bare slugs.",
    "",
    "Required fields and types:",
    `  • type     — one of the known types (${GENERATION_WIKI_TYPES.join(" | ")}), or a custom type explicitly defined by the project schema`,
    "  • title    — string (quote it if it contains a colon, e.g. `title: \"Foo: Bar\"`)",
    `  • created  — ${today} for new pages (YYYY-MM-DD, no quotes)`,
    `  • updated  — ${today} for new pages (same as created)`,
    "  • tags     — array of bare strings: `tags: [microbiology, ai]`",
    "  • related  — array of bare wiki page slugs: `related: [foo, bar-baz]`. Do NOT include",
    "               `wiki/`, `.md`, or `[[…]]` here — slugs only.",
    `  • sources  — array of source filenames; MUST include "${sourceFileName}".`,
    "",
    "Concrete example of a complete, parseable page (everything between the two `---` lines",
    "is the frontmatter; the heading and prose below are the body):",
    "",
    "    ---",
    "    type: entity",
    "    title: Example Entity",
    `    created: ${today}`,
    `    updated: ${today}`,
    "    tags: [example, demo]",
    "    related: [related-slug-1, related-slug-2]",
    `    sources: ["${sourceFileName}"]`,
    "    ---",
    "",
    "    # Example Entity",
    "",
    "    Body content goes here. Use [[wikilink]] syntax in the body for cross-references.",
    "",
    "Other rules:",
    "- Use [[wikilink]] syntax in the BODY for cross-references between pages",
    "- If you include images, use wiki-root-relative paths such as `media/source-slug/image.png`; never output absolute filesystem paths.",
    "- Preserve subject boundaries: when a source discusses multiple entities/models/products/methods, keep claims, evaluations, limitations, benchmark results, and recommendations attached to the exact subject they describe.",
    "- Do not merge or generalize a claim about one subject into another subject's page solely because they share terms (for example context window size, benchmark name, dataset, architecture, or feature name).",
    "- If a page needs to mention another subject for comparison, write it explicitly as a comparison and cite which source/frontmatter `sources` entry supports that statement.",
    "- Use kebab-case filenames",
    "- Derive filenames from the page title in the mandatory output language, but short proper nouns and technical identifiers take precedence: preserve names such as OpenAI, GPT-5, Transformer, CLIP, ImageNet, PyTorch, CUDA, GitHub, arXiv, React, LanceDB, AnyTXT, MinerU, model names, dataset names, tool names, and code identifiers in their standard original form. Do not put raw URLs, citation strings, or full paper titles directly into file paths; convert surrounding descriptive prose to a safe readable title. For Chinese/Japanese/Korean prose titles, keep readable CJK characters in the filename instead of translating the slug to English.",
    "- Follow the analysis recommendations on what to emphasize",
    "- If the analysis found connections to existing pages, add cross-references",
    "",
    "## Review block types",
    "",
    "After all FILE blocks, optionally emit REVIEW blocks for anything that needs human judgment:",
    "",
    "- contradiction: the analysis found conflicts with existing wiki content",
    "- duplicate: an entity/concept might already exist under a different name in the index",
    "- missing-page: an important concept is referenced but has no dedicated page",
    "- suggestion: ideas for further research, related sources to look for, or connections worth exploring",
    "",
    "Only create reviews for things that genuinely need human input. Don't create trivial reviews.",
    "",
    "## OPTIONS allowed values (only these predefined labels):",
    "",
    "- contradiction: OPTIONS: Create Page | Skip",
    "- duplicate: OPTIONS: Create Page | Skip",
    "- missing-page: OPTIONS: Create Page | Skip",
    "- suggestion: OPTIONS: Create Page | Skip",
    "",
    "The user also has a 'Deep Research' button (auto-added by the system) that triggers web search.",
    "Do NOT invent custom option labels. Only use 'Create Page' and 'Skip'.",
    "",
    "For suggestion and missing-page reviews, the SEARCH field must contain 2-3 web search queries",
    "(keyword-rich, specific, suitable for a search engine — NOT titles or sentences). Example:",
    "  SEARCH: automated technical debt detection AI generated code | software quality metrics LLM code generation | static analysis tools agentic software development",
    "",
    purpose ? `## Wiki Purpose\n${purpose}` : "",
    index ? `## Current Wiki Index (preserve all existing entries, add new ones)\n${index}` : "",
    overview ? `## Current Overview (update this to reflect the new source)\n${overview}` : "",
    "",
    // ── OUTPUT FORMAT MUST BE THE LAST SECTION — models weight recent instructions highest ──
    "## Output Format (MUST FOLLOW EXACTLY — this is how the parser reads your response)",
    "",
    "Your ENTIRE response consists of FILE blocks followed by optional REVIEW blocks. Nothing else.",
    "",
    "FILE block template:",
    "```",
    "---FILE: wiki/path/to/page.md---",
    "(complete file content with YAML frontmatter)",
    "---END FILE---",
    "```",
    "",
    "REVIEW block template (optional, after all FILE blocks):",
    "```",
    "---REVIEW: type | Title---",
    "Description of what needs the user's attention.",
    "OPTIONS: Create Page | Skip",
    "PAGES: wiki/page1.md, wiki/page2.md",
    "SEARCH: query 1 | query 2 | query 3",
    "---END REVIEW---",
    "```",
    "",
    "## Output Requirements (STRICT — deviations will cause parse failure)",
    "",
    "1. The FIRST character of your response MUST be `-` (the opening of `---FILE:`).",
    "2. DO NOT output any preamble such as \"Here are the files:\", \"Based on the analysis...\", or any introductory prose.",
    "3. DO NOT echo or restate the analysis — that was stage 1's job. Your job is to emit FILE blocks.",
    "4. DO NOT output markdown tables, bullet lists, or headings outside of FILE/REVIEW blocks.",
    "5. DO NOT output any trailing commentary after the last `---END FILE---` or `---END REVIEW---`.",
    "6. Between blocks, use only blank lines — no prose.",
    "7. FILE block prose (body, explanations, descriptions, section text) must use the mandatory output language specified below. Preserve proper nouns, acronyms, model names, dataset names, tool/library names, code identifiers, URLs, file names, citation strings, paper titles, and technical terms with no widely-used localized equivalent in their standard original form, including in page names and section headings.",
    "",
    "If you start with anything other than `---FILE:`, the entire response will be discarded.",
    "",
    // Repeat the language directive at the very end so it wins the "most
    // recent instruction" tie-breaker. Small-to-medium models otherwise
    // drift back to their training-data language for individual pages.
    "---",
    "",
    languageDirective,
  ].filter(Boolean).join("\n")
}

/**
 * Dedicated review-suggestion stage prompt (runs after generation when the
 * output is large enough to warrant a second pass).
 *
 * DEVIATION: `languageDirective` (first parameter) replaces the client's
 * internal languageRule(sourceContext) call; see module header.
 */
export function buildReviewSuggestionPrompt(
  languageDirective,
  purpose,
  index,
  sourceIdentity,
  analysis,
  sourceContext,
  generation,
  maxContextSize,
) {
  const { maxCtx } = computeContextBudget(maxContextSize)
  const sectionCap = Math.max(4_000, Math.floor(maxCtx * 0.15))
  const indexCap = Math.max(3_000, Math.floor(sectionCap * 0.8))
  return [
    "You are identifying high-value follow-up research items for a personal wiki.",
    "Do not output chain-of-thought, hidden reasoning, or explanatory preamble.",
    "",
    languageDirective,
    "",
    "Your job is NOT to generate wiki pages. The wiki page generation already happened.",
    "Output only REVIEW blocks for unresolved knowledge gaps that deserve human attention or Deep Research.",
    "",
    "Create REVIEW blocks only for genuinely useful follow-up work:",
    "- missing-page: an important entity/concept is referenced but still lacks a dedicated page",
    "- suggestion: a research question, source type, or comparison that would materially improve the wiki",
    "- contradiction: a conflict or tension that requires user judgment",
    "- duplicate: likely duplicate pages/names that need user review",
    "",
    "Prefer 1-5 high-signal reviews. If there is nothing worth reviewing, output nothing.",
    "For suggestion and missing-page reviews, include a SEARCH line with 2-3 keyword-rich web search queries separated by ` | `.",
    "Use only these options: OPTIONS: Create Page | Skip",
    "",
    "REVIEW block template:",
    "```",
    "---REVIEW: suggestion | Precise title---",
    "Concise description of the gap and why it matters.",
    "OPTIONS: Create Page | Skip",
    "PAGES: wiki/page1.md, wiki/page2.md",
    "SEARCH: query 1 | query 2 | query 3",
    "---END REVIEW---",
    "```",
    "",
    "Return REVIEW blocks only. Do not output FILE blocks. Do not wrap the response in markdown fences.",
    "",
    purpose ? `## Wiki Purpose\n${purpose}` : "",
    index ? `## Current Wiki Index\n${trimLongText(index, indexCap)}` : "",
    "",
    `## Source\n${sourceIdentity}`,
    "",
    "## Stage 1 Analysis",
    trimLongText(analysis, sectionCap),
    "",
    "## Source Context",
    trimLongText(sourceContext, sectionCap),
    "",
    "## Generated Wiki Output",
    trimLongText(generation, sectionCap),
  ].filter(Boolean).join("\n")
}

/**
 * Repair prompt for FILE blocks that were truncated (never closed) in the
 * original generation stream.
 *
 * DEVIATION: `languageDirective` (first parameter) replaces the client's
 * internal languageRule(sourceContext) call; see module header.
 */
export function buildTruncatedFileRepairPrompt(
  languageDirective,
  paths,
  sourceIdentity,
  context,
) {
  const { schema, purpose, analysis, sourceContext, maxContextSize } = context
  const { maxCtx } = computeContextBudget(maxContextSize)
  const sectionCap = Math.max(4_000, Math.floor(maxCtx * 0.12))
  return [
    "You are repairing truncated wiki FILE blocks from an earlier generation.",
    "Return exactly one complete FILE block for each requested path and no other files.",
    "Every block must end with `---END FILE---`. Do not output a preamble, REVIEW blocks, or trailing commentary.",
    "Preserve the requested paths exactly and include the source identity in each page's frontmatter `sources` field.",
    "",
    languageDirective,
    "",
    "## Requested paths",
    ...paths.map((path) => `- ${path}`),
    "",
    `## Source identity\n${sourceIdentity}`,
    schema ? `## Project schema\n${trimLongText(schema, sectionCap)}` : "",
    purpose ? `## Wiki purpose\n${trimLongText(purpose, sectionCap)}` : "",
    `## Stage 1 analysis\n${trimLongText(analysis, sectionCap)}`,
    `## Source context\n${trimLongText(sourceContext, sectionCap)}`,
  ].filter(Boolean).join("\n")
}

/**
 * Filter a repair LLM's output down to the FILE blocks that were actually
 * requested. Drops unrequested paths and duplicates (with warnings) and
 * re-serializes the kept blocks deterministically.
 */
export function filterTruncatedFileRepairOutput(text, allowedPaths) {
  const allowed = new Set(allowedPaths.map(normalizePath))
  const { blocks, warnings } = parseFileBlocks(text)
  const seen = new Set()
  const kept = []
  const dropped = []
  const duplicates = []
  for (const block of blocks) {
    const pathKey = normalizePath(block.path)
    if (!allowed.has(pathKey)) {
      dropped.push(block)
      continue
    }
    if (seen.has(pathKey)) {
      duplicates.push(block)
      continue
    }
    seen.add(pathKey)
    kept.push(block)
  }
  if (dropped.length > 0) {
    warnings.push(
      `Dropped ${dropped.length} unrequested FILE block(s) from truncated repair output: ${dropped.map((block) => block.path).join(", ")}`,
    )
  }
  if (duplicates.length > 0) {
    warnings.push(
      `Dropped ${duplicates.length} duplicate FILE block(s) from truncated repair output: ${duplicates.map((block) => block.path).join(", ")}`,
    )
  }
  return {
    text: kept
      .map((block) => `---FILE: ${block.path}---\n${block.content.trimEnd()}\n---END FILE---`)
      .join("\n\n"),
    paths: kept.map((block) => block.path),
    warnings,
  }
}

/**
 * Long-source chunk analysis system prompt.
 *
 * DEVIATION: `languageDirective` (first parameter) replaces the client's
 * internal languageRule(sourceContent) call; see module header.
 */
export function buildChunkAnalysisSystemPrompt(
  languageDirective,
  purpose,
  schema,
  index,
) {
  return [
    "You are analyzing a long source document for a personal wiki.",
    "Do not output chain-of-thought, hidden reasoning, or a thinking transcript.",
    "Analyze only the current MAIN CHUNK. Use overlap and digest for context only.",
    "Keep stable names consistent with the existing wiki and prior digest.",
    "",
    languageDirective,
    "",
    "Output exactly two markdown sections:",
    "",
    "## Chunk Analysis",
    "- Concise summary of the main chunk",
    "- New or updated entities",
    "- New or updated concepts",
    "- Any schema-defined page types beyond entity/concept that the main chunk genuinely supports",
    "- Claims, findings, evidence, contradictions",
    "- Open questions or research gaps",
    "",
    "## Updated Global Digest",
    "A compact document-level digest that incorporates this chunk and preserves prior cross-chunk context.",
    "Keep this digest structured under: Summary, Entities, Concepts, Schema-Typed Candidates, Claims, Evidence, Contradictions, Open Questions, Cross-Chunk Relations.",
    "Use schema-defined types only when the source actually supports them; never invent goals, habits, journal entries, decisions, or similar user-authored records that are not present in the source.",
    "",
    "Stable project context follows. It changes rarely and should be treated as background:",
    purpose ? `## Wiki Purpose\n${purpose}` : "",
    schema ? `## Wiki Schema\n${schema}` : "",
    index ? `## Current Wiki Index\n${trimLongText(index, 40_000)}` : "",
  ].filter(Boolean).join("\n")
}

export function buildChunkAnalysisUserPrompt(
  sourceIdentity,
  folderContext,
  chunk,
  globalDigest,
) {
  return [
    `Source file: ${sourceIdentity}`,
    folderContext ? `Folder context: ${folderContext}` : "",
    `Chunk: ${chunk.index}/${chunk.total}`,
    chunk.headingPath ? `Heading path: ${chunk.headingPath}` : "",
    "",
    "## Current Global Digest",
    globalDigest || "(No prior digest yet.)",
    "",
    chunk.overlapBefore ? "## Previous Overlap Context\n" + chunk.overlapBefore : "",
    "",
    "## MAIN CHUNK TO ANALYZE",
    chunk.main,
    "",
    "Return only the two requested sections. Do not repeat overlap-only facts unless the main chunk supports them.",
  ].filter(Boolean).join("\n")
}

export function buildPageMergeSystemPrompt() {
  return [
    "You are merging two versions of the same wiki page into one coherent document.",
    "Both versions target the same wiki page; one is already on disk,",
    "the other was just generated from a different source document.",
    "Either version may mention additional subjects for comparison or context.",
    "",
    "Output ONE merged version that:",
    "- Preserves every factual claim from both versions (do not drop content)",
    "- Eliminates redundancy when both versions state the same fact",
    "- Preserves subject/source boundaries: if either version mentions other entities/models/products/methods for comparison, keep those comparisons attribution-exact and do not fold them into claims about the main page subject",
    "- When claims conflict or apply to different subjects, keep them separated and say which source version supports each one instead of synthesizing a single generalized conclusion",
    "- When in doubt whether two similar-looking claims describe the same fact, prefer keeping them separate",
    "- Reorganizes sections so the structure is logical for the merged topic,",
    "  not just a concatenation of the two inputs",
    "- Uses consistent markdown structure (headings, tables, lists, callouts)",
    "- Keeps `[[wikilink]]` references intact",
    "",
    "Output requirements:",
    "- The FIRST character of your response MUST be `-` (the opening of `---`)",
    "- Output the COMPLETE file: YAML frontmatter + body",
    "- No preamble (no \"Here is the merged version:\"), no analysis prose",
    "- The caller will overwrite `sources`/`tags`/`related`/`updated` with",
    "  deterministic values — your job is the body and any other fields",
  ].join("\n")
}

// ── Token-budget compute functions ──────────────────────────────────────────

export function computeIngestSourceBudget(maxContextSize, stableContextLength) {
  const { maxCtx, responseReserve } = computeContextBudget(maxContextSize)
  const stableReserve = Math.min(Math.floor(maxCtx * 0.25), Math.max(12_000, stableContextLength))
  const instructionReserve = Math.max(12_000, Math.floor(maxCtx * 0.08))
  const available = maxCtx - responseReserve - stableReserve - instructionReserve
  const upper = Math.min(LONG_SOURCE_MAX_SINGLE_PASS_BUDGET, Math.max(LONG_SOURCE_MIN_BUDGET, Math.floor(maxCtx * 0.6)))
  return clampNumber(Math.floor(available), LONG_SOURCE_MIN_BUDGET, upper)
}

export function computeIngestGenerationMaxTokens(maxContextSize) {
  const { maxCtx } = computeContextBudget(maxContextSize)
  if (maxCtx >= 512_000) return INGEST_GENERATION_TOKENS_512K
  if (maxCtx >= 256_000) return INGEST_GENERATION_TOKENS_256K
  if (maxCtx >= 128_000) return INGEST_GENERATION_TOKENS_128K
  return INGEST_GENERATION_TOKENS_DEFAULT
}

export function computeIngestReviewMaxTokens(maxContextSize) {
  return Math.min(8_192, Math.max(4_096, Math.floor(computeIngestGenerationMaxTokens(maxContextSize) / 2)))
}

// ── Semantic chunk splitting (ported from src/lib/ingest.ts) ────────────────

function splitOversizedBlock(block, targetChars) {
  if (block.length <= targetChars * 1.25) return [block]

  const pieces = block.match(/[^.!?。！？\n]+[.!?。！？]?|\n+/g) ?? [block]
  const out = []
  let current = ""
  for (const piece of pieces) {
    if (current && current.length + piece.length > targetChars) {
      out.push(current.trim())
      current = ""
    }
    if (piece.length > targetChars) {
      for (let i = 0; i < piece.length; i += targetChars) {
        const slice = piece.slice(i, i + targetChars).trim()
        if (slice) out.push(slice)
      }
    } else {
      current += piece
    }
  }
  if (current.trim()) out.push(current.trim())
  return out
}

function semanticBlocks(content, targetChars) {
  const blocks = []
  const headingStack = []
  let paragraph = []
  let paragraphHeading = ""

  const currentHeadingPath = () => headingStack.filter(Boolean).join(" > ")
  const flushParagraph = () => {
    const text = paragraph.join("\n").trim()
    if (text) {
      for (const piece of splitOversizedBlock(text, targetChars)) {
        blocks.push({ text: piece, headingPath: paragraphHeading })
      }
    }
    paragraph = []
  }

  for (const line of content.replace(/\r\n/g, "\n").split("\n")) {
    const heading = /^(#{1,6})\s+(.+?)\s*$/.exec(line)
    if (heading) {
      flushParagraph()
      const depth = heading[1].length
      headingStack.length = depth - 1
      headingStack[depth - 1] = heading[2].trim()
      blocks.push({ text: line.trim(), headingPath: currentHeadingPath() })
      paragraphHeading = currentHeadingPath()
      continue
    }

    if (line.trim() === "") {
      flushParagraph()
      paragraphHeading = currentHeadingPath()
      continue
    }

    if (paragraph.length === 0) paragraphHeading = currentHeadingPath()
    paragraph.push(line)
  }
  flushParagraph()

  return blocks
}

function overlapSuffix(text, maxChars) {
  if (!text || maxChars <= 0) return ""
  if (text.length <= maxChars) return text
  const raw = text.slice(-maxChars)
  const paragraphBreak = raw.search(/\n\s*\n/)
  if (paragraphBreak > 0 && raw.length - paragraphBreak > maxChars * 0.4) {
    return raw.slice(paragraphBreak).trim()
  }
  const sentenceBreak = raw.search(/[.!?。！？]\s+/)
  if (sentenceBreak > 0 && raw.length - sentenceBreak > maxChars * 0.4) {
    return raw.slice(sentenceBreak + 1).trim()
  }
  return raw.trim()
}

export function splitSourceIntoSemanticChunks(content, targetChars, overlapChars) {
  const target = Math.max(1_000, targetChars)
  const blocks = semanticBlocks(content, target)
  if (blocks.length === 0) return []

  const rawChunks = []
  let current = []
  let currentLength = 0
  let currentHeading = blocks[0]?.headingPath ?? ""

  const flush = () => {
    const main = current.join("\n\n").trim()
    if (main) rawChunks.push({ main, headingPath: currentHeading })
    current = []
    currentLength = 0
  }

  for (const block of blocks) {
    const nextLength = currentLength + block.text.length + (current.length > 0 ? 2 : 0)
    if (current.length > 0 && nextLength > target) {
      flush()
    }
    if (current.length === 0) currentHeading = block.headingPath
    current.push(block.text)
    currentLength += block.text.length + (current.length > 1 ? 2 : 0)
  }
  flush()

  return rawChunks.map((chunk, idx) => ({
    id: `chunk-${idx + 1}`,
    index: idx + 1,
    total: rawChunks.length,
    headingPath: chunk.headingPath,
    overlapBefore: idx > 0 ? overlapSuffix(rawChunks[idx - 1].main, overlapChars) : "",
    main: chunk.main,
  }))
}

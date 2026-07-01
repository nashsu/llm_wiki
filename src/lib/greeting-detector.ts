/**
 * Pure-rule detector for "nothing but a greeting" — lets the chat path
 * skip the wiki retrieval pipeline for casual openers like "hi", "你好",
 * "嗨" that have no information need. Cheap, deterministic, no LLM call.
 *
 * Matches are *whole-string* (after trim + trailing-punctuation strip),
 * not substring — so "hello, how do I train a transformer?" is NOT a
 * greeting. A hard length cap keeps pathological inputs out of the
 * regex loop and protects against false positives on long messages
 * that happen to start with "hi".
 */

const MAX_GREETING_LEN = 20

// Trailing punctuation / emoji-ish tails that users tack onto openers.
// Leading-period not included on purpose — a message starting with "." is
// almost never a greeting.
const TRAILING_PUNCT = /[\s!！。.?？~,，、;；:：\u3002\uFF01\uFF1F]+$/u

const GREETING_PATTERNS: RegExp[] = [
  // ── English ──────────────────────────────────────────────────────
  /^(hi|hello|hey|yo|sup|howdy|hiya|heya|hullo)( there| y'all| you| folks| everyone)?$/,
  /^good (morning|afternoon|evening|day|night)$/,
  /^(what'?s up|wassup|whaddup)$/,
  /^greetings$/,

  // ── Chinese (简体 + 繁體) ──────────────────────────────────────
  // Standalone greetings with optional trailing filler particle.
  /^(你好|您好|大家好|嗨|哈喽|哈啰|哈囉|哈罗|喂)[啊呀吖呢么呗哦哈]?$/,
  // Time-of-day greetings.
  /^(早|早啊|早安|早上好|中午好|下午好|晚上好|晚安)[啊呀吖呢么呗哦哈]?$/,
  // "Are you there?" openers.
  /^(在吗|在嗎|在不在|有人吗|有人嗎|有人在吗|有人在嗎)$/,

  // ── Japanese ────────────────────────────────────────────────────
  /^(こんにちは|こんばんは|おはよう|おはようございます|やあ|どうも|はじめまして)$/,

  // ── Korean ──────────────────────────────────────────────────────
  /^(안녕|안녕하세요|안녕하십니까)$/,

  // ── European casual openers ─────────────────────────────────────
  /^(hola|bonjour|salut|coucou|hallo|servus|hej|hejsan|ciao|saluton|ola|olá|privet|привет)$/,
]

export function isGreeting(text: string): boolean {
  if (!text) return false

  // Strip outer whitespace + trailing punctuation, lowercase for ASCII
  // matching. CJK chars are unaffected by toLowerCase().
  const normalized = text
    .trim()
    .replace(TRAILING_PUNCT, "")
    .trim()
    .toLowerCase()

  if (!normalized) return false
  if (normalized.length > MAX_GREETING_LEN) return false

  return GREETING_PATTERNS.some((re) => re.test(normalized))
}

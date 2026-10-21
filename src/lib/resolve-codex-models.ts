// Live discovery of currently-valid Codex CLI model ids. `codex exec --model`
// accepts a specific dated/named id (unlike claude-code-cli, which resolves
// bare tier aliases like "sonnet" on its own) — the hardcoded list in
// llm-presets.ts goes stale whenever OpenAI ships a new model family. This
// fetches OpenAI's own live model guide and extracts whatever family is
// current, so the Settings picker for Codex CLI never points at a retired
// model. Best-effort: any failure (offline, page format changed) falls back
// to the static preset list untouched — this must never break the UI.

const LATEST_MODEL_DOC_URL = "https://developers.openai.com/api/docs/guides/latest-model.md"
const CACHE_TTL_MS = 24 * 60 * 60 * 1000 // 24h — this is a Settings picker, not a hot path

export interface CodexModelInfo {
  models: string[]
  recommended: string | null
}

let cached: { info: CodexModelInfo; fetchedAt: number } | null = null
let inFlight: Promise<CodexModelInfo | null> | null = null

const BALANCED_PATTERNS = [
  /`([a-z0-9.\-]+)`\s+for\s+a\s+balance\s+of\s+intelligence\s+and\s+cost/i,
  /`([a-z0-9.\-]+)`[^`]{0,80}[Bb]alanced\s+quality,\s+latency,\s+and\s+cost/,
]

function parseModelIds(text: string): string[] {
  const ids = new Set<string>()
  const re = /`(gpt-[a-z0-9.\-]+)`/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    // The bare family alias (e.g. `gpt-5.6`) routes to the flagship model —
    // useful as a fact, not as a distinct picker entry alongside its target.
    if (/^gpt-\d+(\.\d+)?$/.test(m[1])) continue
    ids.add(m[1])
  }
  return [...ids]
}

function parseRecommended(text: string): string | null {
  for (const pattern of BALANCED_PATTERNS) {
    const m = pattern.exec(text)
    if (m) return m[1]
  }
  return null
}

async function fetchLive(): Promise<CodexModelInfo | null> {
  try {
    const res = await fetch(LATEST_MODEL_DOC_URL, { headers: { accept: "text/markdown,text/plain,*/*" } })
    if (!res.ok) return null
    const text = await res.text()
    const models = parseModelIds(text)
    if (models.length === 0) return null
    const recommended = parseRecommended(text)
    return { models, recommended: recommended && models.includes(recommended) ? recommended : models[0] }
  } catch {
    return null
  }
}

/** Returns cached/live Codex model info, or null if unavailable (caller should keep its static fallback). Never throws. */
export async function resolveCodexModels(): Promise<CodexModelInfo | null> {
  const now = Date.now()
  if (cached && now - cached.fetchedAt < CACHE_TTL_MS) return cached.info
  if (inFlight) return inFlight

  inFlight = fetchLive().then((info) => {
    inFlight = null
    if (info) cached = { info, fetchedAt: Date.now() }
    return info
  })
  return inFlight
}

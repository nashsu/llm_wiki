/**
 * AI triage scoring for pending review items.
 *
 * A wiki's review queue can grow to thousands of items (mostly
 * low-value suggestions). Scoring every item individually would cost
 * thousands of LLM calls, so we score in batches: one call returns
 * score + tier + reason for ~50 items. 1882 items → ~38 calls.
 *
 * Scores are written back onto the ReviewItem (aiScore / aiTier /
 * aiReason) so they persist through the normal review.json autosave
 * and survive reloads — re-scoring a large queue is expensive and
 * should not be needed more than once.
 */

import type { ReviewItem } from "@/stores/review-store"
import { useReviewStore } from "@/stores/review-store"
import { useActivityStore } from "@/stores/activity-store"
import { streamChat } from "@/lib/llm-client"
import { getTaskLlmConfig } from "@/lib/llm-task-routing"
import { hasUsableLlm } from "@/lib/has-usable-llm"
import { extractJsonObject } from "@/lib/sweep-reviews"

export type ReviewTier = "keep" | "maybe" | "drop"

export interface ReviewScore {
  id: string
  score: number // 0-100
  tier: ReviewTier
  reason: string
}

/** Batch size = one LLM call per N items. 50 keeps ~1882 under 40 calls. */
export const SCORE_BATCH_SIZE = 50
const MAX_DESC_CHARS = 160
const MAX_REASON_CHARS = 120
export const TIER_KEEP_MIN = 80
export const TIER_DROP_MAX = 39

/**
 * Map a raw score to a tier. Kept as exported constants above so the UI
 * and tests can agree on the boundaries without importing this module's
 * internals twice.
 */
export function scoreToTier(score: number): ReviewTier {
  if (score >= TIER_KEEP_MIN) return "keep"
  if (score <= TIER_DROP_MAX) return "drop"
  return "maybe"
}

function validateScore(raw: unknown): number | null {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return null
  return Math.max(0, Math.min(100, Math.round(raw)))
}

function validateTier(raw: unknown): ReviewTier | null {
  return raw === "keep" || raw === "maybe" || raw === "drop" ? raw : null
}

/**
 * Build the scoring prompt for one batch. The LLM sees a compact list and
 * returns scores only for items it can judge; missing items are left
 * unscored (caller treats them as "maybe" so they survive).
 */
export function buildScoringPrompt(items: ReviewItem[]): string {
  const list = items
    .map((r) => {
      const affected = r.affectedPages?.length ? ` | affected: ${r.affectedPages.join(", ")}` : ""
      const desc = r.description ? ` — ${r.description.slice(0, MAX_DESC_CHARS).replace(/\n+/g, " ")}` : ""
      return `- id=${r.id} [${r.type}] ${r.title}${desc}${affected}`
    })
    .join("\n")

  return [
    "You are triaging a review queue for a personal knowledge wiki.",
    "Each item is a suggestion raised while ingesting source material: it may be a valuable gap worth acting on, or low-value noise.",
    "",
    "Rate each item's VALUE to the wiki owner on a 0-100 scale, then map to a tier:",
    "- keep (score 80-100): genuinely worth acting on — a real knowledge gap, a real contradiction to resolve, a missing page that should exist, or a suggestion that would add substantial new content. These are rare.",
    "- maybe (score 40-79): plausibly useful but not urgent or not clearly actionable.",
    "- drop (score 0-39): noise — vague advice, already-covered topics, duplicate of existing content, or suggestions too generic to act on.",
    "",
    "Be strict: most items should be drop or maybe. Only score keep for something you would genuinely act on.",
    "",
    "Items:",
    list,
    "",
    'Respond with ONLY a JSON object: {"scores": [{"id": "<review id>", "score": <0-100 int>, "tier": "keep"|"maybe"|"drop", "reason": "<short reason, max ~20 words>"}]}',
    "Include every item id from the list above exactly once.",
    "Do not wrap in markdown fences. Do not add commentary.",
  ].join("\n")
}

/** Parse the LLM response into validated scores for this batch's ids. */
export function parseScoresResponse(raw: string, batchIds: Set<string>): ReviewScore[] {
  const cleaned = extractJsonObject(raw)
  if (!cleaned) return []

  let parsed: { scores?: unknown }
  try {
    parsed = JSON.parse(cleaned)
  } catch {
    return []
  }
  if (!parsed || !Array.isArray(parsed.scores)) return []

  const out: ReviewScore[] = []
  for (const entry of parsed.scores) {
    if (!entry || typeof entry !== "object") continue
    const { id, score, tier, reason } = entry as Record<string, unknown>
    if (typeof id !== "string" || !batchIds.has(id)) continue
    const s = validateScore(score)
    if (s === null) continue
    const tt = validateTier(tier) ?? scoreToTier(s)
    out.push({
      id,
      score: s,
      tier: tt,
      reason: typeof reason === "string" ? reason.slice(0, MAX_REASON_CHARS) : "",
    })
  }
  return out
}

interface ScorerOptions {
  signal?: AbortSignal
  /** Called after each batch completes (scoredCount/totalCount). */
  onProgress?: (scored: number, total: number) => void
}

/**
 * Score all pending review items in batches. Writes results onto the store
 * items (aiScore/aiTier/aiReason); the store's autosave persists them.
 *
 * Returns the number of items successfully scored. Never throws for a bad
 * batch — that batch's items are simply left unscored so a transient LLM
 * failure doesn't kill the whole pass.
 */
export async function scorePendingReviews(
  pending: ReviewItem[],
  options: ScorerOptions = {},
): Promise<number> {
  const { signal } = options
  if (pending.length === 0 || signal?.aborted) return 0

  const llmConfig = getTaskLlmConfig("ingest")
  if (!hasUsableLlm(llmConfig)) return 0

  const store = useReviewStore.getState()
  const activity = useActivityStore.getState()
  let activityId: string | null = null

  if (pending.length > 0) {
    activityId = activity.addItem({
      type: "query",
      title: "Review triage",
      status: "running",
      detail: `Scoring ${pending.length} pending reviews…`,
      filesWritten: [],
    })
  }

  let scoredTotal = 0
  try {
    for (let start = 0; start < pending.length && !signal?.aborted; start += SCORE_BATCH_SIZE) {
      const batch = pending.slice(start, start + SCORE_BATCH_SIZE)
      const batchIds = new Set(batch.map((i) => i.id))
      const prompt = buildScoringPrompt(batch)

      let raw = ""
      let hadError = false
      try {
        await streamChat(
          llmConfig,
          [{ role: "user", content: prompt }],
          {
            onToken: (token) => { raw += token },
            onDone: () => {},
            onError: (err) => {
              hadError = true
              console.warn("[Review Scorer] LLM error:", err.message)
            },
          },
          signal,
        )
      } catch (err) {
        console.warn("[Review Scorer] LLM call failed:", err)
        hadError = true
      }

      if (hadError || signal?.aborted || !raw.trim()) {
        options.onProgress?.(scoredTotal, pending.length)
        continue
      }

      const scores = parseScoresResponse(raw, batchIds)
      if (scores.length > 0) {
        // Apply scores in one store update. Already-scored items keep their
        // existing score; only unscored items get values (a re-run over a
        // partially scored queue shouldn't clobber prior judgments).
        const existing = useReviewStore.getState().items
        const existingById = new Map(existing.map((i) => [i.id, i]))
        const updates = scores.filter((s) => {
          const item = existingById.get(s.id)
          return item && item.aiScore === undefined
        })
        if (updates.length > 0) {
          store.setAiScores(updates)
        }
        scoredTotal += updates.length
      }

      options.onProgress?.(scoredTotal, pending.length)
    }

    if (activityId !== null) {
      activity.updateItem(activityId, {
        status: signal?.aborted ? "error" : "done",
        detail: signal?.aborted
          ? "Review triage cancelled"
          : `Scored ${scoredTotal} / ${pending.length} review items`,
      })
    }
  } catch (err) {
    if (activityId !== null) {
      activity.updateItem(activityId, {
        status: "error",
        detail: `Review triage failed: ${err instanceof Error ? err.message : String(err)}`,
      })
    }
  }

  return scoredTotal
}

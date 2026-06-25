/**
 * Pure budget allocator for chat context assembly.
 *
 * Given an LLM's `maxContextSize` (in characters — see wiki-store.ts;
 * yes, that's a quirky unit, but tokens-vs-chars conversion lives
 * elsewhere), compute the per-section character budgets used by
 * chat-panel when packing the prompt.
 *
 * Why this is its own module:
 *   - The math has corner cases that deserve their own tests
 *     (tiny configs, huge configs, the legacy 30K cap removal).
 *   - Inlining it in chat-panel.tsx made it untestable in isolation.
 *
 * The shape of the budget:
 *
 *   ┌─────────────────────────────────────────────────────┐
 *   │              maxCtx (100%)                          │
 *   ├──────┬───────────────┬──────────────────┬───────────┤
 *   │ idx  │   pages       │  history + sys   │  resp     │
 *   │  5%  │    50%        │    ~30%          │   15%     │
 *   └──────┴───────────────┴──────────────────┴───────────┘
 *
 * `historyAndSystem` isn't returned because it's not enforced as a
 * single budget — system prompt is roughly fixed-size, and history
 * is gated by `maxHistoryMessages` (count, not bytes). The leftover
 * just provides headroom.
 *
 * The response reserve is a "passive" reservation: we don't pass
 * `max_tokens: responseReserve / 3` to the LLM (yet — that's a
 * follow-up). We just refuse to fill above (maxCtx - responseReserve)
 * so the LLM has room to actually answer.
 */

/** Result of `computeContextBudget`. All values are character counts. */
export interface ContextBudget {
  /** The model's full context window (always populated; falls back
   *  to a sensible default when caller passes 0/undefined). */
  maxCtx: number
  /** Characters NOT to be filled with prompt content — left empty so
   *  the LLM has room to write its response. */
  responseReserve: number
  /** Wiki index summary budget. ~5% — enough to list every page's
   *  title without occupying serious budget. */
  indexBudget: number
  /** Total characters available for retrieved wiki page content. */
  pageBudget: number
  /** Per-page truncation cap. A single page won't be embedded longer
   *  than this even if `pageBudget` would allow it. Scales with
   *  pageBudget (used to be hard-capped at 30,000 chars regardless
   *  of context size — that wasted budget on long-context models). */
  maxPageSize: number
}

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
export function computeContextBudget(
  maxContextSize: number | undefined,
): ContextBudget {
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

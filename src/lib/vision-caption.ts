/**
 * Vision-caption helper. Sends one image + a fixed factual prompt to a
 * vision-capable LLM and returns the model's plain-text description.
 *
 * Why this exists:
 *
 *   The image-extraction step (Phase 1) lands raster images on disk
 *   under `raw/assets/<source-slug>/`, but the text we hand to the
 *   ingest LLM contains those images as `![](...)` references with
 *   EMPTY alt text — meaningless to a text-only summarizer. Generation
 *   models silently strip empty-alt images when paraphrasing the
 *   source, so wiki pages that should reference figures end up with
 *   no figure at all. Worse: the embedding side has no semantic
 *   signal for those images, so chart-only PDF pages embed as their
 *   surrounding text only and rank far below where they should.
 *
 *   captionImage solves both: a 2-4 sentence factual description per
 *   image gives the summarizer something to preserve, and (post-
 *   Phase 5) gives the embedding step token-bearing content to
 *   index alongside the image bytes.
 *
 * What this is NOT:
 *
 *   This module knows nothing about ingest, caching, or where the
 *   image lives on disk. The caller passes raw base64 + mediaType,
 *   handles persistence (Phase 3b layers caching + ingest wiring on
 *   top), and decides whether to run captioning at all (Phase 4
 *   adds a settings toggle).
 *
 * Cost model (read this before you call this in a loop):
 *
 *   Each call is one round-trip to the vision endpoint with the full
 *   image bytes inline. A 100-page paper with 30 figures = 30 vision
 *   calls. Caching by image SHA-256 (Phase 3b) lets duplicate logos
 *   / chart templates / academic-figure boilerplate dedupe to one
 *   call across an entire corpus — without it the cost scales
 *   linearly with figure count and we'll routinely 10x the budget
 *   on chart-heavy decks.
 */
import type { LlmConfig } from "@/stores/wiki-store"
import { streamChat, type ChatMessage } from "./llm-client"

/**
 * The "no surrounding text" prompt — same factual / verbatim /
 * no-speculation framing we've used since Phase 3a. Used when the
 * caller has no context to supply (e.g. a captioning helper called
 * directly without a document, or when context is intentionally
 * disabled). Pinned, not parameterized.
 *
 * Reasons:
 *   - Factual / no-speculation framing reduces hallucination
 *     ("Describe ... factually" vs. "What is this?"). Ablation
 *     against an early "describe this image" prompt produced
 *     captions like "this appears to be a successful business
 *     metric" for a literal screenshot of a SQL query.
 *
 *   - Verbatim text capture matters for diagrams, slide bullets,
 *     and figure callouts — a vision model will paraphrase OCR
 *     unless told not to.
 *
 *   - 2-4 sentences is the sweet spot empirically: 1 sentence
 *     loses chart-axis detail; 6+ sentences burns tokens AND
 *     produces editorial filler that hurts retrieval relevance.
 *
 *   - "no markdown, no preamble" prevents the caption from breaking
 *     when we splice it as alt text (`![CAPTION](path)` — newlines
 *     or markdown inside CAPTION corrupt the surrounding doc).
 */
export const CAPTION_PROMPT =
  "Describe this image factually for a knowledge-base index. Include: any visible text verbatim, chart axes and values, diagram structure (boxes/arrows/labels), key visual elements. Do NOT speculate or editorialize. 2 to 4 sentences. Output plain text only — no markdown, no preamble."

/**
 * Build the prompt that gets used WHEN the caller supplies
 * surrounding text. Wraps the no-context prompt with an explicit
 * "here is the document text around this image — it may or may
 * not be related, you decide" frame.
 *
 * Empty / whitespace-only sides collapse to "(none)" rather than
 * leaving an empty delimited block, which some models try to
 * interpret as silence-is-meaningful and produce odd captions
 * about. The brackets stay so the structure is uniform.
 */
export function buildCaptionPromptWithContext(
  before: string,
  after: string,
): string {
  const fmt = (s: string) => {
    const trimmed = s.trim()
    return trimmed.length > 0 ? trimmed : "(none)"
  }
  return [
    "The image is embedded in a longer document. Here is the text that appears IMMEDIATELY BEFORE and AFTER this image in the source:",
    "",
    "--- Text before image ---",
    fmt(before),
    "--- Text after image ---",
    fmt(after),
    "--- End surrounding text ---",
    "",
    "This surrounding text MAY help describe the image — for example, a sentence like \"Figure 3: Q2 revenue chart\" tells you what the chart actually plots. It MAY ALSO be unrelated body text that just happens to flank the image. Use your judgment: if a passage clearly identifies, references, or labels the image, anchor your caption to it; if not, ignore the surrounding text and describe what you see.",
    "",
    "Now describe the image factually for a knowledge-base index. Include: any visible text verbatim, chart axes and values, diagram structure (boxes/arrows/labels), key visual elements. If the surrounding text contains a relevant figure number / caption / referent, incorporate that specifically. Do NOT invent details that aren't visible in the image or directly stated in the surrounding text. 2 to 4 sentences. Output plain text only — no markdown, no preamble.",
  ].join("\n")
}

export interface CaptionOptions {
  /** Bound the model's output. Captions live inline in markdown
   *  alt text, so 200-400 tokens covers our pinned 2-4 sentences
   *  with margin for thinking-mode budgets. Default 4096 lets
   *  reasoning models (Qwen3, R1) think AND answer; bump higher
   *  if your model's `<think>` block reliably exceeds that. */
  maxTokens?: number
  /** Sampling. Caption-quality work wants determinism — we want
   *  the same image to caption the same way across runs (so the
   *  per-image hash cache from Phase 3b is meaningful). 0 makes
   *  the model greedy. */
  temperature?: number
  /**
   * Document text immediately preceding/following the image in the
   * source. When BOTH are present (or even one), we switch to the
   * context-aware prompt that explicitly tells the model the text
   * may or may not be relevant — the model decides. Without these
   * the no-context prompt is used.
   *
   * Caller responsibility:
   *   - Trim/truncate to a sensible window (the caller knows the
   *     wider document; this helper just frames whatever it gets).
   *   - Don't include the image's own `![](url)` markdown in either
   *     side — the caller's slice should be the text BEFORE and
   *     AFTER the image's match in the source markdown.
   *   - Empty string is fine (treated as "no preceding/following
   *     text"); we'll mark it `(none)` in the prompt so the model
   *     sees the structure without an empty delimited block.
   */
  contextBefore?: string
  contextAfter?: string
}

/**
 * Caption a single image. Returns the joined caption text with
 * surrounding whitespace stripped — newlines and trailing spaces
 * inside the caption are PRESERVED (some captions legitimately
 * contain line breaks for OCR'd multiline labels).
 *
 * `imageBase64` must be the raw base64 of the image bytes, NOT a
 * `data:` URL. The provider translator owns the `data:image/png;
 * base64,...` framing — passing an already-data-URL'd value would
 * double-frame it and the wire would 400.
 *
 * Errors: any LLM error (network, HTTP non-2xx, timeout) propagates
 * through `streamChat`'s `onError` and is rethrown here as a thrown
 * Error. Callers wanting fault-tolerance (skip-on-fail in batch
 * captioning) should `try/catch` and decide their own policy.
 */
export async function captionImage(
  imageBase64: string,
  mediaType: string,
  llmConfig: LlmConfig,
  signal?: AbortSignal,
  options?: CaptionOptions,
): Promise<string> {
  // Pick the context-aware prompt iff EITHER side has non-trivial
  // content. Whitespace-only context is treated as "no context" so a
  // caller passing untrimmed slices doesn't accidentally upgrade to
  // the longer prompt with `(none)`/`(none)` blocks — that just
  // wastes tokens.
  const before = options?.contextBefore?.trim() ?? ""
  const after = options?.contextAfter?.trim() ?? ""
  const promptText =
    before.length > 0 || after.length > 0
      ? buildCaptionPromptWithContext(before, after)
      : CAPTION_PROMPT

  const messages: ChatMessage[] = [
    {
      role: "user",
      content: [
        { type: "text", text: promptText },
        { type: "image", mediaType, dataBase64: imageBase64 },
      ],
    },
  ]

  const tokens: string[] = []
  let streamError: Error | null = null

  await streamChat(
    llmConfig,
    messages,
    {
      onToken: (t) => tokens.push(t),
      onDone: () => {},
      onError: (e) => {
        streamError = e
      },
    },
    signal,
    {
      temperature: options?.temperature ?? 0,
      max_tokens: options?.maxTokens ?? 4096,
    },
  )

  if (streamError) {
    // streamChat reports HTTP / network errors via onError but
    // resolves cleanly — re-throw so the caller can `try/catch`
    // the caption call as a unit. Without this re-throw, a 500
    // from the vision endpoint silently produces empty caption
    // text and the ingest pipeline indexes images as untitled.
    throw streamError as Error
  }

  return tokens.join("").trim()
}

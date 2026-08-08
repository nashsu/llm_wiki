/**
 * Vision-caption helper. Sends one image + a fixed factual prompt to a
 * vision-capable LLM and returns the model's plain-text description.
 *
 * Why this exists:
 *
 *   The image-extraction step (Phase 1) lands raster images on disk
 *   under `wiki/media/<source-slug>/`, but the text we hand to the
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
import { getLanguagePromptName } from "./language-metadata"

/**
 * Core caption guidance — soft, adaptive, content-aware.
 *
 * Design principles:
 *   - 5 dimensions as SUGGESTIONS, not a rigid template. The model
 *     picks what's relevant and skips what isn't.
 *   - ~300 chars average, 1024 max — expressed as soft guidance,
 *     not a hard cap. Complex images naturally run longer.
 *   - Factual / no-speculation framing. An early ablation showed
 *     that "describe this image" style prompts produce hallucinated
 *     narratives ("this appears to be a successful business metric"
 *     for a literal SQL screenshot). Every dimension below asks for
 *     observable facts, not guesses.
 *   - Plain text only — no Markdown tables, Mermaid, or fenced code
 *     blocks. The caption is spliced into `![alt](url)` via
 *     `formatImageAlt`, which only escapes `]` and newlines; pipes,
 *     backticks, and other Markdown syntax would corrupt the
 *     surrounding document.
 *   - Single paragraph, no line breaks — so `splitCaptionIntoAltAndTitle`
 *     naturally returns alt=full text, title=undefined.
 *   - Verbatim text capture: diagrams, slide bullets, and figure
 *     callouts must be reproduced exactly — a vision model will
 *     paraphrase OCR unless told not to.
 *   - Language is appended by the caller (see `captionImage`).
 */
export const CAPTION_PROMPT =
  "You are describing an image for a knowledge base, helping someone who cannot see it understand its content and significance.\n\n" +
  "Consider these aspects as appropriate — not all apply to every image; use your judgment on what matters most:\n" +
  "• Overall impression: what is this image about, in a sentence or two?\n" +
  "• Spatial layout: where are key elements positioned (left, center, right, foreground, background)?\n" +
  "• Visual details: colors, expressions, gestures, textures. Reproduce any visible text verbatim.\n" +
  "• Atmosphere: lighting, mood, sensory quality that gives the image life.\n" +
  "• Context: where/when was this likely made, for what purpose? Base this only on visible evidence.\n\n" +
  "Describe only what is directly observable. Do not speculate about causes, narratives, or intentions beyond what the image explicitly shows.\n\n" +
  "Aim for around 300 characters; complex images may run longer (up to ~1000). Write as a single flowing paragraph of plain text — no line breaks, no headings, no Markdown formatting (no tables, no code fences, no bullet lists), no preamble like \"This image shows…\". Just describe."

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
    "This surrounding text MAY help — a sentence like \"Figure 3: Q2 revenue chart\" tells you what the chart plots. It MAY ALSO be unrelated body text. Use your judgment: if a passage clearly identifies or labels the image, anchor to it; if not, ignore it.",
    "",
    CAPTION_PROMPT,
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
  /**
   * Target output language for the caption (e.g. "Chinese",
   * "English", "Japanese"). When set, a language directive is
   * appended to the prompt so the VLM writes alt text in the
   * wiki's configured language. Pass the raw store value —
   * `getLanguagePromptName` resolves display names internally.
   * Omit or pass "auto" to let the model match the image content.
   */
  outputLanguage?: string
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
  if (llmConfig.provider === "codex-cli") {
    throw new Error("Codex CLI transport does not support image input for captioning yet.")
  }

  // Pick the context-aware prompt iff EITHER side has non-trivial
  // content. Whitespace-only context is treated as "no context" so a
  // caller passing untrimmed slices doesn't accidentally upgrade to
  // the longer prompt with `(none)`/`(none)` blocks — that just
  // wastes tokens.
  const before = options?.contextBefore?.trim() ?? ""
  const after = options?.contextAfter?.trim() ?? ""
  let promptText =
    before.length > 0 || after.length > 0
      ? buildCaptionPromptWithContext(before, after)
      : CAPTION_PROMPT

  // Append language directive when the wiki has an explicit output
  // language. "auto" / undefined → model matches image content.
  const lang = options?.outputLanguage
  if (lang && lang !== "auto") {
    const langName = getLanguagePromptName(lang)
    promptText += `\n\nWrite your description in ${langName}.`
  }

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
      // Captioning is a short factual vision task. If the main LLM is
      // configured as a reasoning model, inheriting that setting here
      // often burns the small caption budget on thinking and produces
      // no usable alt text. Disable reasoning for caption calls unless
      // this helper grows an explicit caption-reasoning option.
      reasoning: { mode: "off" },
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

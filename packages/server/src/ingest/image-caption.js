// Caption-the-images pipeline + persistent cache (server port of
// src/lib/image-caption-pipeline.ts for the server-driven ingest pipeline,
// issue #14 P0).
//
// Also folds in the verbatim port of src/lib/vision-caption.ts
// (CAPTION_PROMPT / buildCaptionPromptWithContext / captionImage) — the
// client's caption helper module — because the assignment packages the whole
// caption pipeline into this single file.
//
// Sits between the image extractor (which lands images on disk under
// `wiki/media/<slug>/`) and the ingest LLM (which sees source
// markdown with `![](abs_path)` references). The job is twofold:
//
//   1. For each image referenced in the source markdown, get a
//      factual caption from the vision model — using the cache if
//      we've described those exact bytes before.
//
//   2. Rewrite the markdown so each `![](path)` becomes
//      `![<caption>](path)`. The summarizer LLM stripping empty-alt
//      images is the failure mode this exists to prevent: an alt-
//      texted image carries enough semantic load that the model
//      preserves it through paraphrasing.
//
// Cache key = SHA-256 of image bytes. This makes duplicate images
// across PDFs (logos, page headers, recurring chart templates) a
// single LLM call across the whole project — without it, a corpus
// of slide decks with shared brand assets would caption the same
// logo hundreds of times.
//
// Cache file lives at
//   `<project>/.llm-wiki/image-caption-cache.json`
// keyed `{ "<sha256>": { caption, mimeType, model, capturedAt } }`.
// The model + capturedAt fields aren't read by anything yet but
// shipping the metadata now means we can implement Phase 4's
// "re-caption with new model" without a second cache version.
//
// Why JSON-on-disk and not LanceDB / sqlite: the cache is small
// (10s of KB on real corpora), human-readable for debugging
// ("why is this caption wrong?"), and survives `npm run dev`
// restarts — no migration story needed when the embedding-side
// schema changes. If we ever cache 100k+ images we'll revisit.
//
// Browser→Node swaps (and only those): @/commands/fs → node:fs/promises
// (explicit "utf8" on reads); crypto.subtle SHA-256 → node:crypto
// (byte-identical hex digests); captionImage's streamChat call is adapted
// from the desktop llm-client signature to the server's ./llm.js streamChat
// (accumulated text return value instead of onToken/onDone/onError
// callbacks; the `reasoning: { mode: "off" }` override has no counterpart
// in the server wire adapters and is dropped). Multimodal message content
// is built here in OpenAI content-array shape; for the Anthropic wire it is
// translated to Anthropic image blocks BEFORE calling streamChat (the
// llm-call.js Anthropic adapter passes array content through unchanged).

import { createHash } from "node:crypto"
import { mkdir, readFile as fsReadFile, stat, writeFile as fsWriteFile } from "node:fs/promises"
import { streamChat } from "./llm.js"
import { normalizeEndpoint } from "../llm-resolve.js"

// ── Inlined from src/lib/path-utils.ts (tiny helpers) ──

function normalizePath(p) {
  return p.replace(/\\/g, "/")
}

function getFileName(p) {
  const normalized = p.replace(/\\/g, "/")
  return normalized.split("/").pop() ?? p
}

// ── Browser→Node fs boundary (mirrors @/commands/fs semantics) ──

async function fileExists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function readFile(path) {
  return fsReadFile(path, "utf8")
}

async function writeFile(path, contents) {
  await fsWriteFile(path, contents ?? "", "utf8")
}

async function createDirectory(path) {
  await mkdir(path, { recursive: true })
}

/** Mirror of the Tauri read_file_as_base64 command: base64 + mime guessed
 *  by extension (same table as src-tauri/src/commands/fs.rs). */
async function readFileAsBase64(path) {
  const buf = await fsReadFile(path)
  const ext = getFileName(path).split(".").pop()?.toLowerCase() ?? ""
  const mime = (() => {
    switch (ext) {
      case "png": return "image/png"
      case "jpg":
      case "jpeg": return "image/jpeg"
      case "gif": return "image/gif"
      case "webp": return "image/webp"
      case "bmp": return "image/bmp"
      case "tiff":
      case "tif": return "image/tiff"
      case "svg": return "image/svg+xml"
      case "pdf": return "application/pdf"
      default: return "application/octet-stream"
    }
  })()
  return { base64: buf.toString("base64"), mimeType: mime }
}

// ── vision-caption.ts port ──

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
export function buildCaptionPromptWithContext(before, after) {
  const fmt = (s) => {
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
 * through the server streamChat as a thrown Error. Callers wanting
 * fault-tolerance (skip-on-fail in batch captioning) should
 * `try/catch` and decide their own policy.
 */
export async function captionImage(imageBase64, mediaType, llmConfig, signal, options) {
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
  const promptText =
    before.length > 0 || after.length > 0
      ? buildCaptionPromptWithContext(before, after)
      : CAPTION_PROMPT

  // Multimodal content: OpenAI-style content array with a data: URL
  // image_url block (parity with llm-providers.ts toOpenAiContent).
  // For the Anthropic wire, translate to Anthropic image blocks here —
  // llm-call.js passes array content through unchanged on both wires.
  const { wire } = normalizeEndpoint(llmConfig)
  const content = wire === "anthropic"
    ? [
        { type: "text", text: promptText },
        {
          type: "image",
          source: {
            type: "base64",
            media_type: mediaType,
            data: imageBase64,
          },
        },
      ]
    : [
        { type: "text", text: promptText },
        {
          type: "image_url",
          image_url: { url: `data:${mediaType};base64,${imageBase64}` },
        },
      ]

  const messages = [{ role: "user", content }]

  const text = await streamChat(llmConfig, messages, {
    signal,
    overrides: {
      temperature: options?.temperature ?? 0,
      max_tokens: options?.maxTokens ?? 4096,
      // Captioning is a short factual vision task. If the main LLM is
      // configured as a reasoning model, inheriting that setting here
      // often burns the small caption budget on thinking and produces
      // no usable alt text. Disable reasoning for caption calls unless
      // this helper grows an explicit caption-reasoning option.
      // PORT NOTE: the desktop passes `reasoning: { mode: "off" }` here;
      // the server wire adapters (llm-call.js) have no reasoning knob,
      // so the override is dropped.
    },
  })

  return text.trim()
}

// ── image-caption-pipeline.ts port ──

const CACHE_REL_PATH = ".llm-wiki/image-caption-cache.json"

/**
 * Compute SHA-256 of a base64 string by decoding to bytes first
 * (the cache key is the hash of the IMAGE BYTES, not the base64
 * string — same image encoded with different base64 line-wrap
 * settings would otherwise miss the cache).
 *
 * PORT NOTE: node:crypto replaces crypto.subtle; the digest over the
 * decoded bytes is byte-identical.
 */
async function sha256OfBase64(b64) {
  return createHash("sha256").update(Buffer.from(b64, "base64")).digest("hex")
}

/**
 * Public read of the on-disk caption cache. Returns the SHA-256 →
 * caption map, or an empty map when the cache file doesn't exist
 * yet / is corrupt. Callers (the source-summary safety-net
 * injector, search result enrichment, etc.) use this to look up
 * captions by image hash without re-running the LLM.
 */
export async function loadCaptionCache(projectPath) {
  const cache = await readCache(projectPath)
  const out = new Map()
  for (const [hash, entry] of Object.entries(cache)) {
    out.set(hash, entry.caption)
  }
  return out
}

async function readCache(projectPath) {
  const cachePath = `${normalizePath(projectPath)}/${CACHE_REL_PATH}`
  if (!(await fileExists(cachePath))) return {}
  try {
    const raw = await readFile(cachePath)
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed
    }
  } catch (err) {
    // Corrupt cache (e.g. truncated mid-write before we added
    // atomic writes) — start fresh rather than wedging the whole
    // ingest pipeline. Log so it's visible in the activity feed.
    console.warn(
      `[caption-cache] corrupt cache at ${cachePath}, starting empty:`,
      err instanceof Error ? err.message : err,
    )
  }
  return {}
}

async function writeCache(projectPath, cache) {
  const pp = normalizePath(projectPath)
  const cachePath = `${pp}/${CACHE_REL_PATH}`
  // `.llm-wiki/` may not exist on a fresh project — create_directory
  // is idempotent and chains parents.
  await createDirectory(`${pp}/.llm-wiki`)
  // Pretty-print at 2 spaces. Cache files end up in user backups
  // and source control sometimes; readability outweighs the small
  // size penalty.
  await writeFile(cachePath, JSON.stringify(cache, null, 2))
}

/**
 * Discover every `![](path)` reference in markdown content.
 * Returns the LITERAL strings (so we can string-replace later)
 * along with the captured path.
 *
 * Scope:
 *   - Standard markdown image syntax: `![alt](url)` — alt is
 *     captured but ignored when deciding whether to caption (we
 *     re-caption even non-empty alt because user-typed alt text
 *     usually says "Figure 3" — useless to retrieval).
 *   - HTML `<img src="...">`: NOT captured by this regex; we
 *     don't generate those, and re-captioning hand-typed HTML
 *     would surprise the user.
 *   - Reference-style images (`![alt][ref]` + `[ref]: url`): NOT
 *     handled — we don't generate them either. Add support if
 *     it matters.
 */
const MD_IMAGE_RE = /(!\[)([^\]]*)(\]\()([^)\s]+)(\))/g

/**
 * Window size for context-aware captioning. 150 chars ≈ 30 English
 * words ≈ 1-2 sentences ≈ 1 short paragraph in CJK. Sized to cover
 * the typical "high-signal" zone around an image:
 *
 *   - Figure captions ("Figure 3: Quarterly revenue 2024") sit
 *     immediately after the image and almost always fit in the
 *     first sentence — well under 150 chars.
 *   - Referring sentences ("as shown above", "the chart below
 *     illustrates ...") sit at the END of the preceding paragraph,
 *     also typically the last 1-2 sentences.
 *
 * We initially shipped 500 chars/side. Empirically that included
 * too much unrelated body text on either side of the high-signal
 * zone, which (a) bloated the LLM prompt with noise the model had
 * to actively filter out, and (b) tripled the input-token cost
 * for tiny upside. 150 keeps the figure-caption sweet spot while
 * staying cheap.
 *
 * Tunable here, not in user settings — adding another knob hurts
 * UX more than it helps the rare user with unusual document shape.
 */
const CONTEXT_CHARS = 150

function findImageReferences(markdown) {
  const out = []
  // Use exec() in a loop instead of matchAll() so we capture
  // `m.index` (the position in the source) — needed for the
  // context slicer below.
  const re = new RegExp(MD_IMAGE_RE.source, MD_IMAGE_RE.flags)
  let m
  while ((m = re.exec(markdown)) !== null) {
    out.push({
      full: m[0],
      alt: m[2],
      url: m[4],
      index: m.index,
      length: m[0].length,
    })
  }
  return out
}

/**
 * Slice the chars BEFORE and AFTER an image match in the source
 * markdown. Bounds-safe (window clamps to document edges) and
 * leaves the slices verbatim — no markdown stripping. Other
 * `![](url)` references that fall inside the window remain in the
 * raw text; the model handles them fine and removing them risks
 * hiding "Figure 3 (above) shows ..." style cross-references.
 */
function sliceContext(markdown, ref, windowChars) {
  const beforeStart = Math.max(0, ref.index - windowChars)
  const before = markdown.slice(beforeStart, ref.index)
  const afterStart = ref.index + ref.length
  const after = markdown.slice(afterStart, afterStart + windowChars)
  return { before, after }
}

/**
 * Caption every distinct image referenced in `markdown`, using the
 * cache to skip ones we've already described, then rewrite the
 * markdown to embed each caption as alt text.
 *
 * - Distinct = same SHA-256. Two different paths to the same
 *   image content (e.g. mirrored copies of a logo) caption ONCE
 *   and both refs get the same alt text.
 *
 * - Failures during a single caption call do NOT abort the batch.
 *   That image keeps its original (usually empty) alt text and
 *   the rest of the document still gets enriched. The error is
 *   logged so the activity feed surfaces "captioned 28/30 images
 *   — 2 failed" type info.
 *
 * Returns the rewritten markdown. The caption cache file at
 * `<project>/.llm-wiki/image-caption-cache.json` is updated as a
 * side-effect (atomically at the end, NOT per image — partial
 * writes don't persist if the user cancels mid-batch).
 *
 * `urlToAbsPath` is a hook for path resolution: every image URL
 * we see in the markdown needs to map to an absolute filesystem
 * path so the image bytes can be picked up off disk. The default
 * treats non-absolute URLs as wiki-rooted (mirroring
 * `markdown-image-resolver`), but autoIngest passes a stricter
 * version that knows the source's media directory.
 *
 * @param {object} [options]
 * @param {(url: string) => string | null} [options.urlToAbsPath]
 *   Override the default URL→path resolution.
 * @param {AbortSignal} [options.signal]
 *   AbortSignal forwarded to each captionImage call.
 * @param {(url: string) => boolean} [options.shouldCaption]
 *   Skip URLs that don't pass this filter — used by autoIngest to
 *   caption ONLY the images extracted from the current source
 *   (not random user-typed `![](https://example.com/foo.png)`
 *   references that would otherwise fail with a bogus path).
 * @param {number} [options.concurrency]
 *   Max parallel caption requests. 1 = strictly sequential.
 *   Defaults to 1 to keep the wire-format change non-breaking;
 *   the ingest pipeline reads this from `multimodalConfig` and
 *   passes the user's chosen value.
 * @param {(done: number, total: number) => void} [options.onProgress]
 *   Progress hook fired after each image finishes (ok or failed),
 *   with running counts. Used by ingest to update the activity
 *   feed with "captioning N/M" messages — without it a long
 *   captioning run looks like the pipeline is stuck.
 */
export async function captionMarkdownImages(projectPath, markdown, llmConfig, options) {
  const refs = findImageReferences(markdown)
  if (refs.length === 0) {
    return {
      enrichedMarkdown: markdown,
      freshCaptions: 0,
      cachedCaptions: 0,
      failed: 0,
    }
  }

  const filter = options?.shouldCaption ?? (() => true)
  const targetRefs = refs.filter((r) => filter(r.url))
  if (targetRefs.length === 0) {
    return {
      enrichedMarkdown: markdown,
      freshCaptions: 0,
      cachedCaptions: 0,
      failed: 0,
    }
  }

  if (llmConfig.provider === "codex-cli") {
    console.warn(
      "[caption-pipeline] skipped image captioning: Codex CLI transport does not support image input yet.",
    )
    return {
      enrichedMarkdown: markdown,
      freshCaptions: 0,
      cachedCaptions: 0,
      failed: targetRefs.length,
    }
  }

  const cache = await readCache(projectPath)
  let freshCaptions = 0
  let cachedCaptions = 0
  let failed = 0
  const captionByUrl = new Map()

  // De-dupe target refs by URL up front. Two refs to the same URL
  // (inline + safety-net section) should share one caption call —
  // and we keep the FIRST occurrence so the context slice anchors
  // to the inline reference (typically richer surrounding text)
  // rather than the safety-net section (where every image is
  // followed by another `![](path)` and very little prose).
  const uniqueRefs = []
  const seenUrls = new Set()
  for (const ref of targetRefs) {
    if (seenUrls.has(ref.url)) continue
    seenUrls.add(ref.url)
    uniqueRefs.push(ref)
  }

  const concurrency = Math.max(1, options?.concurrency ?? 1)
  const total = uniqueRefs.length
  let completed = 0

  /**
   * Process one image: read bytes → check hash cache → call LLM
   * if miss → record caption. Returns void; mutates the shared
   * `cache` / `captionByUrl` / counters by closure. Errors are
   * swallowed (per-image fault tolerance) — captioning ONE image
   * shouldn't tank a 30-image batch.
   *
   * IMPORTANT: this function reads from and writes to `cache`
   * concurrently when `concurrency > 1`. JS is single-threaded
   * within a microtask boundary, so the reads/writes themselves
   * don't race, but two concurrent tasks computing the SAME hash
   * may both see "no entry" and both call the LLM. That's fine —
   * we just spend an extra call. The LATER write wins; both
   * captions are valid anyway.
   */
  async function processOne(ref) {
    const absPath = options?.urlToAbsPath
      ? options.urlToAbsPath(ref.url)
      : ref.url.startsWith("/")
        ? ref.url
        : `${normalizePath(projectPath)}/wiki/${ref.url}`
    if (!absPath) {
      failed++
      return
    }

    let bytes
    try {
      bytes = await readFileAsBase64(absPath)
    } catch (err) {
      console.warn(
        `[caption-pipeline] failed to read ${absPath}:`,
        err instanceof Error ? err.message : err,
      )
      failed++
      return
    }

    const hash = await sha256OfBase64(bytes.base64)
    const hit = cache[hash]
    if (hit) {
      captionByUrl.set(ref.url, hit.caption)
      cachedCaptions++
      return
    }

    // Slice surrounding text for context-aware captioning. We
    // recompute here (rather than precompute alongside the ref)
    // so the worker pool reads the up-to-date `markdown`
    // closure; cheap (string slice + indexOf is microseconds).
    const { before, after } = sliceContext(markdown, ref, CONTEXT_CHARS)

    try {
      const caption = await captionImage(
        bytes.base64,
        bytes.mimeType,
        llmConfig,
        options?.signal,
        { contextBefore: before, contextAfter: after },
      )
      cache[hash] = {
        caption,
        mimeType: bytes.mimeType,
        model: llmConfig.model,
        capturedAt: new Date().toISOString(),
      }
      captionByUrl.set(ref.url, caption)
      freshCaptions++
    } catch (err) {
      console.warn(
        `[caption-pipeline] caption failed for ${absPath}:`,
        err instanceof Error ? err.message : err,
      )
      failed++
    }
  }

  // Concurrent worker pool. Each worker pulls from a shared index
  // pointer — first worker free grabs the next ref, no fancy queue.
  let nextIdx = 0
  async function worker() {
    while (true) {
      if (options?.signal?.aborted) return
      const i = nextIdx++
      if (i >= uniqueRefs.length) return
      await processOne(uniqueRefs[i])
      completed++
      options?.onProgress?.(completed, total)
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, uniqueRefs.length) }, () => worker()),
  )

  // Persist the (possibly grown) cache. Per-image atomic writes
  // would survive crashes mid-batch but every-image-disk-write
  // adds N file syncs to a captioning loop that's already slow;
  // one write at the end is the right trade.
  if (freshCaptions > 0) {
    try {
      await writeCache(projectPath, cache)
    } catch (err) {
      console.warn(
        `[caption-pipeline] failed to persist cache:`,
        err instanceof Error ? err.message : err,
      )
    }
  }

  // Rewrite the markdown — replace every captured image ref's alt
  // text with its caption. We use a callback-style replace rather
  // than running findImageReferences twice so we can sanitize the
  // alt text inline (no `]` characters or newlines, both of which
  // would break the markdown).
  const enrichedMarkdown = markdown.replace(
    MD_IMAGE_RE,
    (whole, openBang, _alt, closeBracket, url, closeParen) => {
      const caption = captionByUrl.get(url)
      if (!caption) return whole
      const safe = caption
        .replace(/[\r\n]+/g, " ") // collapse newlines
        .replace(/]/g, ")") // ] would close the alt early
        .trim()
      return `${openBang}${safe}${closeBracket}${url}${closeParen}`
    },
  )

  return { enrichedMarkdown, freshCaptions, cachedCaptions, failed }
}

// Exported for direct unit testing — keeps the module surface small
// while letting the test file pin behavior on the helpers.
export const __test = { findImageReferences, sha256OfBase64, MD_IMAGE_RE }

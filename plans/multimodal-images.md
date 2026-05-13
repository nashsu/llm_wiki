# Multimodal: image extraction + indexing for documents

**Status:** Historical implementation plan. Core extraction, captioning,
settings, and `raw/assets/<source-slug>/` storage have since been wired into
the app; keep this file as design rationale and deferred-work notes, not as a
current delivery checklist.

**Goal:** When a user ingests a PDF / PPTX / DOCX that contains images
(charts, diagrams, photos, screenshots), the images become discoverable
via the existing wiki search + chat flow alongside the document's text.

**Non-goals (this round):**
- "Search by image" / image-to-image retrieval — deferred to Phase 5.
- Editing or annotating images post-ingest.
- OCR-only path (Tesseract). VLM caption is strictly more capable; if
  cost becomes the issue we'll add OCR as a fallback later.
- Replacing / changing the existing chunker, embedding API, search
  ranking, or RAG pipeline. This work strictly **adds** a vision step
  on top.

---

## Current state (audit, not assumption)

`src-tauri/src/commands/fs.rs::preprocess_file`:

| Format | Current behavior | Image handling |
|---|---|---|
| PDF | `pdfium_render` → `page.text().all()` | **Ignored.** Embedded images, scans, charts all dropped. |
| PPTX | unzip → parse `ppt/slides/slideN.xml` | **Ignored.** `ppt/media/*.png|jpg` already in the ZIP, just not read. |
| DOCX | unzip → parse `word/document.xml` | **Ignored.** `word/media/*` same as above. |
| XLSX/ODS | `calamine` → cell text | Ignored. |
| Standalone images (.png/.jpg/...) | Read as binary in `read_file`; preview UI shows them | **Do NOT enter the ingest pipeline.** Never become wiki pages. |

Whole TS chain (`text-chunker.ts`, `embedding.ts`, `search.ts`,
`chat-panel.tsx`) is text-only. LanceDB v2 schema field is
`chunk_text: Utf8` — no provision for image bytes or paths.

Dependencies already present we can lean on:
- `pdfium-render` 0.9 — supports `page.objects()` iteration, including
  `PdfPageObjectType::Image` extraction
- `zip` 2.x — direct access to PPTX/DOCX `media/` directories
- LLM provider abstraction in `llm-providers.ts` — every provider
  (OpenAI / Anthropic / Gemini / Claude Code CLI) supports
  vision-message input on its native wire; we just don't expose it

---

## Design: caption-first hybrid (Option C from planning)

Three rejected alternatives are documented at the bottom of this file
for posterity. The chosen path:

1. **Extract images** from PDF / PPTX / DOCX during preprocess
2. **Save originals** to `<project>/raw/assets/<source-slug>/<n>.<ext>`
3. **Caption with vision LLM** ("describe factually, include any text,
   chart axes, key visual elements; 2–4 sentences")
4. **Inject as markdown** `![<caption>](raw/assets/<source-slug>/<n>.png)`
   into the source content fed to the analysis / generation prompts —
   so the LLM that builds the wiki page can place these images
   contextually
5. **Captions are ordinary text** — they flow through the existing
   `chunkMarkdown` → `embedPage` → `vector_upsert_chunks` pipeline
   with zero changes
6. **chat-message renders the markdown image** — the existing
   `react-markdown` setup already does this; it just needs the path
   to resolve to the right place

### Why this design

- **No schema change** to LanceDB. Captions are text chunks. Search
  works without modification.
- **No retrieval-quality regression.** Existing text-only retrieval
  paths are untouched. The chunker just sees more text (the
  captions) which makes images cite-able by their semantic content.
- **User sees the actual image** in chat replies, not just a textual
  description.
- **Provider-agnostic.** Every LLM provider we support has a vision
  format; we abstract over them in `buildBody`.
- **Phased.** Each phase is independently shippable and reversible.

### What this design does NOT solve (and that's OK for v1)

- Retrieving "an image that LOOKS like X" (visual similarity) — needs
  multimodal embedding (Phase 5, deferred).
- Captions that miss subtle details (e.g. "the third bar is taller
  than the second") — limited by VLM quality. Pro-tier models help;
  Flash Lite captions will be shallow.
- Image dedup across files (same logo / icon appearing 50 times) —
  handled by a SHA-256 hash cache, see Phase 1 risks below.

---

## Implementation phases

### Phase 1: Rust-side image extraction

New commands in `src-tauri/src/commands/fs.rs` (or a new
`src-tauri/src/commands/extract_images.rs` if `fs.rs` is getting too
big — currently 1100+ lines, leaning toward new file).

Public API shape (Tauri commands, callable from TS):

```rust
#[derive(Serialize)]
struct ExtractedImage {
    /// 1-based image index within the document (for filename)
    index: u32,
    /// PNG / JPEG / etc., as a MIME type
    mime_type: String,
    /// Page (PDF) or slide (PPTX) the image came from. None for DOCX.
    page: Option<u32>,
    /// Pixel width / height — used to filter out logos / icons.
    width: u32,
    height: u32,
    /// Image bytes, base64-encoded for IPC.
    data_base64: String,
}

#[tauri::command]
async fn extract_pdf_images(path: String) -> Result<Vec<ExtractedImage>, String>

#[tauri::command]
async fn extract_office_images(path: String) -> Result<Vec<ExtractedImage>, String>
```

Implementation notes:
- **PDF**: iterate `doc.pages()` → `page.objects()` → filter
  `PdfPageObjectType::Image` → `as_image_object().get_raw_image()`
  → encode to PNG via `image` crate (already a transitive dep
  through pdfium-render).
- **PPTX/DOCX**: open as ZIP, iterate file names matching
  `^(ppt|word)/media/.*\.(png|jpe?g|gif|webp|bmp)$`, read bytes
  directly — already in their native format.
- **Size filter**: drop images smaller than 100×100 (configurable
  later). Saves VLM cost on logos / decorations / cropping
  artifacts. ~80% noise removal in practice for slide decks.
- **Memory**: extract images in a `for` loop, not `collect()` — a
  100-page PDF with 50 images is ~50 MB before base64 (~67 MB
  after). Streaming through a `Vec<ExtractedImage>` is OK for IPC
  but we should be defensive against a pathological 5000-image
  document — add a `max_images: 500` cap.

Tests (`src-tauri/src/commands/extract_images.rs::tests`):
- Synthetic PDF with 1 known image → extract returns 1 entry with
  expected dims and non-empty bytes.
- Real PPTX from `tests/fixtures/` with multiple slides containing
  images → counts and sizes match.
- DOCX with no images → returns `Ok([])`, not an error.
- Password-protected PDF → returns the same error string the text
  extractor returns (consistent UX).

### Phase 2: Vision-message support in LLM abstraction

`src/lib/llm-providers.ts`:

```ts
// New union — replaces the existing `content: string` on ChatMessage
export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; mediaType: string; dataBase64: string }

export interface ChatMessage {
  role: "system" | "user" | "assistant"
  // Backwards-compatible: providers that don't get an image keep
  // calling sites working with plain strings. Block-array form
  // unlocks vision input.
  content: string | ContentBlock[]
}
```

Each provider's `buildBody` learns to translate `ContentBlock[]`:
- **OpenAI**: `[{type:"text",...}, {type:"image_url",image_url:{url:"data:image/png;base64,..."}}]`
- **Anthropic**: `[{type:"text",...}, {type:"image",source:{type:"base64",media_type:"image/png",data:"..."}}]`
- **Gemini**: `parts:[{text:"..."},{inline_data:{mime_type:"image/png",data:"..."}}]`
- **Claude Code CLI**: already takes content blocks (PR #61), just
  add `image` block type passthrough.
- **Ollama**: `messages[].images: [base64]` (separate field, not
  inline blocks). Conditional on the model — only `llava`,
  `qwen2.5-vl`, etc. accept it.

Existing test files (`llm-providers.test.ts`,
`__tests__/claude-cli-transport.test.ts`) need vision cases added.

### Phase 3: Captioning helper + ingest integration

`src/lib/vision-caption.ts` (new):

```ts
export async function captionImage(
  imageBase64: string,
  mediaType: string,
  llmConfig: LlmConfig,
  signal?: AbortSignal,
): Promise<string>
```

Implementation: build a `streamChat` call with a single user message
whose content is `[{type:"text",text:CAPTION_PROMPT},{type:"image",...}]`,
collect all tokens, return the joined string.

Caption prompt (pinned, factual, no markdown):

> Describe this image factually for a knowledge-base index. Include:
> any visible text verbatim, chart axes and values, diagram structure
> (boxes/arrows/labels), key visual elements. Do NOT speculate or
> editorialize. 2 to 4 sentences. Output plain text only — no
> markdown, no preamble.

`src/lib/ingest.ts` integration:

After `preprocess_file` returns text, BEFORE the analysis stage:

```ts
const images = await invoke('extract_pdf_images' or 'extract_office_images', { path })
const captioned = []
for (const img of images) {
  const relPath = `raw/assets/${slug}/img-${img.index}.${ext}`
  await writeFile(`${pp}/${relPath}`, base64ToBytes(img.data_base64))
  const caption = await captionImage(img.data_base64, img.mime_type, llmConfig, signal)
  captioned.push({ relPath, caption, page: img.page })
}

// Inject into sourceContent so the LLM sees them in context
const imageSection = captioned.length > 0
  ? '\n\n## Embedded Images\n\n' +
    captioned.map(c =>
      c.page
        ? `**[Page ${c.page}]** ![${c.caption}](${c.relPath})`
        : `![${c.caption}](${c.relPath})`
    ).join('\n\n')
  : ''
const enrichedSource = sourceContent + imageSection
// ... rest of autoIngest uses enrichedSource
```

Per-image cache keyed by SHA-256 of image bytes — same logo across
50 PDFs = 1 caption call, not 50. Cache lives in
`<project>/.llm-wiki/image-caption-cache.json` mapping
`hash → caption` (and image dimensions, mime, optionally the cached
file path so we deduplicate file storage too).

### Phase 4: Settings toggle + cost guardrails

`src/components/settings/sections/embedding-section.tsx` (or a new
"Multimodal" section if it grows): add a toggle.

```
☐ Index images from documents (uses extra LLM credits)
   Each image is captioned with a vision model. A 100-page paper
   with 30 images = 30 vision calls per ingest.
   Max images per document: [500]
   Skip images smaller than: [100]px on either side
```

Stored in `useWikiStore.embeddingConfig` (or a sibling
`multimodalConfig` if we want to keep them separate). Read by
`autoIngest` to decide whether to run Phase 1 + 3 at all.

**Default off.** Users opt in. README / changelog notes the cost
implication clearly.

### Phase 5 (deferred, NOT this round): multimodal embedding

Add a parallel embedding path that hits a multimodal endpoint
(`/v1/embeddings` with image input — supported by Voyage Multimodal,
Jina CLIP v2, some local CLIP servers). Store image-vector alongside
text chunk-vector in LanceDB (either same table with a `kind` field,
or a sibling `wiki_images` table).

This unlocks "find an image that looks like X" but is **strictly
additive** — caption-based retrieval keeps working as-is.

Requires user to have a multimodal embedding endpoint, which their
current LM Studio `qwen3-embedding-0.6b` is NOT.

---

## Open questions (resolve before / during Phase 1)

1. **Provider matrix**: which providers should the vision toggle
   actually enable? OpenAI / Anthropic / Gemini / Claude Code CLI all
   work. Ollama needs a vision-capable model (must check `cfg.model`
   against a known list). Custom endpoint depends on user's setup.
   MiniMax — uncertain, needs probe. **Tentative answer**: silently
   skip vision step on providers that don't support it; show a banner
   in Settings.

2. **Image size threshold**: 100×100 vs 80×80 vs 5KB byte threshold.
   Small images are usually icons / decorations. **Tentative**:
   100×100 default, exposed in Settings.

3. **Dedup strategy**: SHA-256 hash of image bytes → cache caption
   for that hash project-wide. **Tentative**: yes, default on.
   Cache invalidation tied to caption-prompt version.

4. **Per-document VLM cap**: a 500-page slide deck with 1500 images
   could blow up costs unnoticed. **Tentative**: hard cap at 500
   images per document, configurable. Beyond that, surface a
   warning in the activity panel and skip.

5. **What if the VLM call fails / times out?** Caption-less image
   should still be saved to disk and embedded as `![image](path)`
   without a caption — it's at least visible to the user, just not
   searchable by content. Soft failure, not hard.

6. **Standalone .png / .jpg imports**: do we treat them as
   single-image "documents" and run them through the caption path?
   **Tentative**: yes, but as a follow-up after Phase 1–4 land for
   embedded images.

7. **Image sub-dir naming**: `raw/assets/<source-slug>/` or flat
   `raw/assets/<slug>-<n>.<ext>`? Subdirs are cleaner; conflicts
   resolved by source-delete cascade automatically. **Chosen**:
   subdirs. Legacy `wiki/media/<source-slug>/` is migration input only.

---

## Risks

- **Cost**: Phase 3 is the expensive step. Mitigated by Phase 4
  toggle (default off) + dedup cache + per-doc cap.
- **Caption quality**: Flash Lite produces near-useless 1-sentence
  captions. Document this in Settings hint; recommend Sonnet+ for
  multimodal.
- **Performance**: each ingest now does N additional LLM calls in
  series. For a 30-image PDF, that's 30 × ~3s = 90s extra latency.
  We can parallelize the caption calls with `Promise.all` (the
  caption mutex doesn't apply — they're independent).
- **PDF extraction quality**: pdfium's image extraction returns the
  raw embedded image; for vector graphics (which PDFs sometimes
  use for charts) this fails — those are paths/text, not Image
  objects. We'd miss them. **Mitigation**: render the entire page
  to a PNG as fallback when no Image objects found AND the page
  has structural complexity. Defer to Phase 1.5 if Phase 1
  results are weak.

---

## Testing strategy

Per phase, in priority order:

**Phase 1 (Rust extraction):**
- Unit tests with synthetic + real fixtures
- Test on a known-good PDF (e.g. an arxiv paper) — verify image
  count matches manual count

**Phase 2 (vision message format):**
- Per-provider unit tests: assert correct wire format for each
- Mock-server test that the bytes-on-wire match each provider's
  documented schema

**Phase 3 (captioning + ingest):**
- Real-LLM test (gated by `RUN_LLM_TESTS=1`): pass a known image,
  verify caption is non-trivial and contains expected keywords
- Integration test: full autoIngest on a small fixture PDF with 2
  known images → assert raw/assets/ has the files + the generated
  page references them in markdown

**Phase 4 (toggle):**
- UI smoke test (manual)
- Unit test: when toggle is off, extract_*_images is never called

---

## Rejected alternatives (for posterity)

- **Pure VLM caption** (Option A): same as our chosen path BUT
  without saving the original image. User loses ability to see the
  image in retrieval. Rejected — UX regression.
- **Pure multimodal embedding** (Option B, no caption): no LLM cost
  at index time, true semantic image retrieval. Rejected because
  user's current embedding endpoint is text-only, AND we lose the
  ability to feed image content into LLM context (no caption text).
- **OCR-only**: useless for non-textual images (charts, photos).
  Rejected for v1; could be added as a fallback for VLM failures.

---

## Current Use

- Treat this document as historical context for the multimodal ingest design.
- Use current code and tests as the source of truth for implemented behavior.
- Deferred work remains useful only where explicitly marked as Phase 5 or
  follow-up risk mitigation.
- Historical phase estimates were removed because they no longer describe the
  current delivery state.

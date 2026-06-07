# turbovecdb — dedup prototype findings & gap list

Input to a **separate turbovecdb plan**. Produced by exercising the *existing*
Python turbovecdb (`~/src/turbovecdb`, unchanged) against the dedup
candidate-generation contract, with synthetic vectors and the real ~1000-page
Storm King wiki (`nomic-embed-text` @ `192.168.1.147:11434`, dim 768).

## Headline

**The existing turbovecdb is sufficient for dedup candidate-generation as-is —
no changes were required to run the prototype.** Every requirement passed.
Candidate-generation over 986 real pages ran in **~2.0 s** (vs the 30-min LLM
timeout the single-prompt scan hit). The real bottleneck is *embedding input
quality*, which is outside turbovecdb (see "Approach findings").

## Requirement verdicts (against the existing turbovecdb)

| Req | What it needs | Verdict |
|-----|---------------|---------|
| R1 BYO-vectors + metadata + documents | `upsert(ids, vectors, metadatas, documents)` | ✅ works |
| R2 per-project store, empty-safe, durable | `connect(path)` / `collection(create=True)` | ✅ works |
| R3 page-keyed record + metadata | id + arbitrary metadata dict | ✅ works |
| R4 upsert = replace-by-id | `upsert(ids=…)` | ✅ works |
| R5 count / delete-by-id | `count()`, `delete(ids=…)` | ✅ works |
| R6 candidate neighbors (top-K ≥ τ, exclude self) | per-page `query(vector,k,where)` | ✅ works |
| R7 exact cosine distance ∈ [0,2] | exact re-rank | ✅ works (self≈0, planted dupe 0.12 vs noise 0.88) |
| R8a `where` composes with **vector** search | filtered candidate pool | ✅ works (returns only `type=entity`) |
| R8b self-exclusion | `where {"slug": {"$ne": id}}` | ✅ works **via metadata field** (see Gap G4) |
| R9 ~1.5k vectors/768-d in seconds | latency | ✅ 1000 synthetic = 1.6 s; 986 real = 2.0 s |
| R10 dim%8==0 + reject mismatch | 768 ok | ✅ rejects 770 with clear `DimensionMismatchError` |

## Gaps (minor — for the separate turbovecdb plan)

- **G1 — No native "clear"/"drop collection".** Wiping a collection (full re-index)
  has no `collection.clear()` / `Database.drop_collection(name)`. Workaround used:
  `delete(where={"<field>": {"$ne": <sentinel>}})` → count 0. Cost: O(n) delete and
  a hacky predicate. *Want:* a first-class clear/drop.

- **G2 — `upsert` with duplicate ids in one batch throws an opaque error.**
  Passing the same id twice in a single `upsert` fails with
  `ValueError: id <internal-uid> already present in index` (an internal integer
  uid, not the offending user id). It neither dedupes-within-batch (last-wins) nor
  names the conflicting user id. *Want:* dedupe-within-batch, or an error naming the
  user id. *Caller workaround:* pre-dedupe by unique id before upsert.

- **G3 — No native batch / all-pairs query (optimization, not blocking).** Candidate
  generation is a per-page `query()` loop (986 calls = 2.0 s — fine at this scale).
  A native "for every vector, its top-K neighbors ≤ τ" self-join would cut round
  trips and scale better for larger corpora.

- **G4 — Self-exclusion can't filter the primary `id`.** `where={"id":{"$ne":x}}`
  returned `[]` (treated as an absent metadata field → excludes everything). You must
  duplicate the unique key into a metadata field (we used `pid`) and filter on that.
  *Want:* either allow `where` on the primary id, or document the convention.

## Approach findings (NOT turbovecdb — llm_wiki / embedding side)

- **F1 — Unique key must be the full wiki-relative path, not the basename slug.**
  Storm King had **25 basename collisions** across `entities/` vs `concepts/`
  (e.g. `annam-the-allfather` exists as both), and 6 more collide even within a type
  via subdirectories. Key vectors by `wiki/<type>/…/<slug>.md`. (The collisions are
  themselves prime dupe candidates.)

- **F2 — Embedding input quality dominates result quality.** `nomic-embed-text`
  collapses very short inputs to *identical* vectors: bare one-word titles
  (`Anauroch`, `Carat`, `Demon`) all came back at cosine distance **0.0000** to each
  other (the task prefix `search_document:` did not help). The same titles with a
  real one-line description separated cleanly (0.13–0.34, semantically sensible).

- **F3 — Low-content pages collapse and poison the candidate set — but they're a
  *gradient*, not a clean stub/non-stub split.** Measured on Storm King (1001 pages):
  only **15 are frontmatter-only stubs** (prose = 0; 13 concept, 2 entity), 75 are thin
  (prose 50–199), 911 are substantial (200+). The 15 stubs embed to *identical* vectors
  (F2) and produce **every** 0.000 false-positive pair. As a *duplicate source* the
  stubs are tiny and mostly distinct: 0 same-normalized-title clusters among them, just
  **1** real dup (`shattering-of-the-ordining` vs `…ordning`, a typo of a content page)
  — so for stubs the answer to "how many are the same?" is "almost none." Excluding the
  15 stubs surfaces **real** content dupes (`giant-reward-offered`↔`giant-reward` 0.000,
  `political-influence-…-policy`↔`…healthcare` 0.007, `giant-reward-denied`↔`…refused`
  0.012), but a **residual collapse cluster of thin/templated content pages remains**
  (the `plot-threads/` planning scaffolding — `comparisons`, `starstruck`,
  `opening-scene`, `synthesis` — and some boilerplate plot-event pages). Real
  cross-type dupes embed fine (`everard-barners-*` 0.04–0.08, `blagothkus` 0.23,
  `annam-the-allfather` 0.35).
  **Implications:**
  - Stubs (prose = 0) need a *separate* dedup path — **lexical** title/tag/`related`
    matching, not embeddings (nothing to embed). It's tiny and cheap and finds the
    typo dup.
  - Thin/templated content pages also collapse → embed the **full body** (chunked), not
    a short excerpt, and consider excluding planning/scaffolding subtrees from dedup.
  - Don't rely on a single global τ; the LLM-confirm step must carry a generously-sized
    candidate set. nomic + short text is a weak signal — a stronger or full-body
    embedding is worth testing.

## Reproduce

- `scripts/dedup_prototype/tvdb_contract_probe.py` — synthetic R1–R10 probe.
- `scripts/dedup_prototype/skt_candidate_gen.py` — real Storm King embed → index →
  candidate pairs (caches embeddings in `/tmp/skt_embed_cache.json`).

## Bottom line for sequencing

turbovecdb does **not** block the dedup redesign. The next real work is on the
llm_wiki side — richer page embedding input (F2/F3), path-based keys (F1), and the
candidate→LLM-confirm→human-review pipeline. The four turbovecdb gaps (G1–G4) are
quality-of-life and can wait for the separate turbovecdb plan / Rust rewrite.

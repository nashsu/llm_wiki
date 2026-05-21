# Dedup pass: semantic concept-identity resolution

**Status:** accepted

Domain terms live in [`CONTEXT.md`](../../CONTEXT.md). Realises Tier B of [ADR 0003](0003-defect-ownership.md); resolves references for [ADR 0004](0004-remove-stub-pages.md); slots into the stage order of [ADR 0001](0001-ingest-run-and-page-references.md).

## Context

Two defect families share one root question. Duplicate pages (`gossip` vs `gossip-protocol`, `column-oriented-storage` vs `columnar-storage`) and references that resolve to no page (`[[gossip]]` while `gossip-protocol` exists) are both asking *"is this name the same concept as an existing page?"* — one answer creates nothing and merges, the other resolves a reference. Treating them separately produced the observed waste: a string-only resolver leaves `[[gossip]]` unresolved, a later run builds a fresh `gossip` page, and only then is it found to duplicate `gossip-protocol`.

`dedupKey` ([ADR 0003](0003-defect-ownership.md)) catches orthographic variants but not meaning. The remaining 45 semantic-duplicate clusters need a judgement that string distance cannot make.

**An existing feature already does detection and merge.** `dedup.ts` / `dedup-runner.ts` / `dedup-queue.ts` provide a UI-triggered duplicate scan: `extractEntitySummary`, `detectDuplicateGroups` (LLM detector), `mergeDuplicateGroup` + `rewriteCrossReferences` (merge). The Dedup pass **reuses that core** and adds only what the UI scan lacks — a pre-filter so the LLM judges small candidate sets instead of every page in one prompt, and automatic wiring into the **Ingest run**.

## Decisions

### 1. A dedicated Dedup pass

A **follow-up pass** runs after **Catch-up** and before **Link pass**. Identity resolution is **not** a pre-creation check: mid-run the vector index lacks pages created earlier in the same run, and concurrent batches race. A single end-of-run pass sees every page.

### 2. Three-stage identity check — no separate NLP model

1. `dedupKey` exact bucket — orthographic variants, free and deterministic.
2. Vector nearest-neighbour over the existing embedding index — recalls semantic candidates.
3. The existing `detectDuplicateGroups` LLM detector judges *"is X the same concept as candidate Y?"* — run per pre-filtered candidate set, not over the whole wiki.

Stages 1–2 are the new pre-filter; stage 3 is the reused detector. Embedding similarity is **recall only**: antonyms such as `single-leader-replication` and `multi-leader-replication` sit close in embedding space but must never merge. The same-or-not call needs reasoning, so it is the LLM already in the pipeline — not a third inference system to host, version, and evaluate.

### 3. The pass merges pages; reference resolution stays deterministic

The Dedup pass does one thing: **merge duplicate pages**.

Resolving a reference that points at no page is *not* done by an LLM. The deterministic resolver (`resolveWikiSlugId`, [ADR 0002](0002-page-reference-unification.md)) is extended with a unique-**prefix** match (`gossip` → `gossip-protocol`) alongside the existing unique-suffix match. A reference that still resolves to nothing stays an **unresolved page reference** and reaches **backlog** via the missing-page **Review** ([ADR 0004](0004-remove-stub-pages.md)) — there is no per-reference semantic LLM check.

### 4. Merge reuses `dedup.ts`, not a new primitive

Merging reuses `mergeDuplicateGroup` (compute: LLM body fold + deterministic frontmatter union + whole-wiki cross-reference rewrite) and `executeMerge` (I/O: write the canonical page, apply rewrites, delete losers, rewrite `index.md`, snapshot a backup). Inbound references on pages this run never touched are still rewritten — `mergeDuplicateGroup` scans every wiki page.

**Canonical** is the `canonicalSlug` the detector returns — one of the group's existing page ids, picked as the clearest, most standard name. Losers' inbound references are rewritten to it regardless; inbound-reference count and creation date do not participate.

### 5. Auto-merge vs Review

The detector returns a `contradictory` flag and a `confidence` level per group. The Dedup pass auto-merges a group only when it is not `contradictory` and confidence is not `low`; otherwise it queues a `duplicate` **Review** and leaves the pages untouched for a human. Contradiction covers the fabricated-variant case ([ADR 0003](0003-defect-ownership.md) hallucination defect).

## Considered options

**A standalone small NLP model for semantic dedup** — rejected. Embedding similarity cannot tell same-concept from near-but-opposite; it can only recall. The judgement needs an LLM, and the pipeline already has one — a separate model is infrastructure with no added capability.

**Pre-creation dedup check** — rejected. The vector index is stale for pages created earlier in the same run, and batched generation races. An end-of-run pass is the only point where every page is visible.

**A semantic (vector + LLM) check per unresolved reference** — rejected. It would resolve cases like `gossip` → `gossip-protocol` that string matching misses, but at the cost of N vector searches plus LLM calls per run for a modest gain — and the missing-page **Review** already routes unresolved references to **backlog**. A unique-prefix extension to the deterministic resolver catches the common case for free and keeps Link pass deterministic.

## Consequences

- New stage in the [ADR 0001](0001-ingest-run-and-page-references.md) DAG: Catch-up → **Dedup pass** → Link pass.
- The Dedup pass reuses `dedup.ts` / `dedup-runner.ts`. The genuinely new code is the pre-filter (`wiki-dedup.ts`: `findDedupKeyClusters`, `findSemanticCandidates`, `buildDedupCandidateSets`), the `contradictory` + `canonicalSlug` fields on `DuplicateGroup`, and `runDedupPass` (the pre-filter → detect → auto-merge/Review orchestration).
- `eval/wiki-defect-patterns.jsonl` is the regression corpus — the Dedup pass must collapse its duplicate clusters without merging the antonym pairs.

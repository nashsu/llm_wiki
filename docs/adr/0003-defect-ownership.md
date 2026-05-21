# Defect ownership: ingest autonomy vs Review

**Status:** accepted

Domain terms live in [`CONTEXT.md`](../../CONTEXT.md). See [ADR 0004](0004-remove-stub-pages.md) for the missing-reference state machine and [ADR 0005](0005-dedup-pass.md) for the Dedup pass that realises Tier B.

## Context

A catalogue of 22 recurring ingest defects (`eval/wiki-defect-patterns.jsonl`) collapses to a few root causes: non-deterministic **page id** generation, no concept-identity check before page creation, no post-write validation, and structural pages (index, log) not treated as derived artifacts.

The catalogue invites a 1:1 "lint rule per defect" reaction. That is the wrong shape: it treats symptoms, and it duplicates **Review**, which already means "a follow-up item queued when ingest cannot safely fix something automatically." This project has no separate "lint" concept, and `CONTEXT.md` explicitly avoids the term "lint issue".

## Decision

Every defect class falls into exactly one of three tiers.

### Tier A — ingest determinism: prevent by construction, validate at runtime

Caused by a non-deterministic or unvalidated ingest step. Split by enforcement point — "fail the build" is imprecise, since pages are written at user runtime, not in CI.

**Prevented by construction — a single write chokepoint.** All entity/concept page writes go through one function that enforces canonical naming and a canonical frontmatter serializer. Page-id divergence (punctuation, version number, case, truncation), title↔page-id mismatch, and `---`-delimiter whitespace then cannot reach disk — there is nothing to assert or autofix after the fact. This needs two distinct normalization functions:

- `pageId(name)` — the human-readable canonical **page id**: hyphenated, lower-cased, with heuristic word-boundary splitting (`MapReduce` → `map-reduce`). Names files. Idempotent: `pageId(pageId(x)) == pageId(x)`.
- `dedupKey(id)` — the **dedup key**: all non-alphanumeric characters stripped, lower-cased (`map-reduce` and `mapreduce` → `mapreduce`). Used only by the Dedup pass identity check, never to name files. No heuristics — a `pageId` mistake only yields an ugly id, a `dedupKey` mistake builds a duplicate page.

CI guards these two functions with property tests (idempotency, stability). It does not — and cannot — assert the user's wiki is clean.

**Validated at runtime.** An empty body depends on LLM output, so no function can guarantee it. After each page write, ingest checks the body is non-empty; on failure it retries generation once, and if still empty does not write the page — the concept returns to the creation queue and a **Review** is queued, reusing the [ADR 0004](0004-remove-stub-pages.md) backlog mechanism. A single bad page never aborts the run. `created` is stamped with the real ingest date.

Fabricated/contradictory definitions are not a Tier A defect — they are only preventable by Dedup-pass identity resolution; see [ADR 0005](0005-dedup-pass.md).

### Tier B — concept identity: the Dedup pass

Duplicate pages and unresolved references are the same question — "is this name the same concept as an existing page?" — answered by a dedicated **Dedup pass** that runs after **Catch-up**, not by a pre-creation check (the vector index is stale mid-run; see [ADR 0005](0005-dedup-pass.md)).

The Dedup pass auto-merges duplicates when its LLM judge is confident and the pages' content is non-contradictory; it queues a **Review** only when content contradicts (a fabricated variant) or the canonical choice is genuinely ambiguous. "Not auto-merged" applies to those residual cases only — the clear majority is merged within the run.

### Tier C — deterministic zero-judgment fix; ingest applies it, no Review

Safe, rule-based, no judgment. Ingest fixes silently; nothing is queued.

- Normalize a **page reference**'s case to the target **page id**.
- Drop self-references.
- Normalize `related:` / `sources:` list items to a bare **page id**.
- Regenerate `index.md` and `log.md` as derived artifacts — idempotent write, deduplicated.

## Considered options

**A standalone "lint" tool** — rejected. Detection-only output is exactly **Review**; a parallel tool splits one concept in two, and `CONTEXT.md` avoids "lint issue".

**One detection rule per catalogued defect** — rejected. The 22 patterns collapse to ~4 root causes; mirroring the catalogue treats symptoms (e.g. four page-id-divergence patterns are one non-deterministic function).

## Consequences

- Tier A requires a single entity/concept write chokepoint — today writes are scattered across `writeFileBlocks` (`ingest.ts`), `post-ingest-materialize.ts`, and the **Manual save** path, so the chokepoint is itself a prerequisite refactor. CI guards `pageId` and `dedupKey` with property tests.
- Tier B is realised by the Dedup pass; see [ADR 0005](0005-dedup-pass.md) for the pass and [ADR 0004](0004-remove-stub-pages.md) for the connected missing-reference state machine.
- Tier C fixes belong in **Link pass** and **Global generation**; they must never queue a **Review**.

# Ingest run stage order

**Status:** accepted — stub-page behavior superseded by [ADR 0004](0004-remove-stub-pages.md)

Domain terms live in [`CONTEXT.md`](../../CONTEXT.md). See [ADR 0002](0002-page-reference-unification.md) for page reference unification and resolution policy, and [ADR 0004](0004-remove-stub-pages.md) for the removal of stub pages — **Manifest coverage** no longer creates stubs, and references this ADR's stage order accordingly.

## Context

Several production bugs came from treating the ingest pipeline as a linear script instead of a dependency graph: **Catch-up** ran before **stub pages** existed, and **Link pass** ran on a stale path list that excluded pages created by **Catch-up**.

## Decision

When batched entity generation applies, stages run in this order only:

```text
analysis
  → primary entity batches
  → Manifest coverage
  → Catch-up
  → Dedup pass
  → Link pass
  → Global generation
```

**Invariants:**

- **Manifest coverage** before **Catch-up** — manifest coverage enumerates every manifest entry and enqueues those without a **page**; catch-up drains that creation queue (see [ADR 0004](0004-remove-stub-pages.md)).
- **Catch-up** before **Dedup pass** — the dedup pass must see final entity/concept content before it merges duplicate pages and resolves references (see [ADR 0005](0005-dedup-pass.md)).
- **Dedup pass** before **Link pass** — link pass is deterministic and applies the dedup pass's reference resolutions and merged page set; it must not run on pages that are about to be merged away.
- **Link pass** before **Global generation** — link pass operates on entity/concept paths from this run; global generation writes structural pages (index, log, overview, source summary) afterward.
- After all write stages that touch entity/concept paths, recompute the path set passed to **Link pass** from everything written this run (batches, manifest coverage, catch-up, dedup pass) — do not freeze the list before catch-up.

**Manual save** is not an **Ingest run** and does not inherit this DAG.

## Considered options

**Catch-up before Manifest coverage** — rejected. Catch-up cannot drain a creation queue that manifest coverage has not yet populated; manifest entries stay missing.

**Link pass after Global generation** — rejected. Structural pages are out of scope for the entity/concept path list; moving link pass later drops normalization on the bulk of references written during batched ingest.

## Consequences

- Refactors that reorder `runBatchedEntityGeneration` or `autoIngestImpl` must preserve the DAG above; regression tests should assert state between stages (creation queue populated before catch-up, path list recomputed after catch-up).
- New post-processing stages must declare where they sit relative to **Global generation** and whether they need the full entity/concept path set.
- For reference resolution semantics, see [ADR 0002](0002-page-reference-unification.md); for semantic identity resolution and page merging, see [ADR 0005](0005-dedup-pass.md).

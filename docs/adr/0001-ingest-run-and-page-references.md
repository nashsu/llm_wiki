# Ingest run stage order

**Status:** accepted

Domain terms live in [`CONTEXT.md`](../../CONTEXT.md). See [ADR 0002](0002-page-reference-unification.md) for page reference unification and resolution policy.

## Context

Several production bugs came from treating the ingest pipeline as a linear script instead of a dependency graph: **Catch-up** ran before **stub pages** existed, and **Link pass** ran on a stale path list that excluded pages created by **Catch-up**.

## Decision

When batched entity generation applies, stages run in this order only:

```text
analysis
  → primary entity batches
  → Manifest coverage
  → Catch-up
  → Link pass
  → Global generation
```

**Invariants:**

- **Manifest coverage** before **Catch-up** — catch-up targets missing files or **stub pages** on disk; stubs are created by manifest coverage.
- **Catch-up** before **Link pass** — link pass must see final entity/concept content (or stubs that will not be link-normalized as final).
- **Link pass** before **Global generation** — link pass operates on entity/concept paths from this run; global generation writes structural pages (index, log, overview, source summary) afterward.
- After all write stages that touch entity/concept paths, recompute the path set passed to **Link pass** from everything written this run (batches, stubs, catch-up) — do not freeze the list before catch-up.

**Manual save** is not an **Ingest run** and does not inherit this DAG.

## Considered options

**Catch-up before Manifest coverage** — rejected. Catch-up cannot replace stubs that do not exist yet; manifest entries stay missing or half-written.

**Link pass after Global generation** — rejected. Structural pages are out of scope for the entity/concept path list; moving link pass later drops normalization on the bulk of references written during batched ingest.

## Consequences

- Refactors that reorder `runBatchedEntityGeneration` or `autoIngestImpl` must preserve the DAG above; regression tests should assert disk state between stages (stub present before catch-up, path list after catch-up).
- New post-processing stages must declare where they sit relative to **Global generation** and whether they need the full entity/concept path set.
- For reference resolution semantics, see [ADR 0002](0002-page-reference-unification.md).

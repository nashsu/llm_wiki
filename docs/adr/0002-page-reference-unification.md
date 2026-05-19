# Page reference unification

**Status:** accepted

Domain terms live in [`CONTEXT.md`](../../CONTEXT.md). See [ADR 0001](0001-ingest-run-and-page-references.md) for ingest run stage ordering.

## Context

The knowledge graph showed zero edges while `related:` frontmatter was populated. The root cause was split readers and writers: the knowledge graph counted only body **wikilinks**, while ingest wrote most **page references** into **Related**. Because the two expression forms used separate resolution rules, they produced separate — and contradictory — views of the link graph.

## Decisions

### 1. One concept: page reference

A **page reference** (target **page id**) may be expressed as **Related** or **Wikilink**. Readers (knowledge graph, navigation) and writers (ingest, link pass) must use the same resolution rules for both — not separate "graph links" vs "frontmatter links."

### 2. Reference resolution policy (hybrid)

- **Link pass** (and equivalent normalization): rewrite shorthand targets to canonical **page id** when exactly one page matches (e.g. unique suffix: `spark` → `apache-spark`).
- If ambiguous or missing: leave **unresolved**, queue a **Review** where appropriate; do not invent edges or navigation targets.
- **Knowledge graph**: draw edges only for **resolved page references**; count both **Related** and body **wikilinks** as sources of references.

## Considered options

**Strict page-id-only references (no heuristic resolution)** — rejected for ingest. LLMs routinely emit shorthand; unique-match rewrite during **Link pass** reduces false "broken link" UI without guessing when ambiguous.

**Separate domain types for Related vs Wikilink** — rejected. Split readers/writers recreated the "0 links in graph but related: populated" failure mode.

## Consequences

- Implementation modules (`post-ingest-wikilinks.ts`, `wiki-graph.ts`, `wiki-page-resolver.ts`) must apply the same resolution function to both **Related** and **Wikilink** targets.
- Behavior changes that alter resolution rules for one expression form but not the other violate this ADR and need a revision, not silent drift.
- For stage ordering that governs when **Link pass** runs, see [ADR 0001](0001-ingest-run-and-page-references.md).

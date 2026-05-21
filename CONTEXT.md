# LLM Wiki

A local-first research wiki: sources live in `raw/`, knowledge is materialized as markdown pages under `wiki/`, and **Ingest** turns one source into many updated pages.

## Language

**Source**:
An original file under `raw/sources/` (PDF, markdown, etc.) that **Ingest** reads to produce or update wiki **pages**.
_Avoid_: document (when you mean the raw file specifically)

**Ingest**:
The product capability that turns **sources** into wiki **pages** — chiefly by running an **Ingest run**, with lighter paths such as **Manual save**.
_Avoid_: import, sync

**Ingest run**:
One end-to-end processing of exactly one **source** through analysis, entity/concept writing, **follow-up passes**, and (when applicable) **global generation**. Stage order is part of the run contract.
_Avoid_: batch job, pipeline run, auto ingest (redundant)

**Entity manifest**:
The machine-readable list of entities and concepts the analysis stage commits to materialize as **pages** in this **Ingest run**.
_Avoid_: entity list, ENTITIES block (implementation)

**Follow-up pass**:
A mandatory stage after primary entity batches in an **Ingest run**, in fixed order: **Manifest coverage** → **Catch-up** → **Dedup pass** → **Link pass**.
_Avoid_: post-ingest (implementation folder name; use **follow-up pass** in domain speech)

**Manifest coverage**:
A deterministic **follow-up pass** that ensures every **entity manifest** entry either has a **page** or is enqueued for creation, unions **source** provenance on existing **pages**, and queues **reviews** for **unresolved page references** outside the manifest.
_Avoid_: materialize, materialization

**Catch-up**:
An LLM **follow-up pass** that creates **pages** still missing after **Manifest coverage** by draining the creation queue.
_Avoid_: catch-up batch (implementation)

**Dedup pass**:
A **follow-up pass** after **Catch-up** that resolves concept identity: it merges duplicate **pages** and **resolves** **page references** the deterministic resolver could not place, using a three-stage check (**dedup key** bucket → vector recall → LLM judgement). See [ADR 0005](docs/adr/0005-dedup-pass.md).
_Avoid_: merge pass, dedupe pass

**Link pass**:
A deterministic **follow-up pass** that applies the **Dedup pass**'s reference resolutions, **resolves** remaining shorthand **page references** in **Related**, and adds **wikilinks** in body text for **pages** touched by this run.
_Avoid_: post-link, post-linking

**Global generation**:
The final LLM stage of an **Ingest run**, after all **follow-up passes**, writing structural **pages** for this **source** (source summary, index, log, overview — not batched entity/concept pages).
_Avoid_: Step 2, generation pass

**Manual save**:
Writing **pages** from an interactive chat turn (`Save to Wiki`) — not an **Ingest run**; no **entity manifest** or **follow-up pass** guarantees. After **pages** are written, the app runs **catalog reconcile** on `wiki/index.md` (adds missing lines only; does not fix incorrect LLM index lines). The LLM may still emit a full `wiki/index.md` block; reconcile runs afterward.
_Avoid_: chat ingest (informal only), partial ingest

**Page**:
A markdown file under `wiki/` that represents one piece of knowledge (entity, concept, source summary, index, etc.).
_Avoid_: node, document (unless talking about the original PDF/markdown source file)

**Page id**:
The canonical identifier for a page — the filename without `.md` (e.g. `apache-spark` for `wiki/entities/apache-spark.md`). Always produced by `pageId(name)`: hyphenated, lower-cased, with heuristic word-boundary splitting.
_Avoid_: slug (in conversation OK; in glossary prefer **page id**), filename

**Dedup key**:
A page's **page id** with all non-alphanumeric characters stripped and lower-cased (`map-reduce` and `mapreduce` both → `mapreduce`). The bucket key the **Dedup pass** uses to find orthographic duplicates — never used to name files.
_Avoid_: normalized slug, canonical key

**Page reference**:
A directed link from one page to another, identified by the target **page id**.
_Avoid_: link (too vague — collides with graph UI and URL links), edge, relation

**Related**:
A **page reference** stored in a page's YAML frontmatter (`related:` list). Preferred when the LLM or ingest pipeline writes many references at once.
_Avoid_: treating Related as a different kind of relationship from wikilinks

**Wikilink**:
A **page reference** written in markdown body as `[[page-id]]` or `[[page-id|display text]]`.
_Avoid_: treating Wikilink as a different kind of relationship from Related

**Resolved page reference**:
A **page reference** whose target string maps to exactly one existing **page id** in the wiki.
_Avoid_: canonical link, valid link

**Unresolved page reference**:
A **page reference** that cannot be mapped to a unique **page id** (missing target page, or ambiguous shorthand such as two pages ending in `-spark`).
_Avoid_: broken link, dangling link

**Review**:
A human follow-up item queued when ingest cannot safely fix something automatically (e.g. an **unresolved page reference** on an otherwise-written page).
_Avoid_: warning, lint issue

## Relationships

- One **Ingest run** processes exactly one **source**
- **Ingest run** stage order (when batched entity generation applies): analysis → primary entity batches → **Manifest coverage** → **Catch-up** → **Dedup pass** → **Link pass** → **Global generation** (follow-up order and placement before **Global generation** are invariant)
- A **Manual save** is not an **Ingest run**
- A referenced concept is in exactly one of three states: **created** (a **page** with real content exists), **queued** (an **entity manifest** entry of the current **Ingest run**, not yet written), or **backlog** (referenced but in no manifest, and the **Dedup pass** confirmed no existing page) — never a placeholder page; see [ADR 0004](docs/adr/0004-remove-stub-pages.md)
- An **Ingest run** creates pages only for its **entity manifest** entries; it does not follow **page references** to create further pages — non-manifest references go to the **Dedup pass**, which either resolves them to an existing **page** or sends the concept to **backlog**
- A **Page** has zero or more outgoing **page references** (expressed as **Related** and/or **Wikilink**)
- Every **page reference** should eventually target exactly one **page id**; until then it is **unresolved**
- **Reference resolution** (policy): after ingest, rewrite shorthand targets to **page id** when the match is unique; leave **unresolved** references unchanged and queue a **Review**; the knowledge graph draws only **resolved page references**
- The knowledge graph visualizes **resolved page references** between **pages** — not a separate "link type" per syntax

## Example dialogue

> **Dev:** "The graph shows 0 links but `hadoop.md` has `related: [spark]` — are links broken?"
> **Domain expert:** "No — **page references** exist in Related. The graph reader must count **page references**, not only **wikilinks** in the body. And `spark` must be **resolved** to the **page id** `apache-spark` before we draw the edge. If two pages could match, leave it **unresolved** and queue a **Review** — don't guess."

> **Dev:** "Can we run **Link pass** after **Global generation** so the new index picks up wikilinks?"
> **Domain expert:** "No — **Link pass** runs on entity/concept **pages** from this run before **Global generation**. Moving it later would skip those paths and break **Ingest run** contract."

## Flagged ambiguities

- "Ingest" is sometimes used loosely for **Manual save** — prefer **Manual save** when the chat path is meant.

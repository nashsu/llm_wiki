# Remove stub pages; missing references unified as unresolved + Review

**Status:** accepted — supersedes the stub-creation behavior of [ADR 0001](0001-ingest-run-and-page-references.md)

Domain terms live in [`CONTEXT.md`](../../CONTEXT.md). See [ADR 0003](0003-defect-ownership.md) for the defect-tier model and [ADR 0005](0005-dedup-pass.md) for the Dedup pass that resolves references.

## Context

Two halves of one problem fight each other. **Manifest coverage** creates **stub pages** for manifest entries not yet written; a separate path leaves **unresolved page references** dangling or generates `missing-page-*` placeholder pages. The defect catalogue shows the cost: 75 unfilled stubs, 9 redundant `missing-page-*` placeholders, 66 references to never-created pages — plus stub and placeholder pages that became redundant once the real page appeared, with no merge.

A referenced concept currently has no single well-defined lifecycle, so different ingest paths invent contradictory placeholders.

## Decision

### 1. No placeholder pages

Remove **stub pages** and `missing-page-*` placeholder pages entirely. A page exists only when it has real content.

### 2. A referenced concept has exactly three states

- **created** — the page exists with real content.
- **queued** — an **entity manifest** entry of the current **Ingest run**, not yet written.
- **backlog** — a concept referenced but in no manifest, which the **Dedup pass** has semantically confirmed has no existing page; carried as a **Review** and as the work signal for a later run.

There is no fourth state. A concept is never represented by an empty or placeholder page.

### 3. The manifest is the run's creation scope — no transitive page-chasing

An **Ingest run** creates pages only for its **entity manifest** entries. **Catch-up** fills manifest entries still missing; the run does **not** follow **page references** out of those pages to create further pages. Depth past the manifest is deliberate scope creep — chasing references is how one session produced 600+ pages and 75 stubs.

A non-manifest **page reference** is resolved by the deterministic resolver (`resolveWikiSlugId` — unique suffix/prefix match, [ADR 0002](0002-page-reference-unification.md)): if it maps to an existing page, nothing is created; otherwise it stays an **unresolved page reference** and the concept enters **backlog**.

### 4. References are never downgraded automatically

An unresolved or backlog **page reference** stays in place as a reference — it is the signal for what a later run should build. The automatic pipeline never rewrites `[[X]]` to plain text. Only an explicit human **Skip** (decision 5) does.

### 5. A backlog Review has no one-click "Create Page"

A backlog **Review** is a signal, not a fillable task. The one-click "Create Page" action is removed — it was the source of `missing-page-*` placeholder pages, and a backlog concept has no **source** to ground real content. A backlog Review resolves three ways:

- **Automatically** — a later **source** whose manifest includes the concept builds a real page; the Review then auto-closes.
- **Research and build** (explicit, heavy) — the user triggers grounded generation via the deep-research / web-search path, producing a real sourced page rather than a stub.
- **Skip** — the user judges the concept does not warrant a page; only then is the reference downgraded to plain text.

## Considered options

**Transitive page-chasing with a depth/budget cap** — rejected. Any depth past the manifest is arbitrary (why one hop, not two?), and chasing references is precisely how one session produced 600+ pages and 75 stubs. The manifest — the analysis stage's deliberate scope — is the only non-arbitrary boundary.

**One-click "Create Page" on a backlog Review** — rejected. A backlog concept has no source; one-click creation produces ungrounded placeholder pages, the exact `missing-page-*` defect this ADR removes.

**Downgrade unbuilt references to plain text automatically** — rejected. It yields a cleaner final state but erases the "a concept belongs here" signal, contradicting the project thesis of a continually-completed concept index. Only an explicit human **Skip** downgrades.

**Keep stub pages, add a dedup/merge pass** — rejected. Stub pages exist only to stand in for the missing lifecycle; the three-state model removes the need rather than patching it.

## Consequences

- [ADR 0001](0001-ingest-run-and-page-references.md) is revised to match: **Manifest coverage** no longer creates **stub pages**, and its "Manifest coverage before Catch-up" invariant now reads as enqueue-then-drain rather than create-stub-then-replace.
- `CONTEXT.md` is revised to match: the **Stub page** glossary entry is removed, **Manifest coverage** and **Catch-up** drop stub language, and the three-state concept lifecycle is added to **Relationships**.
- The knowledge graph and **Review** queue already model **unresolved page reference** — backlog reuses them; no new term is introduced.
- Semantic reference resolution and the resolved-vs-backlog decision belong to the **Dedup pass**; see [ADR 0005](0005-dedup-pass.md).
- The missing-page **Review** loses its "Create Page" option and gains "Research and build" and "Skip"; the deep-research / web-search path becomes the only way to manually materialise a backlog concept.

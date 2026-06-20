# Auto Link Review Design

## Purpose

LLM Wiki users can manually add new wiki pages, but graph connections only appear when page bodies contain `[[wikilink]]` references. Auto Link Review helps users discover and apply those links without giving the model permission to rewrite research notes.

The first version focuses on the currently opened wiki page. Batch processing is explicitly out of scope until the single-page review flow is proven useful.

## User Experience

Add an `Auto Link` action to the Wiki Reader page header.

When the user clicks it:

1. The app scans the current page body.
2. The app compares possible terms against the existing wiki page catalog.
3. A review panel opens with a summary:
   - high-confidence suggestions, default selected
   - medium-confidence suggestions, visible but unselected
   - low-confidence suggestions, collapsed by default
4. The user can select suggestions, switch to an alternative target, ignore a term, or ignore a term-target pair.
5. `Apply Selected` inserts `[[wikilink]]` references and refreshes graph data.

High-confidence suggestions are never written before user confirmation. "Automatic" means "default selected", not "silently applied".

## Candidate Flow

The model is only responsible for semantic discovery. Code owns validation, ranking, alternatives, and ignore rules.

```text
read page + read wiki index
  -> LLM suggests raw { term, target } candidates
  -> code validates targets against Page Catalog
  -> code recalls alternatives by matching term against every catalog page
  -> code assigns High / Medium / Low confidence bands
  -> code applies project ignore rules
  -> user reviews
  -> code applies selected links
```

This avoids relying on model-supplied confidence scores and prevents hallucinated target pages from reaching the review UI.

## Page Catalog

Build a catalog from real wiki pages under `wiki/`.

Each entry should include:

```ts
interface PageCatalogEntry {
  slug: string
  title: string
  type: string
  tags: string[]
  path: string
}
```

Future versions may add aliases and previously observed display text, but v1 only needs slug, title, type, tags, and path.

## Confidence Bands

Use bands instead of user-facing numeric scores.

### High

Default selected and shown first.

Conditions:

- term exactly matches a slug
- term exactly matches a title
- term is an acronym or gene/protein-like symbol and has exactly one strong catalog match

Examples: `GDF3 -> gdf3`, `HDAC3 -> hdac3-in-macrophages`.

### Medium

Visible but not selected by default.

Conditions:

- term is clearly related to a title but not exact
- exact or strong match exists, but the same term has multiple plausible targets
- cross-language title/slug match is plausible but not deterministic

### Low

Collapsed by default.

Conditions:

- term is too generic
- term is very short without acronym/gene-symbol evidence
- several pages only partially match
- target relation is weak or ambiguous

Low suggestions should not interrupt the normal review flow.

## Ignore Rules

Store project-local ignore rules at:

```text
.llm-wiki/auto-link-ignore.json
```

Shape:

```json
{
  "terms": ["inflammation", "mechanism"],
  "pairs": [
    { "term": "EMP", "target": "early-emp-vs-late-emp" }
  ]
}
```

Rules:

- ignored terms suppress all candidates for that literal term in the current project
- ignored pairs suppress only that term-target relation
- ignore rules do not apply across projects

## Function Boundaries

Refactor `src/lib/enrich-wikilinks.ts` without changing the existing all-in-one API behavior.

```ts
export interface LinkEntry {
  term: string
  target: string
}

export async function suggestWikilinks(
  projectPath: string,
  filePath: string,
  llmConfig: LlmConfig,
): Promise<LinkEntry[]>

export async function applyWikilinks(
  projectPath: string,
  filePath: string,
  selectedLinks: LinkEntry[],
): Promise<void>

export async function enrichWithWikilinks(
  projectPath: string,
  filePath: string,
  llmConfig: LlmConfig,
): Promise<void>
```

`suggestWikilinks` reads the page and index, calls the LLM, parses the response, and returns raw candidates. It does not write files.

`applyWikilinks` reads the current page, calls exported `applyLinks`, writes the updated page, and bumps `dataVersion`.

`enrichWithWikilinks` remains backwards compatible by calling `suggestWikilinks` and then `applyWikilinks` with all suggested links.

Export `parseLinkResponse` and `applyLinks` for focused tests and reuse.

## Link Application Safety

The existing `applyLinks` design should stay: it edits only the original content by inserting `[[...]]` around selected terms. It must not ask the LLM to rewrite the page.

While implementing the review feature, fix the existing occurrence check so a term is skipped if it falls anywhere inside an existing `[[...]]` range. The current narrow check only inspects nearby characters and can miss some existing wikilinks.

## Review Panel

The panel needs these actions:

- select or deselect a suggestion
- choose an alternative target when available
- ignore this term
- ignore this term-target pair
- apply selected
- cancel without writing

After apply:

- write selected links only
- refresh current file content
- bump `dataVersion`
- refresh the graph if the graph view is active or when it is next opened

## Testing

Keep existing `enrichWithWikilinks` tests passing.

Add tests for:

- `suggestWikilinks` returns candidates without writing files
- `applyWikilinks` applies only selected links
- `applyLinks` does not link terms already inside any `[[...]]` span
- confidence banding for exact slug, exact title, acronym, multi-target, and generic-term cases
- ignore rules suppress ignored terms and ignored pairs
- review panel defaults: High selected, Medium unselected, Low collapsed

## Out of Scope

- batch processing multiple pages
- background scan on every save
- embedding-based alternatives
- model-supplied confidence scores
- automatic writes before user confirmation

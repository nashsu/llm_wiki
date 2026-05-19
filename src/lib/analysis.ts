// Analysis is the first LLM step in the ingest pipeline. Its job is to
// read one chunk of a source document and emit (1) a machine-readable
// entity manifest used to drive batched page generation, and (2) prose
// analysis used as context by downstream prompts.
//
// This module owns the full contract between the Analysis LLM call and
// its downstream consumers. The contract has three pillars:
//
//   1. The PROMPT (`buildAnalysisPrompt`) instructs the LLM to emit a
//      single `<entities>...</entities>` block at the very top of its
//      response, then prose analysis below.
//
//   2. The PARSER (`parseAnalysisOutput`) reads the LLM's raw text and
//      returns a typed `AnalysisPart` — entities pre-extracted, prose
//      with the manifest already stripped out. Consumers MUST go through
//      this parser; they never re-search the raw text themselves.
//
//   3. The TYPE (`AnalysisPart`) is the only thing that crosses the
//      module boundary. Downstream code receives typed data; it can't
//      accidentally pass the raw manifest back to another LLM as
//      "context" (which was a real bug before this refactor).
//
// Design notes:
//   - We use `<entities>` XML-style tags instead of the older `<!-- ENTITIES -->`
//     HTML-comment trick because models follow XML markers more reliably,
//     and parsing is robust to whitespace and minor format drift.
//   - The manifest is emitted FIRST (not appended at the end) so that an
//     output-token cap on long documents truncates the prose tail rather
//     than the manifest — losing prose degrades quality, losing the
//     manifest kills the entire batched-generation path.
//   - `parseAnalysisOutput` never throws. A missing manifest, malformed
//     JSON, or invalid items all degrade gracefully to "no entities";
//     `manifestFound` distinguishes "model checked and found none"
//     (`true`, `entities: []`) from "manifest section absent or
//     unparseable" (`false`).

import { buildLanguageDirective } from "@/lib/output-language"

/** A single entity or concept from the Analysis manifest. */
export interface AnalysisEntity {
  name: string
  type: "entity" | "concept"
}

/** The structured contract returned by `parseAnalysisOutput`. One per
 *  source chunk. Downstream consumers (batch driver, batch context,
 *  generation context) consume the typed fields directly — they never
 *  re-parse `prose` looking for hidden machine-readable artifacts. */
export interface AnalysisPart {
  /** Index of the source chunk this part covers (0-based). */
  chunkIndex: number
  /** Entities extracted from the manifest block. Empty array means
   *  either the model emitted an empty `[]` manifest, or the manifest
   *  was missing/malformed — check `manifestFound` to disambiguate. */
  entities: AnalysisEntity[]
  /** Whether a parseable `<entities>` block was found in the raw output.
   *  `true` + empty `entities` = model explicitly said "nothing here".
   *  `false` = no manifest at all, caller should fall back. */
  manifestFound: boolean
  /** The raw LLM response with the `<entities>` block removed.
   *  Suitable to pass as prose context to downstream prompts. */
  prose: string
}

// Matches a single `<entities>...</entities>` block. Tolerates
// whitespace inside the opening/closing tags (`< entities >`) and any
// whitespace/newlines around the JSON payload. Non-greedy `[\s\S]*?` so
// we don't swallow content across multiple blocks if a (misbehaving)
// model emits more than one.
const ENTITIES_BLOCK_REGEX = /<\s*entities\s*>\s*([\s\S]*?)\s*<\s*\/\s*entities\s*>/gi

/**
 * Parse one Analysis LLM response into a typed `AnalysisPart`.
 *
 * The function is total — it never throws. Malformed input degrades to
 * `{ entities: [], manifestFound: false, prose: <raw text> }` so the
 * caller can decide whether to fall back to legacy single-call generation.
 *
 * A partially-bad manifest (one item has invalid type) keeps the valid
 * items and drops the rest, rather than rejecting the whole block.
 */
export function parseAnalysisOutput(rawText: string, chunkIndex: number): AnalysisPart {
  const matches = [...rawText.matchAll(ENTITIES_BLOCK_REGEX)]

  if (matches.length === 0) {
    return { chunkIndex, entities: [], manifestFound: false, prose: rawText.trim() }
  }

  const entities: AnalysisEntity[] = []
  let anyParsed = false

  for (const m of matches) {
    const payload = m[1].trim()
    if (!payload) {
      anyParsed = true
      continue
    }
    try {
      const parsed = JSON.parse(payload)
      anyParsed = true  // block was present and valid JSON, even if not an array
      if (!Array.isArray(parsed)) continue
      for (const raw of parsed) {
        if (!raw || typeof raw !== "object") continue
        const name = typeof raw.name === "string" ? raw.name.trim() : ""
        const type =
          raw.type === "concept" ? "concept" : raw.type === "entity" ? "entity" : null
        if (!name || !type) continue
        entities.push({ name, type })
      }
    } catch {
      // Malformed JSON — fall through; if no block parses, manifestFound stays false.
    }
  }

  const prose = rawText.replace(ENTITIES_BLOCK_REGEX, "").trim()
  return { chunkIndex, entities, manifestFound: anyParsed, prose }
}

/**
 * Build the Analysis system prompt.
 *
 * Output contract enforced by this prompt:
 *   1. Response begins with a single `<entities>...</entities>` block
 *      containing a JSON array (one line, no nesting).
 *   2. After the block, free-form markdown prose analysis.
 *
 * Why the manifest comes FIRST in the response: see module header.
 *
 * `sourceContent` is used only for language detection — the actual
 * chunk content is passed via the user message, not embedded here.
 */
export function buildAnalysisPrompt(
  purpose: string,
  index: string,
  sourceContent: string = "",
): string {
  return [
    "<role>",
    "You are an expert research analyst. Read the source document and produce a structured analysis with a machine-readable entity manifest at the top.",
    "Do not output chain-of-thought, hidden reasoning, or a thinking transcript. Reason internally and write only the final structured output.",
    "</role>",
    "",
    "<output_contract>",
    "Your response MUST begin with a `<entities>` block, then prose analysis. Exact format:",
    "",
    "    <entities>",
    '    [{"name":"Entity Name","type":"entity"},{"name":"Concept Name","type":"concept"}]',
    "    </entities>",
    "",
    "    ## Key Entities",
    "    ... prose ...",
    "",
    "Rules for the `<entities>` block:",
    "- Opening `<entities>` MUST be on its own line; closing `</entities>` MUST be on its own line.",
    "- The JSON array MUST be on a single line between them (no nested newlines).",
    "- Each item has exactly two fields: `name` (string, canonical display name) and `type` (either `\"entity\"` or `\"concept\"`).",
    "  Use `\"entity\"` for concrete named things: people, organizations, products, datasets, tools, systems, places.",
    "  Use `\"concept\"` for abstract ideas: theories, methods, techniques, algorithms, phenomena, principles.",
    "- Include EVERY entity and concept worth a dedicated wiki page — do not pre-filter. Listing 80+ items is expected for dense documents.",
    "- If the source genuinely has no entities/concepts, emit `<entities>\n[]\n</entities>`.",
    "</output_contract>",
    "",
    "<prose_sections>",
    "After the `<entities>` block, write prose analysis covering:",
    "",
    "## Key Entities",
    "List people, organizations, products, datasets, tools mentioned. For each:",
    "- Name and type",
    "- Role in the source (central vs. peripheral)",
    "- Whether it likely already exists in the wiki (check the index)",
    "",
    "## Key Concepts",
    "List theories, methods, techniques, phenomena. For each:",
    "- Name and brief definition",
    "- Why it matters in this source",
    "- Whether it likely already exists in the wiki",
    "",
    "## Main Arguments & Findings",
    "- What are the core claims or results?",
    "- What evidence supports them?",
    "- How strong is the evidence?",
    "",
    "## Connections to Existing Wiki",
    "- What existing pages does this source relate to?",
    "- Does it strengthen, challenge, or extend existing knowledge?",
    "",
    "## Contradictions & Tensions",
    "- Does anything in this source conflict with existing wiki content?",
    "- Are there internal tensions or caveats?",
    "",
    "## Recommendations",
    "- What wiki pages should be created or updated?",
    "- What should be emphasized vs. de-emphasized?",
    "- Any open questions worth flagging for the user?",
    "",
    "Be thorough but concise. Focus on what's genuinely important.",
    "If a folder context is provided, use it as a hint for categorization — the folder structure often reflects the user's organizational intent (e.g., 'papers/energy' suggests the file is an energy-related paper).",
    "</prose_sections>",
    "",
    "<language_rule>",
    buildLanguageDirective(sourceContent),
    "</language_rule>",
    "",
    purpose ? `<wiki_purpose>\n${purpose}\n</wiki_purpose>` : "",
    index ? `<current_wiki_index>\n${index}\n</current_wiki_index>` : "",
  ]
    .filter(Boolean)
    .join("\n")
}

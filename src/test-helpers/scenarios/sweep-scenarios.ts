/**
 * Authoritative definitions of sweep-behavior scenarios.
 * Edit here to change a scenario — the runner materializes these to disk.
 */
import type { SweepScenario } from "./types"

const SHARED_PURPOSE = `# Purpose

This wiki tracks deep-learning research papers and the core concepts
they introduce or rely on. Pages aim to be short, encyclopedic, and
linked via [[wikilinks]] to neighboring concepts.
`

const SHARED_INDEX = `# Index

## Concepts
- [[attention]]
- [[transformer]]

## Papers
`

// ── Helpers for readable content ─────────────────────────────────────────────

function page(title: string, body: string, extras: Record<string, string> = {}): string {
  const fm = Object.entries({ title, ...extras })
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n")
  return `---\n${fm}\n---\n\n# ${title}\n\n${body}\n`
}

// ── Scenarios ────────────────────────────────────────────────────────────────

export const sweepScenarios: SweepScenario[] = [
  // 1. missing-page/filename-match
  {
    name: "missing-page/filename-match",
    description:
      "Review says the wiki is missing an 'attention' page. A page named " +
      "attention.md has since been added. Rule stage matches by filename.",
    initialWiki: {
      "purpose.md": SHARED_PURPOSE,
      "wiki/index.md": SHARED_INDEX,
      "wiki/attention.md": page(
        "Attention",
        "Attention assigns per-token weights within a sequence and lets " +
          "[[transformer]] models capture long-range dependencies.",
      ),
    },
    reviews: [
      {
        id: "r-missing-attention",
        type: "missing-page",
        title: "Missing page: attention",
        description:
          "Transformer page references attention but no dedicated page exists.",
        affectedPages: ["wiki/transformer.md"],
      },
    ],
    expected: {
      resolvedIds: ["r-missing-attention"],
      pendingIds: [],
      resolvedActions: { "r-missing-attention": "auto-resolved" },
    },
  },

  // 2. missing-page/title-match
  {
    name: "missing-page/title-match",
    description:
      "Review asks about 'Attention Mechanism'. The filename is 'attn.md' " +
      "but the frontmatter title matches — byTitle lookup should resolve it.",
    initialWiki: {
      "purpose.md": SHARED_PURPOSE,
      "wiki/index.md": SHARED_INDEX,
      "wiki/attn.md": page(
        "Attention Mechanism",
        "The attention mechanism computes a weighted sum of value vectors.",
      ),
    },
    reviews: [
      {
        id: "r-missing-attn-mech",
        type: "missing-page",
        title: "Missing page: Attention Mechanism",
        description: "No dedicated page for the attention mechanism concept.",
      },
    ],
    expected: {
      resolvedIds: ["r-missing-attn-mech"],
      pendingIds: [],
    },
  },

  // 3. missing-page/chinese-prefix-variant
  {
    name: "missing-page/chinese-prefix-variant",
    description:
      "Review title uses the Chinese '缺失页面：' prefix variant. The wiki " +
      "page is named in Chinese too. Prefix-normalization should make them " +
      "match the same dedupe/match key as an English 'Missing page:' variant.",
    initialWiki: {
      "purpose.md": SHARED_PURPOSE,
      "wiki/index.md": "# 索引\n\n- [[注意力机制]]\n",
      "wiki/注意力机制.md": page(
        "注意力机制",
        "注意力机制是 [[transformer]] 架构的核心组件之一，用于加权聚合序列信息。",
      ),
    },
    reviews: [
      {
        id: "r-missing-zh",
        type: "missing-page",
        title: "缺失页面: 注意力机制",
        description: "关于注意力机制的页面尚未建立。",
      },
    ],
    expected: {
      resolvedIds: ["r-missing-zh"],
      pendingIds: [],
    },
  },

  // 4. missing-page/not-resolved
  {
    name: "missing-page/not-resolved",
    description:
      "Review asks about a page that genuinely does not exist in the wiki " +
      "yet. With no LLM configured, the sweep must leave it pending.",
    initialWiki: {
      "purpose.md": SHARED_PURPOSE,
      "wiki/index.md": SHARED_INDEX,
      "wiki/attention.md": page("Attention", "..."),
    },
    reviews: [
      {
        id: "r-never-added",
        type: "missing-page",
        title: "Missing page: retrieval-augmented-generation",
        description: "No page exists yet for RAG.",
      },
    ],
    expected: {
      resolvedIds: [],
      pendingIds: ["r-never-added"],
    },
  },

  // 5. missing-page/case-insensitive
  {
    name: "missing-page/case-insensitive",
    description:
      "Review title uses ALL-CAPS. Filename is lowercase. Match must be " +
      "case-insensitive.",
    initialWiki: {
      "purpose.md": SHARED_PURPOSE,
      "wiki/attention.md": page("Attention", "..."),
    },
    reviews: [
      {
        id: "r-uppercase",
        type: "missing-page",
        title: "MISSING PAGE: ATTENTION",
      },
    ],
    expected: {
      resolvedIds: ["r-uppercase"],
      pendingIds: [],
    },
  },

  // 6. missing-page/kebab-vs-space
  {
    name: "missing-page/kebab-vs-space",
    description:
      "Review says 'Missing page: attention mechanism' (space). Wiki has " +
      "'attention-mechanism.md' (kebab-case). pageExists applies a " +
      "space→hyphen fallback so the match still works.",
    initialWiki: {
      "purpose.md": SHARED_PURPOSE,
      "wiki/attention-mechanism.md": page("Attention Mechanism", "..."),
    },
    reviews: [
      {
        id: "r-kebab",
        type: "missing-page",
        title: "Missing page: attention mechanism",
      },
    ],
    expected: {
      resolvedIds: ["r-kebab"],
      pendingIds: [],
    },
  },

  // 7. duplicate/one-page-deleted
  {
    name: "duplicate/one-page-deleted",
    description:
      "A duplicate review flagged that attention.md and attention-v2.md " +
      "covered the same topic. The user has since deleted attention-v2.md, " +
      "so the duplicate situation no longer exists — rule stage must resolve.",
    initialWiki: {
      "purpose.md": SHARED_PURPOSE,
      "wiki/attention.md": page("Attention", "..."),
      // attention-v2.md intentionally absent (user deleted it after the review)
    },
    reviews: [
      {
        id: "r-dup-resolved",
        type: "duplicate",
        title: "Duplicate page: Attention concept split across two files",
        description:
          "attention.md and attention-v2.md cover the same material and " +
          "should be merged or one deleted.",
        affectedPages: ["wiki/attention.md", "wiki/attention-v2.md"],
      },
    ],
    expected: {
      resolvedIds: ["r-dup-resolved"],
      pendingIds: [],
    },
  },

  // 8. duplicate/both-present
  {
    name: "duplicate/both-present",
    description:
      "Both duplicated pages still exist — user hasn't resolved it yet. " +
      "Rule stage must NOT auto-resolve; needs human judgment.",
    initialWiki: {
      "purpose.md": SHARED_PURPOSE,
      "wiki/attention.md": page("Attention", "..."),
      "wiki/attention-v2.md": page("Attention (v2)", "..."),
    },
    reviews: [
      {
        id: "r-dup-pending",
        type: "duplicate",
        title: "Duplicate page: Attention concept split",
        affectedPages: ["wiki/attention.md", "wiki/attention-v2.md"],
      },
    ],
    expected: {
      resolvedIds: [],
      pendingIds: ["r-dup-pending"],
    },
  },

  // 9. contradiction/never-auto-resolves
  {
    name: "contradiction/never-auto-resolves",
    description:
      "Contradiction items require human judgment and must NEVER be " +
      "auto-resolved by the rule stage, even if the pages they reference " +
      "still exist. Would only be resolved by a conservative-LLM scenario.",
    initialWiki: {
      "purpose.md": SHARED_PURPOSE,
      "wiki/attention.md": page("Attention", "Uses softmax over scores."),
      "wiki/transformer.md": page("Transformer", "Uses linear attention."),
    },
    reviews: [
      {
        id: "r-contra",
        type: "contradiction",
        title: "Contradiction: attention mechanism details",
        description:
          "attention.md says softmax, transformer.md says linear. One must " +
          "be wrong or underspecified.",
        affectedPages: ["wiki/attention.md", "wiki/transformer.md"],
      },
    ],
    expected: {
      resolvedIds: [],
      pendingIds: ["r-contra"],
    },
  },

  // 10. suggestion/stays-pending-by-default
  {
    name: "suggestion/stays-pending-by-default",
    description:
      "Suggestion items are conservative by design — the rule stage " +
      "doesn't touch them. Without LLM configured, they stay pending.",
    initialWiki: {
      "purpose.md": SHARED_PURPOSE,
      "wiki/attention.md": page("Attention", "..."),
    },
    reviews: [
      {
        id: "r-sugg",
        type: "suggestion",
        title: "Consider adding a 'Transformer variants' survey page",
        description: "There are now several pages that reference variants.",
      },
    ],
    expected: {
      resolvedIds: [],
      pendingIds: ["r-sugg"],
    },
  },

  // 11. llm-judged/semantic-match
  {
    name: "llm-judged/semantic-match",
    description:
      "Rule stage can't match 'Missing: Context Window' to any existing " +
      "page by filename or title. The LLM, given the wiki state, returns " +
      "the review ID as resolved (attention.md covers context windows). " +
      "Uses a fenced JSON response to exercise extractJsonObject.",
    initialWiki: {
      "purpose.md": SHARED_PURPOSE,
      "wiki/index.md": SHARED_INDEX,
      "wiki/attention.md": page(
        "Attention",
        "Attention defines an effective context window — the span of tokens " +
          "that can influence each output. Modern models extend this to " +
          "hundreds of thousands of tokens. This covers what users usually " +
          "mean by 'context window'.",
      ),
    },
    reviews: [
      {
        id: "r-context-window",
        type: "missing-page",
        title: "Missing page: Context Window",
        description: "Transformer page references context windows.",
      },
    ],
    llmResponse: '```json\n{"resolved": ["r-context-window"]}\n```',
    expected: {
      resolvedIds: ["r-context-window"],
      pendingIds: [],
      resolvedActions: { "r-context-window": "llm-judged" },
    },
  },

  // 12. mixed-batch/partial-resolution
  {
    name: "mixed-batch/partial-resolution",
    description:
      "A mix of reviews: one resolvable by rules (filename match), one " +
      "contradiction that must stay pending, one missing-page the LLM " +
      "confirms as resolved, one suggestion the LLM conservatively keeps.",
    initialWiki: {
      "purpose.md": SHARED_PURPOSE,
      "wiki/index.md": SHARED_INDEX,
      "wiki/attention.md": page(
        "Attention",
        "Attention mechanism details. Covers context windows too.",
      ),
      "wiki/transformer.md": page("Transformer", "..."),
    },
    reviews: [
      {
        id: "r-mix-rule",
        type: "missing-page",
        title: "Missing page: attention",
      },
      {
        id: "r-mix-contra",
        type: "contradiction",
        title: "Contradiction: attention details differ",
        affectedPages: ["wiki/attention.md", "wiki/transformer.md"],
      },
      {
        id: "r-mix-llm",
        type: "missing-page",
        title: "Missing page: Context Window",
      },
      {
        id: "r-mix-sugg",
        type: "suggestion",
        title: "Consider adding a glossary page",
      },
    ],
    llmResponse: '```json\n{"resolved": ["r-mix-llm"]}\n```',
    expected: {
      // r-mix-rule resolved by rules; r-mix-llm resolved by LLM; others stay.
      resolvedIds: ["r-mix-rule", "r-mix-llm"],
      pendingIds: ["r-mix-contra", "r-mix-sugg"],
      resolvedActions: {
        "r-mix-rule": "auto-resolved",
        "r-mix-llm": "llm-judged",
      },
    },
  },
]

import type { IngestScenario } from "./types"

/**
 * Ingest scenarios drive autoIngest end-to-end. Two LLM responses per
 * scenario (stage 1 analysis, stage 2 generation with FILE + REVIEW blocks).
 *
 * FILE block format (what stage 2 must emit to write a wiki file):
 *   ---FILE: wiki/path/to/page.md---
 *   (file content, usually with YAML frontmatter)
 *   ---END FILE---
 *
 * REVIEW block format (what stage 2 emits to inject a review item):
 *   ---REVIEW: missing-page | Short title---
 *   Description.
 *   OPTIONS: Approve | Skip
 *   PAGES: page1.md, page2.md
 *   ---END REVIEW---
 *
 * Stage 2 may emit arbitrary prose around blocks — the parser only
 * cares about the delimited blocks.
 */

const BASIC_PURPOSE = `# Purpose

This wiki tracks deep-learning research concepts.
`

const BASIC_INDEX = `# Index

## Concepts
- [[attention]]
`

const BASIC_SCHEMA = `# Schema

## wiki/sources/
Each ingested source has a summary page here.

## wiki/concepts/
Each concept gets its own page.
`

function conceptBlock(path: string, title: string, source: string, claim: string): string {
  return [
    `---FILE: ${path}---`,
    "---",
    "type: concept",
    `title: ${title}`,
    "created: 2026-05-09",
    "updated: 2026-05-09",
    "tags: [test]",
    "related: [attention]",
    `sources: [${source}]`,
    "confidence: medium",
    "last_reviewed: 2026-05-09",
    "quality: reviewed",
    "coverage: high",
    "needs_upgrade: false",
    "source_count: 1",
    "---",
    "",
    `# ${title}`,
    "",
    "## Definition",
    `${claim} This definition is long enough to prove the source was digested into a reusable wiki concept.`,
    "",
    "## Decision Criteria",
    "Keep this concept when it changes how an agent, model, or wiki operator should choose an implementation path.",
    "",
    "## Application Conditions",
    "Use this concept when the source claim is reusable across more than one query, note, or engineering decision.",
    "",
    "## Caveats",
    "Do not promote the concept as canonical if the source is weak, outdated, or only provides a passing mention.",
    "",
    "## Source Trace",
    `- Primary source: ${source}`,
    "---END FILE---",
  ].join("\n")
}

export const ingestScenarios: IngestScenario[] = [
  // 1. basic-new-source — new concept wiki page + source summary, no reviews
  {
    name: "basic-new-source",
    description:
      "Stage 2 emits a single concept page + a source summary page. No " +
      "REVIEW blocks. The runner must see both files on disk and zero " +
      "reviews in the store.",
    initialWiki: {
      "purpose.md": BASIC_PURPOSE,
      "schema.md": BASIC_SCHEMA,
      "wiki/index.md": BASIC_INDEX,
    },
    source: {
      path: "raw/sources/rope-paper.md",
      content: [
        "# Rotary Position Embedding",
        "",
        "Rotary Position Embedding (RoPE) encodes positional information by",
        "rotating pairs of dimensions in query and key vectors. It naturally",
        "supports variable-length contexts and is now standard in LLMs.",
      ].join("\n"),
    },
    analysisResponse: [
      "## Key Concepts",
      "- Rotary Position Embedding (RoPE): rotates pairs of dimensions",
      "",
      "## Main Arguments",
      "- RoPE naturally supports variable-length contexts",
      "",
      "## Recommendations",
      "- Create wiki/concepts/rope.md",
      "- Create wiki/sources/rope-paper.md",
    ].join("\n"),
    generationResponse: [
      "I'll create one concept page and the source summary.",
      "",
      conceptBlock(
        "wiki/concepts/rope.md",
        "Rotary Position Embedding",
        "rope-paper.md",
        "RoPE rotates pairs of dimensions in [[attention]] queries and keys to encode absolute position while preserving relative-position invariance.",
      ),
      "",
      "---FILE: wiki/sources/rope-paper.md---",
      "---",
      "title: \"Source: rope-paper.md\"",
      "sources: [rope-paper.md]",
      "---",
      "",
      "# Source: rope-paper.md",
      "",
      "Paper introducing [[Rotary Position Embedding]].",
      "---END FILE---",
    ].join("\n"),
    expected: {
      writtenPaths: [
        "wiki/concepts/Rotary Position Embedding.md",
        "wiki/sources/Rotary Position Embedding 소스 요약.md",
      ],
      fileContains: {
        "wiki/concepts/Rotary Position Embedding.md": [
          "title: Rotary Position Embedding",
          "attention",
        ],
        "wiki/sources/Rotary Position Embedding 소스 요약.md": ["rope-paper.md"],
      },
    },
  },

  // 2. generates-review-items — REVIEW blocks in generation become store items
  {
    name: "generates-review-items",
    description:
      "Stage 2 emits one FILE and two REVIEW blocks (missing-page + " +
      "suggestion). Both reviews must appear in the store after ingest.",
    initialWiki: {
      "purpose.md": BASIC_PURPOSE,
      "schema.md": BASIC_SCHEMA,
      "wiki/index.md": BASIC_INDEX,
    },
    source: {
      path: "raw/sources/flash-attention.md",
      content:
        "# FlashAttention\n\nFlashAttention is an IO-aware exact attention algorithm.\n",
    },
    analysisResponse: "## Key Concepts\n- FlashAttention\n",
    generationResponse: [
      "---FILE: wiki/sources/flash-attention.md---",
      "---",
      "title: \"Source: flash-attention.md\"",
      "sources: [flash-attention.md]",
      "---",
      "",
      "# Source: flash-attention.md",
      "",
      "FlashAttention is mentioned here.",
      "---END FILE---",
      "",
      "---REVIEW: missing-page | FlashAttention---",
      "The source introduces FlashAttention but no dedicated page exists.",
      "OPTIONS: Create page | Skip",
      "PAGES: wiki/sources/flash-attention.md",
      "---END REVIEW---",
      "",
      "---REVIEW: suggestion | Add IO-aware algorithms survey---",
      "Consider a survey page grouping IO-aware attention variants.",
      "---END REVIEW---",
    ].join("\n"),
    expected: {
      writtenPaths: ["wiki/sources/FlashAttention 소스 요약.md"],
      reviewsCreated: [
        { type: "missing-page", titleContains: "FlashAttention" },
        { type: "suggestion", titleContains: "IO-aware" },
      ],
    },
  },

  // 3. references-existing-wikilinks — generated pages link to existing pages
  {
    name: "references-existing-wikilinks",
    description:
      "The generated wiki page must include [[attention]] — linking back " +
      "to a page that already exists in the wiki. Runner asserts substring.",
    initialWiki: {
      "purpose.md": BASIC_PURPOSE,
      "schema.md": BASIC_SCHEMA,
      "wiki/index.md": BASIC_INDEX,
      "wiki/attention.md":
        "---\ntitle: Attention\n---\n\n# Attention\n\nThe attention mechanism.\n",
    },
    source: {
      path: "raw/sources/multi-head.md",
      content: "# Multi-Head Attention\n\nParallel attention heads.\n",
    },
    analysisResponse:
      "## Connections to Existing Wiki\n" +
      "- Multi-head attention is a variant of attention — existing [[attention]] page should be linked.\n",
    generationResponse: [
      conceptBlock(
        "wiki/concepts/multi-head-attention.md",
        "Multi-Head Attention",
        "multi-head.md",
        "Multi-head [[attention]] runs several attention layers in parallel so separate heads can capture different token relations.",
      ),
      "",
      "---FILE: wiki/sources/multi-head.md---",
      "---",
      "title: \"Source: multi-head.md\"",
      "---",
      "",
      "# Source: multi-head.md",
      "",
      "Source for multi-head [[attention]].",
      "---END FILE---",
    ].join("\n"),
    expected: {
      writtenPaths: [
        "wiki/concepts/Multi Head Attention.md",
        "wiki/sources/Multi Head Attention 소스 요약.md",
      ],
      fileContains: {
        "wiki/concepts/Multi Head Attention.md": ["[[attention]]"],
      },
    },
  },

  // 4. chinese-source — Chinese content flows through to Chinese wiki pages
  {
    name: "chinese-source",
    description:
      "Chinese-language source document; LLM responses in Chinese. " +
      "UTF-8 round-trip through file write must be clean.",
    initialWiki: {
      "purpose.md": "# 用途\n\n深度学习研究笔记。\n",
      "schema.md": BASIC_SCHEMA,
      "wiki/index.md": "# 索引\n\n- [[注意力机制]]\n",
    },
    source: {
      path: "raw/sources/transformer-survey.md",
      content: "# Transformer 综述\n\nTransformer 是一种基于注意力机制的神经网络架构。\n",
    },
    analysisResponse: "## 核心概念\n- Transformer：基于注意力机制的架构\n",
    generationResponse: [
      conceptBlock(
        "wiki/concepts/transformer.md",
        "Transformer",
        "transformer-survey.md",
        "Transformer 是一种基于 [[注意力机制]] 的神经网络架构，并且该测试页保留了足够的来源追踪和适用条件。",
      ),
      "",
      "---FILE: wiki/sources/transformer-survey.md---",
      "---",
      "title: \"Source: transformer-survey.md\"",
      "---",
      "",
      "# Source: transformer-survey.md",
      "",
      "关于 [[Transformer]] 的综述。",
      "---END FILE---",
    ].join("\n"),
    expected: {
      writtenPaths: [
        "wiki/concepts/Transformer.md",
        "wiki/sources/Transformer 综述 소스 요약.md",
      ],
      fileContains: {
        "wiki/concepts/Transformer.md": [
          "title: Transformer",
          "注意力机制",
        ],
      },
    },
  },
]

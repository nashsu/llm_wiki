import type { EnrichScenario } from "./types"

/**
 * v2: enrichWithWikilinks now asks the LLM to return a JSON list of
 * {term, target} substitutions instead of rewriting the whole page. Code
 * does the actual string replacement. See enrich-wikilinks.ts for the
 * design note.
 *
 * These mocked scenarios exercise the JSON→substitution path.
 */

const WIKI_INDEX_WITH_TRANSFORMER = `# Index

## Concepts
- [[attention]]
- [[transformer]]
- [[encoder]]
`

export const enrichScenarios: EnrichScenario[] = [
  // 1. adds-wikilinks — LLM returns a JSON list; code adds [[brackets]].
  {
    name: "adds-wikilinks",
    description:
      "LLM returns a JSON list identifying Transformer and Attention as " +
      "terms to link. Code applies [[brackets]] around the first literal " +
      "occurrence of each.",
    initialWiki: {
      "wiki/index.md": WIKI_INDEX_WITH_TRANSFORMER,
      "wiki/survey.md":
        "# Deep Learning Survey\n\n" +
        "Modern NLP relies on Transformer architectures for most tasks. " +
        "The Transformer was introduced in 2017 and has since dominated. " +
        "Attention is the key mechanism that makes it work.\n",
    },
    pageToEnrich: "wiki/survey.md",
    llmResponse: JSON.stringify({
      links: [
        { term: "Transformer", target: "transformer" },
        { term: "Attention", target: "attention" },
      ],
    }),
    expected: {
      writeCalled: true,
      // When term and target match case-insensitively, applyLinks emits
      // [[term]] (original casing preserved) rather than [[target|term]].
      expectedContent:
        "# Deep Learning Survey\n\n" +
        "Modern NLP relies on [[Transformer]] architectures for most tasks. " +
        "The Transformer was introduced in 2017 and has since dominated. " +
        "[[Attention]] is the key mechanism that makes it work.\n",
    },
  },

  // 2. preserves-frontmatter — YAML block is never touched by code
  {
    name: "preserves-frontmatter",
    description:
      "Frontmatter preservation is now a code-level guarantee: the " +
      "applier splits off the frontmatter and only operates on the body. " +
      "LLM just returns the term→target list.",
    initialWiki: {
      "wiki/index.md": WIKI_INDEX_WITH_TRANSFORMER,
      "wiki/attention.md":
        "---\n" +
        "title: Attention\n" +
        "tags: [deep-learning, transformer]\n" +
        "sources: [paper-2017.pdf]\n" +
        "---\n\n" +
        "# Attention\n\n" +
        "Attention scores are computed by the encoder. The encoder layer " +
        "uses these scores to weight values. Detailed derivation below.\n",
    },
    pageToEnrich: "wiki/attention.md",
    llmResponse: JSON.stringify({
      links: [{ term: "encoder", target: "encoder" }],
    }),
    expected: {
      writeCalled: true,
      expectedContent:
        "---\n" +
        "title: Attention\n" +
        "tags: [deep-learning, transformer]\n" +
        "sources: [paper-2017.pdf]\n" +
        "---\n\n" +
        "# Attention\n\n" +
        "Attention scores are computed by the [[encoder]]. The encoder layer " +
        "uses these scores to weight values. Detailed derivation below.\n",
    },
  },

  // 3. no-matches-no-write — LLM returns empty list; nothing written
  {
    name: "no-matches-no-write",
    description:
      "LLM returns {links:[]} — nothing to substitute. writeFile is not " +
      "called; the file stays unchanged.",
    initialWiki: {
      "wiki/index.md": WIKI_INDEX_WITH_TRANSFORMER,
      "wiki/unrelated.md":
        "# Unrelated Page\n\n" +
        "This page is about cats and dogs and has nothing to do with the " +
        "wiki's main topics. No terms should be linked here.\n",
    },
    pageToEnrich: "wiki/unrelated.md",
    llmResponse: JSON.stringify({ links: [] }),
    expected: {
      writeCalled: false,
    },
  },

  // 4. cjk-terms — Chinese substitutions
  {
    name: "cjk-terms",
    description:
      "Chinese content; LLM returns list with Chinese term / target. " +
      "Byte-accurate substitution through UTF-8.",
    initialWiki: {
      "wiki/index.md": "# 索引\n\n- [[注意力机制]]\n- [[transformer]]\n",
      "wiki/intro.md":
        "# 简介\n\n" +
        "注意力机制是 transformer 架构的核心组件之一。" +
        "注意力机制让模型能够关注序列中最相关的部分。\n",
    },
    pageToEnrich: "wiki/intro.md",
    llmResponse: JSON.stringify({
      links: [
        { term: "注意力机制", target: "注意力机制" },
        { term: "transformer", target: "transformer" },
      ],
    }),
    expected: {
      writeCalled: true,
      expectedContent:
        "# 简介\n\n" +
        "[[注意力机制]]是 [[transformer]] 架构的核心组件之一。" +
        "注意力机制让模型能够关注序列中最相关的部分。\n",
    },
  },
]

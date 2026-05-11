import type { SearchScenario } from "./types"

function page(title: string, body: string): string {
  return `---\ntitle: ${title}\n---\n\n# ${title}\n\n${body}\n`
}

function typedPage(frontmatter: string, title: string, body: string): string {
  return `---\n${frontmatter.trim()}\ntitle: ${title}\n---\n\n# ${title}\n\n${body}\n`
}

export const searchScenarios: SearchScenario[] = [
  // 1. title-exact-match — a page whose title exactly contains the query
  //    should rank first and have titleMatch=true.
  {
    name: "title-exact-match",
    description:
      "Query 'attention'. attention.md has 'attention' in its title and in " +
      "content. Should rank first with titleMatch=true.",
    initialWiki: {
      "wiki/attention.md": page("Attention", "The attention mechanism weights sequence tokens."),
      "wiki/other.md": page("Other Page", "Discusses something unrelated entirely."),
      "wiki/transformer.md": page("Transformer", "Uses attention across many heads."),
    },
    query: "attention",
    expected: {
      topResultPaths: ["wiki/attention.md"],
      titleMatchPaths: ["wiki/attention.md"],
      excludedPaths: ["wiki/other.md"],
    },
  },

  // 2. content-match — query not in title, still found via body text
  {
    name: "content-match",
    description:
      "Query 'rotary' appears only in the body of embeddings.md, not in " +
      "any title. Should still be returned, but with titleMatch=false.",
    initialWiki: {
      "wiki/embeddings.md": page(
        "Embeddings",
        "Rotary position embeddings inject positional information via rotation.",
      ),
      "wiki/other.md": page("Other", "Unrelated content here."),
    },
    query: "rotary",
    expected: {
      topResultPaths: ["wiki/embeddings.md"],
      excludedPaths: ["wiki/other.md"],
    },
  },

  // 3. cjk-bigram — Chinese query via bigram tokenization
  {
    name: "cjk-bigram",
    description:
      "Query '注意力机制' is tokenized into bigrams ('注意', '意力', '力机', '机制'). " +
      "The page whose content contains '注意力机制' should rank top.",
    initialWiki: {
      "wiki/attention-zh.md": page(
        "注意力机制",
        "注意力机制是 Transformer 架构的核心组件之一。",
      ),
      "wiki/unrelated-zh.md": page(
        "无关页面",
        "这个页面讨论别的话题，比如天气和足球。",
      ),
    },
    query: "注意力机制",
    expected: {
      topResultPaths: ["wiki/attention-zh.md"],
      excludedPaths: ["wiki/unrelated-zh.md"],
    },
  },

  // 4. multi-token-ranking — more matches ranks higher
  {
    name: "multi-token-ranking",
    description:
      "Query 'attention transformer'. The page mentioning BOTH terms " +
      "should outrank pages mentioning only one.",
    initialWiki: {
      "wiki/combined.md": page(
        "Attention and Transformer",
        "The transformer architecture is built around attention. " +
          "Attention weights tokens; transformer stacks attention layers.",
      ),
      "wiki/only-attn.md": page("Attention", "Attention is a weighting mechanism."),
      "wiki/only-trans.md": page("Transformer", "Stacks of layers form the transformer."),
    },
    query: "attention transformer",
    expected: {
      topResultPaths: ["wiki/combined.md"],
    },
  },

  // 5. stop-word-filtered — 'the' filtered, only meaningful tokens used
  {
    name: "stop-word-filtered",
    description:
      "Query 'the attention' should be tokenized to ['attention'] since " +
      "'the' is a stop-word. The page about attention should still match.",
    initialWiki: {
      "wiki/attention.md": page("Attention", "Attention over keys and values."),
      "wiki/other.md": page("Other", "This page uses the word 'the' often but " +
        "otherwise covers cats, dogs, weather, and the sky."),
    },
    query: "the attention",
    expected: {
      topResultPaths: ["wiki/attention.md"],
      // 'other' uses "the" a lot but should be filtered out and not rank top
    },
  },

  // 6. filename-exact-match-wins — the page whose filename stem EQUALS the
  //    query must rank #1 even when longer, denser pages also mention the
  //    word many times. Regression guard for the "精准匹配排到最后" bug.
  {
    name: "filename-exact-match-wins",
    description:
      "Query 'attention'. Many pages contain 'attention' in title AND body. " +
      "Only attention.md has the exact filename match — it must rank first.",
    initialWiki: {
      "wiki/attention.md": page("Attention", "Attention is a weighting mechanism."),
      "wiki/multi-head-attention.md": page(
        "Multi-Head Attention",
        "Multi-head attention extends attention across multiple heads. " +
          "Attention weights are computed per head and combined. " +
          "Each head attends to different patterns. Attention attention attention.",
      ),
      "wiki/self-attention-history.md": page(
        "Self-Attention: A History",
        "Self-attention appeared before multi-head attention. " +
          "Attention, attention, attention — the dominant mechanism in NLP.",
      ),
      "wiki/transformer-deep-dive.md": page(
        "Transformer Deep Dive",
        "The transformer uses attention everywhere. Attention in encoder, " +
          "attention in decoder, cross-attention between them. Attention rules.",
      ),
    },
    query: "attention",
    expected: {
      topResultPaths: ["wiki/attention.md"],
      titleMatchPaths: [
        "wiki/attention.md",
        "wiki/multi-head-attention.md",
        "wiki/self-attention-history.md",
      ],
    },
  },

  // 7. phrase-in-content-beats-scattered-tokens — a page that contains the
  //    raw query phrase should outrank a page with the same tokens scattered.
  {
    name: "phrase-in-content-beats-scattered-tokens",
    description:
      "Query 'self-attention'. tokens split to ['self','attention']. " +
      "The page containing the literal phrase 'self-attention' should " +
      "outrank the page where 'self' and 'attention' appear separately.",
    initialWiki: {
      "wiki/phrase-page.md": page(
        "Mechanisms",
        "This discusses self-attention, the key building block of transformers. " +
          "Self-attention is what makes transformers powerful.",
      ),
      "wiki/scattered-page.md": page(
        "Scattered",
        "Self-improvement is a goal. Attention to detail is important. " +
          "Self-help books discuss attention spans. " +
          "This page talks about self and about attention separately.",
      ),
    },
    query: "self-attention",
    expected: {
      topResultPaths: ["wiki/phrase-page.md"],
    },
  },

  // 8. trailing-punct-phrase-bonus — same query with a Chinese full stop
  //    appended must still apply the phrase-match bonus. Pre-fix,
  //    "总资产。" produced an exact-substring miss on titles / content
  //    (no trailing period there) and the phrase bonus silently went to
  //    zero, demoting the truly relevant page below tangentially-
  //    related ones in the chat-context priority order.
  {
    name: "trailing-punct-phrase-bonus",
    description:
      "Query '总资产。' (with trailing 。). Page with '总资产' in BOTH title " +
      "and content should still rank first and titleMatch=true, the same " +
      "as if the user had typed '总资产' without the period.",
    initialWiki: {
      "wiki/zong-zi-chan.md": page(
        "总资产分析",
        "公司 2023 年总资产合计 4.2 亿元；总资产同比增长 12%。",
      ),
      // Unrelated page must NOT contain "资" / "产" / "总" anywhere
      // — the CJK tokenizer breaks "总资产" into bigrams + single
      // chars, so a page mentioning even one of those characters
      // would match via the partial token route, which is correct
      // behavior we don't want to confuse this scenario with.
      "wiki/unrelated.md": page(
        "其他主题",
        "本页讨论天气、足球与厨艺，跟当前查询完全无关。",
      ),
    },
    query: "总资产。",
    expected: {
      topResultPaths: ["wiki/zong-zi-chan.md"],
      titleMatchPaths: ["wiki/zong-zi-chan.md"],
      excludedPaths: ["wiki/unrelated.md"],
    },
  },

  // 9. lifecycle-exclusions — archived and ephemeral query pages are not
  //    default search targets; reusable query records remain findable.
  {
    name: "lifecycle-exclusions",
    description:
      "Archived pages and ephemeral query records should not pollute default search, while reusable query records may still appear.",
    initialWiki: {
      "wiki/concepts/active.md": typedPage(
        "type: concept\nstate: active",
        "Active Agent Pattern",
        "The retrieval pattern should stay searchable.",
      ),
      "wiki/concepts/archived.md": typedPage(
        "type: concept\nstate: archived",
        "Archived Agent Pattern",
        "The retrieval pattern is retired.",
      ),
      "wiki/queries/temp.md": typedPage(
        "type: query\nretention: ephemeral",
        "Temporary Agent Pattern",
        "The retrieval pattern is only a scratch query.",
      ),
      "wiki/queries/reusable.md": typedPage(
        "type: query\nretention: reusable",
        "Reusable Agent Pattern",
        "The retrieval pattern can be reused.",
      ),
    },
    query: "retrieval pattern",
    expected: {
      topResultPaths: ["wiki/concepts/active.md"],
      excludedPaths: ["wiki/concepts/archived.md", "wiki/queries/temp.md"],
    },
  },
]

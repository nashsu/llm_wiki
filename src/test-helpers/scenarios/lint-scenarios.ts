import type { LintScenario } from "./types"

// NOTE: Structural lint only counts inbound wikilinks from OTHER content
// pages (index.md and log.md are excluded from the slug map). So to avoid
// an "orphan" finding on a page, at least one non-index content page must
// [[link]] to it. Scenario wikis here are built with that in mind.

function page(title: string, body: string): string {
  return `---\ntitle: ${title}\n---\n\n# ${title}\n\n${body}\n`
}

export const lintScenarios: LintScenario[] = [
  // 1. clean-wiki — fully interlinked, no findings
  {
    name: "structural/clean-wiki",
    description:
      "Two content pages cross-link each other. No orphans, no broken " +
      "links, no no-outlinks. Structural lint returns an empty result.",
    initialWiki: {
      "wiki/index.md": "# Index\n\n- [[attention]]\n- [[transformer]]\n",
      "wiki/attention.md": page(
        "Attention",
        "See the [[transformer]] architecture for how this is applied.",
      ),
      "wiki/transformer.md": page(
        "Transformer",
        "Transformers are built on the [[attention]] mechanism.",
      ),
    },
    expected: {
      structural: [],
    },
  },

  // 2. orphan-page — no inbound wikilinks
  {
    name: "structural/orphan-page",
    description:
      "orphan.md links out to attention.md but no content page links BACK " +
      "to orphan.md. Structural lint should flag it as orphan, nothing else.",
    initialWiki: {
      "wiki/index.md": "# Index\n\n- [[attention]]\n- [[transformer]]\n",
      "wiki/attention.md": page("Attention", "Related: [[transformer]]."),
      "wiki/transformer.md": page("Transformer", "Built on [[attention]]."),
      "wiki/orphan.md": page(
        "Orphan",
        "This page links to [[attention]] but nobody links back here.",
      ),
    },
    expected: {
      structural: [{ type: "orphan", page: "orphan.md" }],
    },
  },

  // 3. broken-link — wikilink to a page that doesn't exist
  {
    name: "structural/broken-link",
    description:
      "attention.md contains a wikilink to [[nonexistent-page]] which has " +
      "no corresponding file. Structural lint must flag the broken link " +
      "and name it in the detail.",
    initialWiki: {
      "wiki/index.md": "# Index\n\n- [[attention]]\n- [[transformer]]\n",
      "wiki/attention.md": page(
        "Attention",
        "Related to [[transformer]] and also to [[nonexistent-page]].",
      ),
      "wiki/transformer.md": page("Transformer", "Built on [[attention]]."),
    },
    expected: {
      structural: [
        {
          type: "broken-link",
          page: "attention.md",
          linkName: "nonexistent-page",
        },
      ],
    },
  },

  // 4. no-outlinks — a page has zero [[wikilinks]]
  {
    name: "structural/no-outlinks",
    description:
      "leaf.md is linked-to by transformer.md but has no outgoing links " +
      "of its own. Lint should flag 'no-outlinks' on leaf.md.",
    initialWiki: {
      "wiki/index.md": "# Index\n\n- [[attention]]\n- [[transformer]]\n- [[leaf]]\n",
      "wiki/attention.md": page("Attention", "Related: [[transformer]]."),
      "wiki/transformer.md": page(
        "Transformer",
        "Uses [[attention]] and references [[leaf]] as a concept.",
      ),
      "wiki/leaf.md": page(
        "Leaf",
        "This page describes a leaf concept and makes no external references.",
      ),
    },
    expected: {
      // Only the no-outlinks finding — transformer still outlinks, attention
      // still outlinks, leaf has inbound from transformer.
      structural: [{ type: "no-outlinks", page: "leaf.md" }],
    },
  },

  // 5. semantic-contradiction (LLM-backed)
  {
    name: "semantic/contradiction-found",
    description:
      "Two cross-linked pages make conflicting claims. Structural lint " +
      "sees no issues, but the mocked semantic LLM response emits a LINT " +
      "block that the parser extracts into a contradiction finding.",
    initialWiki: {
      "wiki/index.md": "# Index\n\n- [[attention]]\n- [[transformer]]\n",
      "wiki/attention.md": page(
        "Attention",
        "Attention ALWAYS uses the softmax function. See [[transformer]].",
      ),
      "wiki/transformer.md": page(
        "Transformer",
        "The transformer's [[attention]] layer uses a linear kernel, not softmax.",
      ),
    },
    llmResponse: [
      "Reviewing the pages I found one contradiction:",
      "",
      "---LINT: contradiction | warning | Attention function differs between pages---",
      "attention.md claims softmax is always used, but transformer.md describes a",
      "linear attention kernel. One page needs correction.",
      "PAGES: attention.md, transformer.md",
      "---END LINT---",
    ].join("\n"),
    expected: {
      structural: [],
      semantic: [
        {
          // Parser collapses all semantic findings to type="semantic";
          // the original LLM-declared type ("contradiction") lives in detail.
          type: "semantic",
          severity: "warning",
          titleContains: "Attention function differs",
        },
      ],
    },
  },
]

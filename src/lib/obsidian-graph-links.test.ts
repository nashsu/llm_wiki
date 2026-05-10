import { describe, expect, it } from "vitest"
import { buildObsidianGraphLinkUpdates } from "./obsidian-graph-links"

const wikiRoot = "/tmp/llm-wiki/wiki"

function page(relativePath: string, frontmatter: string, body = "") {
  return {
    relativePath,
    content: ["---", frontmatter.trim(), "---", "", body].join("\n"),
  }
}

describe("buildObsidianGraphLinkUpdates", () => {
  it("mirrors resolved related and source references into graph_links", () => {
    const updates = buildObsidianGraphLinkUpdates([
      page(
        "concepts/agent-ops.md",
        `
type: concept
title: Agent Ops
tags: []
related: [openclaw, hermes]
sources: ["OpenClaw vs Hermes.md"]
confidence: high
        `,
        "# Agent Ops\n",
      ),
      page("entities/openclaw.md", "type: entity\ntitle: OpenClaw\nrelated: []\nsources: []"),
      page("entities/hermes.md", "type: entity\ntitle: Hermes\nrelated: []\nsources: []"),
      page("sources/OpenClaw vs Hermes.md", "type: source\ntitle: OpenClaw vs Hermes\nrelated: []\nsources: []"),
    ], wikiRoot)

    const update = updates.find((item) => item.relativePath === "concepts/agent-ops.md")
    expect(update?.links).toEqual(["hermes", "openclaw", "OpenClaw vs Hermes"])
    expect(update?.content).toContain('  - "[[OpenClaw vs Hermes]]"')
    expect(update?.content).toContain('  - "[[hermes]]"')
    expect(update?.content).toContain('  - "[[openclaw]]"')
  })

  it("drops missing references and replaces stale graph_links", () => {
    const updates = buildObsidianGraphLinkUpdates([
      page(
        "concepts/agent-ops.md",
        `
type: concept
title: Agent Ops
tags: []
related: [openclaw, ghost-page]
sources: []
graph_links:
  - "[[stale-page]]"
confidence: high
        `,
      ),
      page("entities/openclaw.md", "type: entity\ntitle: OpenClaw\nrelated: []\nsources: []"),
    ], wikiRoot)

    const update = updates.find((item) => item.relativePath === "concepts/agent-ops.md")
    expect(update?.links).toEqual(["openclaw"])
    expect(update?.content).toContain('  - "[[openclaw]]"')
    expect(update?.content).not.toContain('  - "[[ghost-page]]"')
    expect(update?.content).not.toContain("stale-page")
  })

  it("removes graph_links from structural pages", () => {
    const updates = buildObsidianGraphLinkUpdates([
      page(
        "overview.md",
        `
type: overview
title: Overview
related: []
sources: ["source-a.md"]
graph_links:
  - "[[source-a]]"
        `,
      ),
      page("sources/source-a.md", "type: source\ntitle: Source A\nrelated: []\nsources: []"),
    ], wikiRoot)

    const update = updates.find((item) => item.relativePath === "overview.md")
    expect(update?.links).toEqual([])
    expect(update?.content).not.toContain("graph_links:")
    expect(update?.content).not.toContain("[[source-a]]")
  })

  it("can scope graph_links updates to files written by the current ingest", () => {
    const updates = buildObsidianGraphLinkUpdates([
      page(
        "concepts/current.md",
        `
type: concept
title: Current
related: [openclaw]
sources: []
        `,
      ),
      page(
        "concepts/old.md",
        `
type: concept
title: Old
related: [openclaw]
sources: []
        `,
      ),
      page("entities/openclaw.md", "type: entity\ntitle: OpenClaw\nrelated: []\nsources: []"),
    ], wikiRoot, ["wiki/concepts/current.md"])

    expect(updates.map((u) => u.relativePath)).toEqual(["concepts/current.md"])
  })
})

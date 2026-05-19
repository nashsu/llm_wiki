import { describe, expect, it } from "vitest"

// buildWikiGraph hits fs — test link extraction via the same helpers the graph uses.
// We import indirectly by duplicating the private helpers' contract through a
// minimal inline check on the exported graph builder's inputs.

import { parseFrontmatterArray } from "@/lib/sources-merge"
import { unwrapWikilink } from "@/lib/wiki-page-resolver"

function extractRelatedTargets(content: string): string[] {
  return parseFrontmatterArray(content, "related").map((raw) => unwrapWikilink(raw).slug)
}

const WIKILINK_REGEX = /\[\[([^\]|]+?)(?:\|[^\]]+?)?\]\]/g

function extractWikilinks(content: string): string[] {
  const links: string[] = []
  const regex = new RegExp(WIKILINK_REGEX.source, "g")
  let match: RegExpExecArray | null
  while ((match = regex.exec(content)) !== null) {
    links.push(match[1].trim())
  }
  return links
}

describe("wiki graph link targets", () => {
  it("includes frontmatter related slugs alongside body wikilinks", () => {
    const content = [
      "---",
      'type: entity',
      'title: "Hadoop"',
      'related: [hdfs, spark]',
      "---",
      "",
      "See also [[apache-spark]].",
    ].join("\n")

    const targets = [...extractWikilinks(content), ...extractRelatedTargets(content)]
    expect(targets).toContain("apache-spark")
    expect(targets).toContain("hdfs")
    expect(targets).toContain("spark")
  })
})

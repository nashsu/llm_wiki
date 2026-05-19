import { describe, expect, it } from "vitest"
import { parseFrontmatterArray } from "@/lib/sources-merge"
import { resolveWikiSlugId, unwrapWikilink } from "@/lib/wiki-page-resolver"

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

function extractRelatedTargets(content: string): string[] {
  return parseFrontmatterArray(content, "related").map((raw) => unwrapWikilink(raw).slug)
}

describe("wiki graph link targets", () => {
  it("reads related and body wikilinks as written on disk", () => {
    const content = [
      "---",
      'type: entity',
      'title: "Hadoop"',
      'related: [hdfs, apache-spark]',
      "---",
      "",
      "See also [[apache-spark]].",
    ].join("\n")

    const targets = [...extractWikilinks(content), ...extractRelatedTargets(content)]
    expect(targets).toEqual(["apache-spark", "hdfs", "apache-spark"])
  })

  it("resolves shorthand targets when building edges", () => {
    expect(resolveWikiSlugId("spark", ["apache-spark", "hdfs"])).toBe("apache-spark")
  })
})

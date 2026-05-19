import { describe, it, expect } from "vitest"
import { parseFrontmatter } from "./frontmatter"
import { sanitizeIngestedFileContent } from "./ingest-sanitize"

describe("sanitizeIngestedFileContent", () => {
  it("returns clean content unchanged", () => {
    const input = `---\ntype: entity\ntitle: Foo\n---\n\n# Foo\n\nbody`
    expect(sanitizeIngestedFileContent(input)).toBe(input)
  })

  it("strips a ```yaml-wrapped document and leaves the frontmatter block standard", () => {
    const input =
      "```yaml\n---\ntype: entity\ntitle: Accumulibacter\n---\n\n# Body\n```"
    const out = sanitizeIngestedFileContent(input)
    expect(out).toBe("---\ntype: entity\ntitle: Accumulibacter\n---\n\n# Body")
  })

  it("strips a ```md-wrapped document", () => {
    const input = "```md\n---\ntype: x\n---\nbody\n```"
    const out = sanitizeIngestedFileContent(input)
    expect(out).toBe("---\ntype: x\n---\nbody")
  })

  it("strips a ```markdown-wrapped document", () => {
    const input = "```markdown\n---\ntype: x\n---\nbody\n```"
    expect(sanitizeIngestedFileContent(input)).toBe("---\ntype: x\n---\nbody")
  })

  it("strips a bare ```-wrapped document (no lang)", () => {
    const input = "```\n---\ntype: x\n---\nbody\n```"
    expect(sanitizeIngestedFileContent(input)).toBe("---\ntype: x\n---\nbody")
  })

  it("does NOT strip a non-fence-wrapped document containing a fenced code block in the body", () => {
    const input =
      "---\ntype: x\n---\n\n# Heading\n\n```js\nconsole.log('hi')\n```\n\nmore body"
    // The leading line is `---`, not a fence opener, so stripping
    // doesn't fire. Body fences are preserved verbatim.
    expect(sanitizeIngestedFileContent(input)).toBe(input)
  })

  it("does NOT strip a partially-fenced document (open fence but no matching close)", () => {
    const input = "```yaml\n---\ntype: x\n---\nbody"
    expect(sanitizeIngestedFileContent(input)).toBe(input)
  })

  it("strips a leading `frontmatter:` key prefix when followed by a real --- block", () => {
    const input =
      "frontmatter:\n---\ntype: entity\ntitle: LSTM\n---\n\n# Body"
    expect(sanitizeIngestedFileContent(input)).toBe(
      "---\ntype: entity\ntitle: LSTM\n---\n\n# Body",
    )
  })

  it("does NOT strip the word `frontmatter:` when it appears mid-document (in prose)", () => {
    const input = "---\ntype: x\n---\n\nThe frontmatter: of this doc is above."
    expect(sanitizeIngestedFileContent(input)).toBe(input)
  })

  it("repairs an invalid `key: [[a]], [[b]]` wikilink list inside frontmatter", () => {
    const input =
      "---\ntype: entity\nrelated: [[a]], [[b]], [[c]]\n---\n\nbody"
    expect(sanitizeIngestedFileContent(input)).toBe(
      `---\ntype: entity\nrelated: ["[[a]]", "[[b]]", "[[c]]"]\n---\n\nbody`,
    )
  })

  it("doesn't touch a single `key: [[a]]` (not a list — leave the user's intent alone)", () => {
    const input = `---\nrelated: [[a]]\n---\nbody`
    // Single-element nested-array form is rare but legal YAML;
    // we only repair the multi-comma form which is unambiguously
    // an LLM mistake.
    expect(sanitizeIngestedFileContent(input)).toBe(input)
  })

  it("doesn't touch wikilink-style text that appears in the body", () => {
    const input = "---\ntype: x\n---\n\nrelated: [[a]], [[b]] in body prose"
    // Repair only fires inside the frontmatter block; body
    // content is verbatim.
    expect(sanitizeIngestedFileContent(input)).toBe(input)
  })

  it("splits fenceless single-line frontmatter into a --- block", () => {
    const input = [
      "type: entity title: NYU 深度学习自然语言处理讲义笔记 tags: [lecture-notes, nyu, center-for-data-science] related: [arxiv, new-york-university, center-for-data-science, yoav-goldberg] created: 2026-05-19 updated: 2026-05-19 sources: [\"1511.07916v1.pdf\"]",
      "",
      "# NYU 深度学习",
      "",
      "Body paragraph.",
    ].join("\n")

    const out = sanitizeIngestedFileContent(input)
    expect(out).toMatch(/^---\n/)
    expect(out).toContain("type: entity\n")
    expect(out).toContain('title: NYU 深度学习自然语言处理讲义笔记\n')
    expect(out).toContain("tags: [lecture-notes, nyu, center-for-data-science]\n")
    expect(out).toContain("\n---\n\n# NYU 深度学习")

    const parsed = parseFrontmatter(out)
    expect(parsed.frontmatter?.type).toBe("entity")
    expect(parsed.frontmatter?.title).toBe("NYU 深度学习自然语言处理讲义笔记")
    expect(parsed.frontmatter?.related).toEqual([
      "arxiv",
      "new-york-university",
      "center-for-data-science",
      "yoav-goldberg",
    ])
    expect(parsed.body).toContain("# NYU 深度学习")
  })

  it("does not rewrite a normal prose line that happens to mention type:", () => {
    const input = "The type: of error was unclear.\n\nMore text."
    expect(sanitizeIngestedFileContent(input)).toBe(input)
  })

  it("composes fence, frontmatter-key, wikilink-list, and inline repairs", () => {
    const input =
      "```yaml\nfrontmatter:\n---\ntype: entity\nrelated: [[a]], [[b]]\n---\n\n# Body\n```"
    const out = sanitizeIngestedFileContent(input)
    expect(out).toBe(
      `---\ntype: entity\nrelated: ["[[a]]", "[[b]]"]\n---\n\n# Body`,
    )
  })
})

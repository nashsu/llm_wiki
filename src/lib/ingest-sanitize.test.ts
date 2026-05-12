import { describe, it, expect } from "vitest"
import { sanitizeGeneratedIndexContent, sanitizeIngestedFileContent } from "./ingest-sanitize"

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

  it("adds a missing opening frontmatter fence when the model starts at `type:`", () => {
    const input =
      "type: source\ntitle: LLM Wiki\nsources: [llm-wiki.md]\n---\n# Body"
    expect(sanitizeIngestedFileContent(input)).toBe(
      "---\ntype: source\ntitle: LLM Wiki\nsources: [llm-wiki.md]\n---\n# Body",
    )
  })

  it("does NOT add a frontmatter fence to ordinary body prose", () => {
    const input = "title: this appears in body prose\n\nNo YAML fence follows."
    expect(sanitizeIngestedFileContent(input)).toBe(input)
  })

  it("composes the common repairs on a real-corpus-shaped input", () => {
    const input =
      "```yaml\nfrontmatter:\n---\ntype: entity\nrelated: [[a]], [[b]]\n---\n\n# Body\n```"
    const out = sanitizeIngestedFileContent(input)
    expect(out).toBe(
      `---\ntype: entity\nrelated: ["[[a]]", "[[b]]"]\n---\n\n# Body`,
    )
  })
})


describe("sanitizeGeneratedIndexContent", () => {
  it("removes archived/deprecated/ephemeral index listing rows", () => {
    const input = [
      "---",
      "type: index",
      "title: Index",
      "---",
      "# Index",
      "",
      "## Concepts",
      "- [[wiki/concepts/current.md|현재 개념]] — active",
      "- [[wiki/concepts/old.md|오래된 개념]] — state: archived",
      "- [[wiki/concepts/temp.md|임시 개념]] — retention: ephemeral",
      "| page | status |",
      "| --- | --- |",
      "| [[wiki/concepts/deprecated.md]] | deprecated |",
      "",
    ].join("\n")

    expect(sanitizeGeneratedIndexContent(input)).toBe([
      "---",
      "type: index",
      "title: Index",
      "---",
      "# Index",
      "",
      "## Concepts",
      "- [[wiki/concepts/current.md|현재 개념]] — active",
      "| page | status |",
      "| --- | --- |",
      "",
    ].join("\n"))
  })

  it("leaves policy prose mentioning archive outside listing rows", () => {
    const input = "# Index\n\nArchive policy prose can mention archived pages.\n\n- [[wiki/concepts/current.md]]"
    expect(sanitizeGeneratedIndexContent(input)).toBe(input)
  })
})

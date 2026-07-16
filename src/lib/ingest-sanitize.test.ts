import { describe, it, expect } from "vitest"
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

  it("strips a ```yaml fence wrapping only the frontmatter", () => {
    const input = "```yaml\n---\ntype: x\n---\n```\n\n# Body"
    expect(sanitizeIngestedFileContent(input)).toBe("---\ntype: x\n---\n\n# Body")
  })

  it("strips a frontmatter fence after leading blank lines with a case-insensitive label", () => {
    const input = "\n  \n```YAML\n---\ntype: x\n---\n```\n# Body"
    expect(sanitizeIngestedFileContent(input)).toBe("---\ntype: x\n---\n# Body")
  })

  it("strips a CRLF fence around empty frontmatter", () => {
    const input = "```yaml\r\n---\r\n---\r\n```\r\n\r\n# Body"
    expect(sanitizeIngestedFileContent(input)).toBe("---\r\n---\r\n\r\n# Body")
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

  it("repairs a missing opening frontmatter fence when the closing fence is present", () => {
    const input =
      "\n\ntype: entity\ntitle: \"Foo: Bar\"\nsources: [foo.pdf]\n---\n\n# Foo\n\nBody"
    expect(sanitizeIngestedFileContent(input)).toBe(
      "---\ntype: entity\ntitle: \"Foo: Bar\"\nsources: [foo.pdf]\n---\n\n# Foo\n\nBody",
    )
  })

  it("does NOT invent frontmatter when a body line only looks like metadata", () => {
    const input = "title: A research question\n\n# Notes\n\nBody"
    expect(sanitizeIngestedFileContent(input)).toBe(input)
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

  it("repairs a wikilink list without corrupting CRLF frontmatter", () => {
    const input = "---\r\ntype: entity\r\nrelated: [[a]], [[b]]\r\n---\r\n# Body\r\n"
    expect(sanitizeIngestedFileContent(input)).toBe(
      "---\r\ntype: entity\r\nrelated: [\"[[a]]\", \"[[b]]\"]\r\n---\r\n# Body\r\n",
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

  it("composes all three repairs on a real-corpus-shaped input", () => {
    const input =
      "```yaml\nfrontmatter:\n---\ntype: entity\nrelated: [[a]], [[b]]\n---\n\n# Body\n```"
    const out = sanitizeIngestedFileContent(input)
    expect(out).toBe(
      `---\ntype: entity\nrelated: ["[[a]]", "[[b]]"]\n---\n\n# Body`,
    )
  })
})

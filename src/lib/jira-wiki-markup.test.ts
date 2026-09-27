import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { jiraWikiToMarkdown, markdownLinkDestination } from "./jira-wiki-markup"

const ATTACHMENTS = new Map<string, string>([
  ["shot.png", "./AERDM-1234.attachments/shot.png"],
  ["my report.pdf", "./AERDM-1234.attachments/my report.pdf"],
])
const BASE = "https://jira.example.com"

describe("headings and blocks", () => {
  it.each([
    ["h1. 标题", "# 标题"],
    ["h2. Sub", "## Sub"],
    ["h3. Deep", "### Deep"],
    ["h6. Deepest", "###### Deepest"],
  ])("converts %s", (input, expected) => {
    expect(jiraWikiToMarkdown(input)).toBe(expected)
  })

  it("does not treat a line that merely starts with h as a heading", () => {
    expect(jiraWikiToMarkdown("h1 not a heading")).toBe("h1 not a heading")
    expect(jiraWikiToMarkdown("h7. nope")).toBe("h7. nope")
  })

  it("converts a block quote line", () => {
    expect(jiraWikiToMarkdown("bq. quoted text")).toBe("> quoted text")
  })

  it("converts a horizontal rule", () => {
    expect(jiraWikiToMarkdown("----")).toBe("---")
    expect(jiraWikiToMarkdown("---")).toBe("---")
  })

  it("turns a {quote} block into a markdown quote", () => {
    expect(jiraWikiToMarkdown("{quote}\nfirst\nsecond\n{quote}")).toBe("> first\n> second")
  })

  it("converts a {panel} block the same way", () => {
    expect(jiraWikiToMarkdown("{panel}\ninside\n{panel}")).toBe("> inside")
  })

  it("normalises CRLF input", () => {
    expect(jiraWikiToMarkdown("a\r\nb")).toBe("a\nb")
  })
})

describe("emphasis", () => {
  it("converts bold", () => {
    expect(jiraWikiToMarkdown("a *bold* word")).toBe("a **bold** word")
  })

  it("converts italic", () => {
    expect(jiraWikiToMarkdown("an _italic_ word")).toBe("an *italic* word")
  })

  it("leaves a snake_case identifier alone", () => {
    expect(jiraWikiToMarkdown("DAB_box 收音")).toBe("DAB_box 收音")
    expect(jiraWikiToMarkdown("call some_function_name() here")).toBe(
      "call some_function_name() here",
    )
  })

  it("leaves an issue key alone", () => {
    expect(jiraWikiToMarkdown("AERDM-1234 in a sentence")).toBe("AERDM-1234 in a sentence")
  })

  it("converts monospace", () => {
    expect(jiraWikiToMarkdown("run {{npm ci}} now")).toBe("run `npm ci` now")
  })

  it("does not re-process a URL inside an emphasis shield", () => {
    expect(jiraWikiToMarkdown("[doc|https://example.com/a_b_c]")).toBe(
      "[doc](https://example.com/a_b_c)",
    )
  })
})

describe("code blocks", () => {
  it("fences a {code} block and keeps its language", () => {
    expect(jiraWikiToMarkdown("{code:java}\nint x = 1;\n{code}")).toBe("```java\nint x = 1;\n```")
  })

  it("fences a language-less {code} block", () => {
    expect(jiraWikiToMarkdown("{code}\nplain\n{code}")).toBe("```\nplain\n```")
  })

  it("ignores a title parameter and keeps the language", () => {
    expect(jiraWikiToMarkdown("{code:bash|title=run}\necho hi\n{code}")).toBe(
      "```bash\necho hi\n```",
    )
  })

  it("does not convert anything inside the fence", () => {
    const output = jiraWikiToMarkdown("{code}\n*bold* _italic_ [KEY] {{mono}}\n{code}")
    expect(output).toBe("```\n*bold* _italic_ [KEY] {{mono}}\n```")
  })

  it("fences {noformat} without a language", () => {
    expect(jiraWikiToMarkdown("{noformat}\nraw text\n{noformat}")).toBe("```\nraw text\n```")
  })

  it("starts the fence on its own line when the macro follows text", () => {
    expect(jiraWikiToMarkdown("see below {code}\nx\n{code}")).toBe("see below \n```\nx\n```")
  })

  it("leaves an unclosed {code} from swallowing the rest of the document", () => {
    const output = jiraWikiToMarkdown("{code}\nstill here")
    expect(output).toContain("still here")
  })

  it("handles two blocks in one description", () => {
    expect(jiraWikiToMarkdown("{code}\na\n{code}\ntext\n{code}\nb\n{code}")).toBe(
      "```\na\n```\ntext\n```\nb\n```",
    )
  })
})

describe("lists", () => {
  it("converts an unordered list", () => {
    expect(jiraWikiToMarkdown("* one\n* two")).toBe("- one\n- two")
  })

  it("converts an ordered list", () => {
    expect(jiraWikiToMarkdown("# one\n# two")).toBe("1. one\n1. two")
  })

  it("nests by repeating the marker", () => {
    expect(jiraWikiToMarkdown("* one\n** nested")).toBe("- one\n  - nested")
  })

  it("supports a mixed nested list", () => {
    expect(jiraWikiToMarkdown("* one\n*# nested ordered")).toBe("- one\n  1. nested ordered")
  })
})

describe("tables", () => {
  it("converts a header row plus body rows to a GFM table", () => {
    expect(jiraWikiToMarkdown("||A||B||\n|c|d|")).toBe("| A | B |\n| --- | --- |\n| c | d |")
  })

  it("treats the first row as the header when none is marked", () => {
    expect(jiraWikiToMarkdown("|a|b|\n|c|d|")).toBe("| a | b |\n| --- | --- |\n| c | d |")
  })

  it("pads a short row so the table stays rectangular", () => {
    expect(jiraWikiToMarkdown("||A||B||\n|c|")).toBe("| A | B |\n| --- | --- |\n| c |  |")
  })

  it("converts markup inside a cell and escapes a pipe", () => {
    expect(jiraWikiToMarkdown("||*h*||\n|a|b|")).toBe("| **h** |  |\n| --- | --- |\n| a | b |")
  })

  it("ends the table at the first non-table line", () => {
    expect(jiraWikiToMarkdown("||A||\n|1|\nafter")).toBe("| A |\n| --- |\n| 1 |\nafter")
  })
})

describe("links", () => {
  it("converts a labelled link", () => {
    expect(jiraWikiToMarkdown("[需求文档|https://example.com/spec]")).toBe(
      "[需求文档](https://example.com/spec)",
    )
  })

  it("uses the target as the label when the label is empty", () => {
    expect(jiraWikiToMarkdown("[|https://example.com]")).toBe("[https://example.com](https://example.com)")
  })

  it("links a bare issue key against the instance", () => {
    expect(jiraWikiToMarkdown("[AERDM-2000]", { baseUrl: BASE })).toBe(
      "[AERDM-2000](https://jira.example.com/browse/AERDM-2000)",
    )
  })

  it("leaves a bare issue key as text when there is no instance configured", () => {
    expect(jiraWikiToMarkdown("[AERDM-2000]")).toBe("AERDM-2000")
  })

  it("turns a bare URL into an autolink", () => {
    expect(jiraWikiToMarkdown("[https://example.com/x]")).toBe("<https://example.com/x>")
  })

  it("links an attachment named in brackets", () => {
    expect(
      jiraWikiToMarkdown("[spec.pdf]", {
        attachmentLinks: new Map([["spec.pdf", "./AERDM-1.attachments/spec.pdf"]]),
      }),
    ).toBe("[spec.pdf](./AERDM-1.attachments/spec.pdf)")
  })

  it("leaves unrecognised bracket content exactly as typed", () => {
    expect(jiraWikiToMarkdown("[see the appendix]")).toBe("[see the appendix]")
  })
})

describe("attachments", () => {
  it("links a downloaded attachment", () => {
    expect(jiraWikiToMarkdown("!shot.png!", { attachmentLinks: ATTACHMENTS })).toBe(
      "[shot.png](./AERDM-1234.attachments/shot.png)",
    )
  })

  it("angle-wraps a destination containing a space so the link still parses", () => {
    expect(jiraWikiToMarkdown("!my report.pdf!", { attachmentLinks: ATTACHMENTS })).toBe(
      "[my report.pdf](<./AERDM-1234.attachments/my report.pdf>)",
    )
  })

  it("degrades to plain text when the attachment was not downloaded", () => {
    expect(jiraWikiToMarkdown("!missing.png!")).toBe("missing.png")
    expect(jiraWikiToMarkdown("!missing.png!", { attachmentLinks: ATTACHMENTS })).toBe(
      "missing.png",
    )
  })

  it("ignores the size parameter Jira puts after the pipe", () => {
    expect(jiraWikiToMarkdown("!shot.png|width=200!", { attachmentLinks: ATTACHMENTS })).toBe(
      "[shot.png](./AERDM-1234.attachments/shot.png)",
    )
  })
})

describe("unknown macros", () => {
  it("removes the macro but keeps the text around it", () => {
    expect(jiraWikiToMarkdown("{color:red}warning{color}")).toBe("warning")
  })

  it("removes an inline macro in the middle of a sentence", () => {
    expect(jiraWikiToMarkdown("see {anchor:top} above")).toBe("see  above")
  })
})

describe("markdownLinkDestination", () => {
  it("leaves a plain path alone", () => {
    expect(markdownLinkDestination("./AERDM-1.attachments/shot.png")).toBe(
      "./AERDM-1.attachments/shot.png",
    )
  })

  it("wraps a path markdown would split on", () => {
    expect(markdownLinkDestination("./a b/c.png")).toBe("<./a b/c.png>")
    expect(markdownLinkDestination("./a(b).png")).toBe("<./a(b).png>")
  })
})

describe("no body text is ever lost", () => {
  /** Characters with no markup meaning at all: nothing here can trigger a rule. */
  const INERT = "abcXYZ019 ,:()?收中\n\t".split("")
  const WORD_CHARS = "abcXYZ019收中".split("")
  /** Markup characters that surround a word without ever replacing it. */
  const SURROUND = [" ", "\n", "*", "_", "#", "-", "(", ")", ",", ":"]

  const textOf = (units: string[]) => units.join("")

  it("passes inert text through untouched", () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom(...INERT), { maxLength: 200 }).map(textOf),
        (input) => {
          const output = jiraWikiToMarkdown(input)
          // Whitespace is allowed to change; not one other character is.
          expect(output.replace(/\s+/g, "")).toBe(input.replace(/\s+/g, ""))
        },
      ),
    )
  })

  it("never eats a word, whatever markup surrounds it", () => {
    const word = fc
      .array(fc.constantFrom(...WORD_CHARS), { minLength: 1, maxLength: 8 })
      .map((chars) => ({ isWord: true, text: textOf(chars) }))
    const punctuation = fc
      .constantFrom(...SURROUND)
      .map((text) => ({ isWord: false, text }))

    fc.assert(
      fc.property(fc.array(fc.oneof(word, punctuation), { minLength: 1, maxLength: 40 }), (parts) => {
        const output = jiraWikiToMarkdown(textOf(parts.map((entry) => entry.text)))
        for (const entry of parts) {
          if (entry.isWord) expect(output).toContain(entry.text)
        }
      }),
    )
  })
})

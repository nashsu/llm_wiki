import { describe, expect, it } from "vitest"
import type { JiraChangelogHistory, JiraComment, JiraIssueFull } from "@/types/jira"
import {
  buildActivityTimeline,
  buildJiraMarkdown,
  formatAttachmentSize,
  formatJiraActivityTime,
  formatJiraTimestamp,
  JIRA_MD_EMPTY,
  JIRA_MD_SECTIONS,
  type JiraExportedAttachment,
} from "./jira-markdown"

const BASE = "https://jira.example.com"
const EXPORTED_AT = new Date(2026, 8, 27, 14, 3)

function issue(overrides: Partial<JiraIssueFull["fields"]> = {}, key = "AERDM-1234"): JiraIssueFull {
  return { id: "1", key, fields: overrides }
}

function download(filename: string, sizeBytes: number, mimeType = "image/png"): JiraExportedAttachment {
  return {
    id: filename,
    filename,
    relativePath: `./AERDM-1234.attachments/${filename}`,
    sizeBytes,
    mimeType,
    status: "downloaded",
  }
}

function build(overrides: {
  fields?: Partial<JiraIssueFull["fields"]>
  attachments?: JiraExportedAttachment[]
  processValue?: unknown
  changelog?: JiraIssueFull["changelog"]
  baseUrl?: string
  exportedAt?: Date
  key?: string
}) {
  return buildJiraMarkdown({
    issue: { ...issue(overrides.fields, overrides.key), changelog: overrides.changelog },
    baseUrl: overrides.baseUrl ?? BASE,
    exportedAt: overrides.exportedAt ?? EXPORTED_AT,
    processValue: overrides.processValue,
    attachments: overrides.attachments ?? [],
  })
}

/** The `##` headings, in the order they appear. */
function sectionHeadings(markdown: string): string[] {
  return [...markdown.matchAll(/^## (.+)$/gm)].map((match) => match[1])
}

/** The body under one `##` section. */
function section(markdown: string, heading: string): string {
  const parts = markdown.split(/^## /m)
  const found = parts.find((part) => part.startsWith(`${heading}\n`))
  return (found ?? "").slice(heading.length).trim()
}

describe("document shape", () => {
  it("always writes the seven sections in the fixed order", () => {
    expect(sectionHeadings(build({}))).toEqual([...JIRA_MD_SECTIONS])
  })

  it("keeps the order even when every section is populated", () => {
    const markdown = build({
      fields: {
        summary: "DAB_box 收音",
        labels: ["DAB"],
        description: "text",
        issuelinks: [{ type: { name: "Blocks" }, outwardIssue: { key: "AERDM-2" } }],
      },
      attachments: [download("shot.png", 100)],
    })
    expect(sectionHeadings(markdown)).toEqual([...JIRA_MD_SECTIONS])
  })

  it("writes an empty marker into every section that has nothing to show", () => {
    const markdown = build({})
    for (const heading of JIRA_MD_SECTIONS) {
      expect(section(markdown, heading)).toBe(JIRA_MD_EMPTY)
    }
  })

  it("ends with a newline so the file is a well-formed text file", () => {
    expect(build({}).endsWith("\n")).toBe(true)
  })
})

describe("frontmatter", () => {
  it("identifies the source, the issue and the export time", () => {
    const markdown = build({ fields: { summary: "DAB_box 收音" } })
    const lines = markdown.split("---\n")[1].trim().split("\n")
    expect(lines).toContain("source: jira")
    expect(lines).toContain("issue: AERDM-1234")
    expect(lines).toContain("url: https://jira.example.com/browse/AERDM-1234")
    expect(lines).toContain("exported_at: 2026-09-27 14:03")
  })

  it("writes an empty label list as a flow sequence", () => {
    expect(build({}).split("---\n")[1]).toContain("labels: []")
  })

  it("writes labels as a YAML list", () => {
    const markdown = build({ fields: { labels: ["DAB", "radio"] } })
    expect(markdown.split("---\n")[1]).toContain("labels:\n  - DAB\n  - radio")
  })

  it("quotes a label YAML could not read back as written", () => {
    const markdown = build({ fields: { labels: ["needs space"] } })
    expect(markdown.split("---\n")[1]).toContain('  - "needs space"')
  })

  it("omits the url line when no instance is configured", () => {
    const markdown = build({ baseUrl: "" })
    expect(markdown).not.toContain("url: ")
    expect(markdown).not.toContain("来源:")
  })
})

describe("the title block", () => {
  it("puts the key and the summary in the H1 and in the 标题 section", () => {
    const markdown = build({ fields: { summary: "DAB_box 收音" } })
    expect(markdown).toContain("# AERDM-1234 DAB_box 收音")
    expect(section(markdown, "标题")).toBe("DAB_box 收音")
  })

  it("shows only the key when the summary is empty", () => {
    expect(build({})).toContain("# AERDM-1234\n")
  })

  it("states the export time and the issue URL", () => {
    expect(build({})).toContain(
      "> 导出时间: 2026-09-27 14:03 · 来源: https://jira.example.com/browse/AERDM-1234",
    )
  })
})

describe("标签", () => {
  it("wraps each label in backticks so a label can never render as markup", () => {
    expect(section(build({ fields: { labels: ["DAB", "*bold*"] } }), "标签")).toBe(
      "- `DAB`\n- `*bold*`",
    )
  })
})

describe("任务过程描述", () => {
  it("is empty while no custom field is configured", () => {
    expect(section(build({}), "任务过程描述")).toBe(JIRA_MD_EMPTY)
  })

  it("renders a configured field through the wiki converter", () => {
    const markdown = build({ processValue: "h3. 步骤\n# 第一步\n# 第二步" })
    expect(section(markdown, "任务过程描述")).toBe("### 步骤\n1. 第一步\n1. 第二步")
  })

  it("keeps a non-string value as JSON rather than dropping it", () => {
    const markdown = build({ processValue: { type: "doc", content: [] } })
    expect(section(markdown, "任务过程描述")).toContain("```json")
    expect(section(markdown, "任务过程描述")).toContain('"type": "doc"')
  })

  it("renders a numeric value as text", () => {
    expect(section(build({ processValue: 42 }), "任务过程描述")).toBe("42")
  })
})

describe("描述", () => {
  it("converts wiki markup", () => {
    const markdown = build({ fields: { description: "h3. 现象\n\n*粗体*" } })
    expect(section(markdown, "描述")).toBe("### 现象\n\n**粗体**")
  })

  it("is empty when the description is null", () => {
    expect(section(build({ fields: { description: null } }), "描述")).toBe(JIRA_MD_EMPTY)
  })

  it("links an attachment image referenced in the description", () => {
    const markdown = build({
      fields: { description: "!shot.png!" },
      attachments: [download("shot.png", 100)],
    })
    expect(section(markdown, "描述")).toBe("[shot.png](./AERDM-1234.attachments/shot.png)")
  })

  it("links an issue key mentioned in the description", () => {
    expect(section(build({ fields: { description: "见 [AERDM-1000]" } }), "描述")).toBe(
      "见 [AERDM-1000](https://jira.example.com/browse/AERDM-1000)",
    )
  })
})

describe("附件", () => {
  it("links a downloaded attachment with its type and size", () => {
    const markdown = build({ attachments: [download("shot.png", 49357)] })
    expect(section(markdown, "附件")).toBe(
      "- [shot.png](./AERDM-1234.attachments/shot.png) （image/png, 48.2 KB）",
    )
  })

  it("never writes a link for an attachment that was not written to disk", () => {
    const markdown = build({
      attachments: [
        { id: "1", filename: "dump.bin", status: "failed", detail: "下载失败: HTTP 403", sizeBytes: 12582912, mimeType: "application/octet-stream" },
        { id: "2", filename: "huge.zip", status: "skipped", detail: "超过 50 MB 上限" },
      ],
    })
    const body = section(markdown, "附件")
    expect(body).not.toContain("](")
    expect(body).toContain("- dump.bin （下载失败: HTTP 403） （application/octet-stream, 12.0 MB）")
    expect(body).toContain("- huge.zip （超过 50 MB 上限） （application/octet-stream,")
  })

  it("lists every attachment on its own line", () => {
    const markdown = build({ attachments: [download("a.png", 100), download("b.png", 100)] })
    expect(section(markdown, "附件").split("\n")).toHaveLength(2)
  })
})

describe("问题链接", () => {
  it("writes a GFM table with the direction column", () => {
    const markdown = build({
      fields: {
        issuelinks: [
          {
            type: { name: "Blocks", outward: "blocks" },
            outwardIssue: {
              key: "AERDM-2000",
              fields: { summary: "修复 I2C 时序", status: { name: "进行中" } },
            },
          },
          {
            type: { name: "Relates" },
            inwardIssue: { key: "AERDM-1500", fields: { summary: "DAB 模块重构", status: { name: "已完成" } } },
          },
        ],
      },
    })

    const body = section(markdown, "问题链接")
    expect(body.split("\n")[0]).toBe("| 类型 | 方向 | 关联问题 | 状态 | 摘要 |")
    expect(body.split("\n")[1]).toBe("| --- | --- | --- | --- | --- |")
    expect(body).toContain(
      "| Blocks | outward | [AERDM-2000](https://jira.example.com/browse/AERDM-2000) | 进行中 | 修复 I2C 时序 |",
    )
    expect(body).toContain(
      "| Relates | inward | [AERDM-1500](https://jira.example.com/browse/AERDM-1500) | 已完成 | DAB 模块重构 |",
    )
  })

  it("escapes a pipe in a summary so the table keeps its shape", () => {
    const markdown = build({
      fields: {
        issuelinks: [
          { type: { name: "Relates" }, inwardIssue: { key: "AERDM-1", fields: { summary: "a|b" } } },
        ],
      },
    })
    expect(section(markdown, "问题链接")).toContain("a\\|b")
  })

  it("escapes markup characters so a summary never renders as emphasis", () => {
    const markdown = build({
      fields: {
        issuelinks: [
          {
            type: { name: "Relates" },
            inwardIssue: { key: "AERDM-1", fields: { summary: "*DAB_box* 收音" } },
          },
        ],
      },
    })
    expect(section(markdown, "问题链接")).toContain("\\*DAB\\_box\\* 收音")
  })

  it("is empty when the issue has no links", () => {
    expect(section(build({}), "问题链接")).toBe(JIRA_MD_EMPTY)
  })

  it("skips a link whose target has no key", () => {
    const markdown = build({
      fields: { issuelinks: [{ type: { name: "Blocks" }, outwardIssue: { fields: {} } }] },
    })
    expect(section(markdown, "问题链接")).toBe(JIRA_MD_EMPTY)
  })

  it("lists both directions when Jira returns both", () => {
    const markdown = build({
      fields: {
        issuelinks: [
          {
            type: { name: "Relates" },
            outwardIssue: { key: "AERDM-2" },
            inwardIssue: { key: "AERDM-3" },
          },
        ],
      },
    })
    const body = section(markdown, "问题链接")
    expect(body).toContain("outward")
    expect(body).toContain("inward")
  })
})

describe("活动", () => {
  const comment = (id: string, created: string, body = "body"): JiraComment => ({
    id,
    body,
    created,
    author: { displayName: "张三" },
  })

  const history = (id: string, created: string, field = "status"): JiraChangelogHistory => ({
    id,
    created,
    author: { displayName: "李四" },
    items: [{ field, fromString: "待办", toString: "进行中" }],
  })

  it("is empty when there is neither a comment nor a change", () => {
    expect(section(build({}), "活动")).toBe(JIRA_MD_EMPTY)
  })

  it("merges comments and changes on one ascending timeline", () => {
    const markdown = build({
      fields: { comment: { comments: [comment("1", "2026-03-01T02:22:00.000Z")] } },
      changelog: { histories: [history("2", "2026-03-02T01:10:00.000Z")] },
    })
    const body = section(markdown, "活动")
    expect(body.indexOf("张三")).toBeLessThan(body.indexOf("李四"))
    expect(body).toContain("（评论）")
    expect(body).toContain("（字段变更）")
  })

  it("renders a field change as one line per entry", () => {
    const markdown = build({ changelog: { histories: [history("1", "2026-03-02T01:10:00.000Z")] } })
    expect(section(markdown, "活动")).toContain("status: 待办 → 进行中")
  })

  it("shows an empty side of a change as the empty marker", () => {
    const markdown = build({
      changelog: {
        histories: [
          {
            id: "1",
            created: "2026-03-02T01:10:00.000Z",
            items: [{ field: "assignee", fromString: null, toString: "李四" }],
          },
        ],
      },
    })
    expect(section(markdown, "活动")).toContain(`assignee: ${JIRA_MD_EMPTY} → 李四`)
  })

  it("converts the wiki markup in a comment body", () => {
    const markdown = build({
      fields: { comment: { comments: [comment("1", "2026-03-01T02:22:00.000Z", "h3. 标题")] } },
    })
    expect(section(markdown, "活动")).toContain("### 标题")
  })

  it("links an attachment referenced from a comment", () => {
    const markdown = build({
      fields: { comment: { comments: [comment("1", "2026-03-01T02:22:00.000Z", "!shot.png!")] } },
      attachments: [download("shot.png", 100)],
    })
    expect(section(markdown, "活动")).toContain("[shot.png](./AERDM-1234.attachments/shot.png)")
  })

  it("marks an edited comment and says when", () => {
    const markdown = build({
      fields: {
        comment: {
          comments: [
            {
              id: "1",
              body: "x",
              created: "2026-03-01T02:22:00.000Z",
              updated: "2026-03-06T01:00:00.000Z",
              author: { displayName: "王五" },
            },
          ],
        },
      },
    })
    expect(section(markdown, "活动")).toContain("已编辑")
  })

  it("does not mark an unedited comment", () => {
    const markdown = build({
      fields: {
        comment: {
          comments: [
            {
              id: "1",
              body: "x",
              created: "2026-03-01T02:22:00.000Z",
              updated: "2026-03-01T02:22:00.000Z",
              author: { displayName: "王五" },
            },
          ],
        },
      },
    })
    expect(section(markdown, "活动")).not.toContain("已编辑")
  })

  it("names an anonymous author rather than leaving a gap", () => {
    const markdown = build({
      fields: { comment: { comments: [{ id: "1", body: "x", created: "2026-03-01T02:22:00.000Z" }] } },
    })
    expect(section(markdown, "活动")).toContain("未知")
  })
})

describe("buildActivityTimeline", () => {
  it("sorts ascending by time", () => {
    const timeline = buildActivityTimeline({
      comments: [
        { id: "3", created: "2026-03-03T00:00:00.000Z", body: "c" },
        { id: "1", created: "2026-03-01T00:00:00.000Z", body: "a" },
      ],
      histories: [
        {
          id: "2",
          created: "2026-03-02T00:00:00.000Z",
          items: [{ field: "status", fromString: "待办", toString: "进行中" }],
        },
      ],
    })
    expect(timeline.map((entry) => entry.id)).toEqual(["comment-1", "change-2", "comment-3"])
  })

  it("breaks a timestamp tie on the id so the file is byte-stable", () => {
    const same = "2026-03-01T00:00:00.000Z"
    const timeline = buildActivityTimeline({
      comments: [{ id: "b", created: same, body: "second" }],
      histories: [{ id: "a", created: same, items: [{ field: "status", toString: "进行中" }] }],
    })
    expect(timeline.map((entry) => entry.id)).toEqual(["change-a", "comment-b"])
  })

  it("falls back to string ordering when a timestamp cannot be parsed", () => {
    const timeline = buildActivityTimeline({
      comments: [
        { id: "1", created: "nonsense", body: "a" },
        { id: "2", created: "2026-03-01T00:00:00.000Z", body: "b" },
      ],
    })
    // Both are unparseable-vs-parseable, so the two raw strings decide.
    expect(timeline).toHaveLength(2)
    expect(timeline[0].timestamp).toBe("2026-03-01T00:00:00.000Z")
  })

  it("keeps two unparseable timestamps in string order", () => {
    const timeline = buildActivityTimeline({
      comments: [
        { id: "1", created: "zzz", body: "a" },
        { id: "2", created: "aaa", body: "b" },
      ],
    })
    expect(timeline.map((entry) => entry.id)).toEqual(["comment-2", "comment-1"])
  })

  it("drops a changelog entry that changed nothing", () => {
    const timeline = buildActivityTimeline({ histories: [{ id: "1", created: "x", items: [] }] })
    expect(timeline).toEqual([])
  })

  it("carries the from/to strings through", () => {
    const timeline = buildActivityTimeline({
      histories: [
        {
          id: "1",
          created: "2026-03-01T00:00:00.000Z",
          items: [{ field: "status", fromString: "a", toString: "b" }],
        },
      ],
    })
    expect(timeline[0].changes).toEqual([{ field: "status", from: "a", to: "b" }])
  })

  it("prefers the display string over the raw id", () => {
    const timeline = buildActivityTimeline({
      histories: [
        {
          id: "1",
          created: "2026-03-01T00:00:00.000Z",
          items: [{ field: "priority", from: "1", toString: "High" }],
        },
      ],
    })
    expect(timeline[0].changes).toEqual([{ field: "priority", from: "1", to: "High" }])
  })

  it("returns an empty timeline for nothing at all", () => {
    expect(buildActivityTimeline({})).toEqual([])
  })
})

describe("formatting helpers", () => {
  it("formats a local date and time", () => {
    expect(formatJiraTimestamp(new Date(2026, 8, 27, 14, 3))).toBe("2026-09-27 14:03")
    expect(formatJiraTimestamp(new Date(2026, 0, 5, 9, 40))).toBe("2026-01-05 09:40")
  })

  it("converts a Jira +0800 timestamp", () => {
    expect(formatJiraActivityTime("2026-03-01T10:22:00.000+0800")).toMatch(
      /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/,
    )
  })

  it("falls back to the raw string when the timestamp cannot be parsed", () => {
    expect(formatJiraActivityTime("not a date")).toBe("not a date")
    expect(formatJiraActivityTime("")).toBe("")
  })

  it("formats sizes across the unit boundaries", () => {
    expect(formatAttachmentSize(0)).toBe("0 B")
    expect(formatAttachmentSize(1023)).toBe("1023 B")
    expect(formatAttachmentSize(1024)).toBe("1.0 KB")
    expect(formatAttachmentSize(49357)).toBe("48.2 KB")
    expect(formatAttachmentSize(1024 * 1024)).toBe("1.0 MB")
    expect(formatAttachmentSize(12582912)).toBe("12.0 MB")
  })

  it("says so when the size is unknown or nonsense", () => {
    expect(formatAttachmentSize(undefined)).toBe("大小未知")
    expect(formatAttachmentSize(-1)).toBe("大小未知")
    expect(formatAttachmentSize(NaN)).toBe("大小未知")
  })
})

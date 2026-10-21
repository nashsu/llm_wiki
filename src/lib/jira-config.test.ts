import { describe, expect, it } from "vitest"
import {
  DEFAULT_JIRA_CONFIG,
  isJiraConfigured,
  JIRA_DEFAULT_EXPORT_DIR,
  JIRA_DEFAULT_USER_AGENT,
  jiraApiUrl,
  jiraAttachmentsDirName,
  jiraBrowseUrl,
  normalizeJiraConfig,
  resolveJiraExportDir,
} from "./jira-config"

describe("normalizeJiraConfig", () => {
  it("returns the defaults for nothing at all", () => {
    expect(normalizeJiraConfig()).toEqual(DEFAULT_JIRA_CONFIG)
    expect(normalizeJiraConfig(null)).toEqual(DEFAULT_JIRA_CONFIG)
  })

  it("fills in every missing field of a partial config", () => {
    const config = normalizeJiraConfig({ username: "someone" })
    expect(config.username).toBe("someone")
    expect(config.baseUrl).toBe(DEFAULT_JIRA_CONFIG.baseUrl)
    expect(config.exportDir).toBe(JIRA_DEFAULT_EXPORT_DIR)
  })

  it("trims the base URL and drops trailing slashes so no URL gets a doubled slash", () => {
    expect(normalizeJiraConfig({ baseUrl: "  https://jira.example.com///  " }).baseUrl).toBe(
      "https://jira.example.com",
    )
  })

  it("leaves the password alone — spaces can be part of a real password", () => {
    expect(normalizeJiraConfig({ password: "  hunter2  " }).password).toBe("  hunter2  ")
  })

  it("falls back to an empty password when the stored value is not a string", () => {
    expect(normalizeJiraConfig({ password: 12345 as unknown as string }).password).toBe("")
  })

  it("trims the username and the field id", () => {
    const config = normalizeJiraConfig({ username: " someone ", processFieldId: " cf_1 " })
    expect(config.username).toBe("someone")
    expect(config.processFieldId).toBe("cf_1")
  })

  it("restores the default export dir when it is blank", () => {
    expect(normalizeJiraConfig({ exportDir: "   " }).exportDir).toBe(JIRA_DEFAULT_EXPORT_DIR)
  })

  it("restores the default User-Agent when it is blank", () => {
    expect(normalizeJiraConfig({ userAgent: "" }).userAgent).toBe(JIRA_DEFAULT_USER_AGENT)
  })

  it("clamps the attachment ceiling to 1–2048 MB", () => {
    expect(normalizeJiraConfig({ maxAttachmentMb: 0 }).maxAttachmentMb).toBe(1)
    expect(normalizeJiraConfig({ maxAttachmentMb: -5 }).maxAttachmentMb).toBe(1)
    expect(normalizeJiraConfig({ maxAttachmentMb: 99999 }).maxAttachmentMb).toBe(2048)
    expect(normalizeJiraConfig({ maxAttachmentMb: 100 }).maxAttachmentMb).toBe(100)
  })

  it("clamps the sweep paging to 25–200 and the sweep ceiling to 100–5000", () => {
    expect(normalizeJiraConfig({ sweepPageSize: 1 }).sweepPageSize).toBe(25)
    expect(normalizeJiraConfig({ sweepPageSize: 1000 }).sweepPageSize).toBe(200)
    expect(normalizeJiraConfig({ maxSweepIssues: 10 }).maxSweepIssues).toBe(100)
    expect(normalizeJiraConfig({ maxSweepIssues: 99999 }).maxSweepIssues).toBe(5000)
  })

  it("rounds a fractional number instead of passing it to the API", () => {
    expect(normalizeJiraConfig({ maxAttachmentMb: 12.6 }).maxAttachmentMb).toBe(13)
  })

  it("uses the default when a number is not a number", () => {
    expect(normalizeJiraConfig({ maxAttachmentMb: "abc" as unknown as number }).maxAttachmentMb).toBe(
      DEFAULT_JIRA_CONFIG.maxAttachmentMb,
    )
    expect(normalizeJiraConfig({ maxAttachmentMb: NaN }).maxAttachmentMb).toBe(
      DEFAULT_JIRA_CONFIG.maxAttachmentMb,
    )
  })

  it("reads the numeric fields from their string form, as a settings Input yields", () => {
    expect(normalizeJiraConfig({ maxAttachmentMb: "128" as unknown as number }).maxAttachmentMb).toBe(
      128,
    )
  })

  it("defaults certificate verification off, matching the reference setup", () => {
    expect(DEFAULT_JIRA_CONFIG.acceptInvalidCerts).toBe(true)
    expect(normalizeJiraConfig({}).acceptInvalidCerts).toBe(true)
    expect(normalizeJiraConfig({ acceptInvalidCerts: false }).acceptInvalidCerts).toBe(false)
  })

  it("defaults matchCase to off and only honours an explicit true", () => {
    expect(normalizeJiraConfig({}).matchCase).toBe(false)
    expect(normalizeJiraConfig({ matchCase: true }).matchCase).toBe(true)
    expect(normalizeJiraConfig({ matchCase: "yes" as unknown as boolean }).matchCase).toBe(false)
  })
})

describe("jiraApiUrl", () => {
  it("builds a v2 REST URL", () => {
    expect(jiraApiUrl("https://jira.example.com", "search?jql=x")).toBe(
      "https://jira.example.com/rest/api/2/search?jql=x",
    )
  })

  it("does not double the slash on either side", () => {
    expect(jiraApiUrl("https://jira.example.com/", "/issue/AERDM-1")).toBe(
      "https://jira.example.com/rest/api/2/issue/AERDM-1",
    )
  })
})

describe("jiraBrowseUrl", () => {
  it("builds the human-facing issue page and tolerates a trailing slash", () => {
    expect(jiraBrowseUrl("https://jira.example.com", "AERDM-1234")).toBe(
      "https://jira.example.com/browse/AERDM-1234",
    )
    expect(jiraBrowseUrl("https://jira.example.com/", "AERDM-1234")).toBe(
      "https://jira.example.com/browse/AERDM-1234",
    )
  })
})

describe("resolveJiraExportDir", () => {
  it("joins a relative dir onto the project root", () => {
    expect(resolveJiraExportDir("D:/projects/wiki", JIRA_DEFAULT_EXPORT_DIR)).toBe(
      "D:/projects/wiki/raw/sources/Collection/JIRA",
    )
  })

  it("normalises a Windows-style project path", () => {
    expect(resolveJiraExportDir("D:\\projects\\wiki\\", "raw/sources/JIRA")).toBe(
      "D:/projects/wiki/raw/sources/JIRA",
    )
  })

  it("uses an absolute export dir as it is", () => {
    expect(resolveJiraExportDir("D:/projects/wiki", "E:/out/jira")).toBe("E:/out/jira")
    expect(resolveJiraExportDir("D:/projects/wiki", "/tmp/jira")).toBe("/tmp/jira")
  })

  it("falls back to the default dir when the setting is blank", () => {
    expect(resolveJiraExportDir("D:/projects/wiki", "  ")).toBe(
      "D:/projects/wiki/" + JIRA_DEFAULT_EXPORT_DIR,
    )
  })

  it("returns the relative dir unchanged when there is no project root yet", () => {
    expect(resolveJiraExportDir("", "raw/sources/JIRA")).toBe("raw/sources/JIRA")
  })
})

describe("jiraAttachmentsDirName", () => {
  it("names the attachment folder after the issue", () => {
    expect(jiraAttachmentsDirName("AERDM-1234")).toBe("AERDM-1234.attachments")
  })
})

describe("isJiraConfigured", () => {
  const base = { baseUrl: "https://jira.example.com", username: "someone", password: "s3cret" }

  it("is true once a server, a username and a password are all present", () => {
    expect(isJiraConfigured(normalizeJiraConfig(base))).toBe(true)
  })

  it("is false while any one of them is missing", () => {
    expect(isJiraConfigured(normalizeJiraConfig({ ...base, baseUrl: "" }))).toBe(false)
    expect(isJiraConfigured(normalizeJiraConfig({ ...base, username: "" }))).toBe(false)
    expect(isJiraConfigured(normalizeJiraConfig({ ...base, password: "" }))).toBe(false)
    expect(isJiraConfigured(DEFAULT_JIRA_CONFIG)).toBe(false)
  })

  it("treats a whitespace-only password as present, since it is never trimmed", () => {
    expect(isJiraConfigured(normalizeJiraConfig({ ...base, password: "   " }))).toBe(true)
  })
})

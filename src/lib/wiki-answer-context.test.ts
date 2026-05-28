import { describe, expect, it } from "vitest"
import { buildWikiAnswerContext } from "./wiki-answer-context"

describe("buildWikiAnswerContext", () => {
  it("keeps greeting handling on the short deterministic chat path", async () => {
    const context = await buildWikiAnswerContext({
      project: { name: "Demo Wiki", path: "/project" },
      query: "你好",
      maxContextSize: 50000,
      dataVersion: 0,
    })

    expect(context.queryRefs).toEqual([])
    expect(context.languageReminder).toBeUndefined()
    expect(context.systemMessages).toHaveLength(1)
    expect(context.systemMessages[0]).toMatchObject({ role: "system" })
    expect(context.systemMessages[0].content).toContain('project "Demo Wiki"')
    expect(context.systemMessages[0].content).toContain("casual greeting")
  })
})

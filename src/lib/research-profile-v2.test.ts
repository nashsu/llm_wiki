import { describe, expect, it } from "vitest"
import en from "@/i18n/en.json"
import zh from "@/i18n/zh.json"

describe("Research Profile v2 translations", () => {
  it("labels repository pages across sidebar, activity, and graph rendering", () => {
    expect(en.sidebar.typeLabels.repository).toBe("Repositories")
    expect(en.activity.fileTypes.repository).toBe("Repository")
    expect(en.graph.nodeTypeLabels.repository).toBe("Repository")

    expect(zh.sidebar.typeLabels.repository).toBe("代码仓库")
    expect(zh.activity.fileTypes.repository).toBe("代码仓库")
    expect(zh.graph.nodeTypeLabels.repository).toBe("代码仓库")
  })
})


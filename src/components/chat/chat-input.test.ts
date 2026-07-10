import { describe, expect, it } from "vitest"
import {
  filterSlashSkillOptions,
  findSlashSkillTrigger,
  removeSlashSkillToken,
  skillChipDeleteTarget,
  type ChatSkillOption,
} from "./chat-input"

const skills: ChatSkillOption[] = [
  {
    id: "reviewer",
    name: "Reviewer",
    description: "Review code and documents",
    source: "project",
  },
  {
    id: "illustrator",
    name: "Illustrator",
    description: "Create article images",
    source: "claude",
  },
  {
    id: "draft",
    name: "Draft",
    description: "Write drafts",
    source: "agents",
  },
]

describe("chat slash skill helpers", () => {
  it("detects slash skill tokens at the cursor", () => {
    expect(findSlashSkillTrigger("/re", 3)).toEqual({ start: 0, end: 3, query: "re" })
    expect(findSlashSkillTrigger("hi /re", 6)).toEqual({ start: 3, end: 6, query: "re" })
    expect(findSlashSkillTrigger("a\n/re", 5)).toEqual({ start: 2, end: 5, query: "re" })
    expect(findSlashSkillTrigger("/review", 4)).toEqual({ start: 0, end: 7, query: "rev" })
  })

  it("does not detect mid-word slashes or out-of-range cursors", () => {
    expect(findSlashSkillTrigger("http://x", 8)).toBeNull()
    expect(findSlashSkillTrigger("/re", 0)).toBeNull()
    expect(findSlashSkillTrigger("/re", -1)).toBeNull()
    expect(findSlashSkillTrigger("/re", 99)).toBeNull()
  })

  it("removes a slash token without gluing adjacent words", () => {
    const trigger = findSlashSkillTrigger("a /x b", 4)
    expect(trigger).not.toBeNull()
    expect(removeSlashSkillToken("a /x b", trigger!)).toEqual({ value: "a  b", cursor: 2 })
  })

  it("removes the whole slash token when the cursor is in the middle", () => {
    const trigger = findSlashSkillTrigger("/review", 4)
    expect(trigger).not.toBeNull()
    expect(removeSlashSkillToken("/review", trigger!)).toEqual({ value: "", cursor: 0 })
  })

  it("filters skills by name, id, description, and localized source label", () => {
    const sourceLabel = (source: string) => ({ project: "项目", claude: "Claude", agents: "Agents" }[source] ?? source)

    expect(filterSlashSkillOptions(skills, "rev", sourceLabel).map((skill) => skill.id)).toEqual(["reviewer"])
    expect(filterSlashSkillOptions(skills, "图片", sourceLabel).map((skill) => skill.id)).toEqual([])
    expect(filterSlashSkillOptions(skills, "项目", sourceLabel).map((skill) => skill.id)).toEqual(["reviewer"])
  })

  it("caps filtered skills to the requested limit", () => {
    expect(filterSlashSkillOptions(skills, "", (source) => source, 2).map((skill) => skill.id)).toEqual([
      "reviewer",
      "illustrator",
    ])
  })

  it("returns every matching skill by default", () => {
    const manySkills = Array.from({ length: 12 }, (_, index) => ({
      id: `skill-${index}`,
      name: `Skill ${index}`,
      source: "project",
    }))

    expect(filterSlashSkillOptions(manySkills, "", (source) => source)).toHaveLength(12)
  })

  it("maps boundary deletion to whole skill chips without hijacking forward-delete text editing", () => {
    expect(skillChipDeleteTarget("Backspace", "hello", 0, 0, 2)).toBe("last")
    expect(skillChipDeleteTarget("Delete", "", 0, 0, 2)).toBe("first")
    expect(skillChipDeleteTarget("Delete", "hello", 0, 0, 2)).toBeNull()
    expect(skillChipDeleteTarget("Backspace", "hello", 0, 2, 2)).toBeNull()
    expect(skillChipDeleteTarget("Backspace", "hello", 0, 0, 0)).toBeNull()
  })
})

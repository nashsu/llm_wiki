import { describe, expect, it } from "vitest"
import { getCreateProjectFormStatus } from "./create-project-dialog"

describe("getCreateProjectFormStatus", () => {
  it("keeps the initial disabled state quiet before the user interacts", () => {
    expect(getCreateProjectFormStatus("", "", "", "", false)).toEqual({
      missingRequired: true,
      canCreate: false,
      footerError: "",
      footerMessageKey: null,
    })
  })

  it("shows the required hint after interaction while fields are missing", () => {
    expect(getCreateProjectFormStatus("Research", "", "", "", true)).toEqual({
      missingRequired: true,
      canCreate: false,
      footerError: "",
      footerMessageKey: "project.requiredHint",
    })
  })

  it("treats whitespace-only names as missing", () => {
    expect(getCreateProjectFormStatus("   ", "/Users/me", "Chinese", "", true)).toEqual({
      missingRequired: true,
      canCreate: false,
      footerError: "",
      footerMessageKey: "project.requiredHint",
    })
  })

  it("treats whitespace-only paths as missing", () => {
    expect(getCreateProjectFormStatus("Research", "   ", "Chinese", "", true)).toEqual({
      missingRequired: true,
      canCreate: false,
      footerError: "",
      footerMessageKey: "project.requiredHint",
    })
  })

  it("enables creation when name, language, and parent directory are present", () => {
    expect(getCreateProjectFormStatus("Research", "/Users/me", "Chinese", "", true)).toEqual({
      missingRequired: false,
      canCreate: true,
      footerError: "",
      footerMessageKey: null,
    })
  })

  it("prefers server errors over the required-fields hint", () => {
    expect(getCreateProjectFormStatus("", "", "", "Permission denied", true)).toEqual({
      missingRequired: true,
      canCreate: false,
      footerError: "Permission denied",
      footerMessageKey: null,
    })
  })

  it("keeps server errors visible even before interaction", () => {
    expect(getCreateProjectFormStatus("", "", "", "Permission denied", false)).toEqual({
      missingRequired: true,
      canCreate: false,
      footerError: "Permission denied",
      footerMessageKey: null,
    })
  })

  it("keeps creation enabled when fields are valid but a server error is present", () => {
    expect(getCreateProjectFormStatus("Research", "/Users/me", "Chinese", "Permission denied", true)).toEqual({
      missingRequired: false,
      canCreate: true,
      footerError: "Permission denied",
      footerMessageKey: null,
    })
  })
})

import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

const script = readFileSync(
  resolve(process.cwd(), ".github/scripts/verify-macos-release.sh"),
  "utf8",
)

describe("macOS release verification", () => {
  it("verifies the DMG container and the notarized app inside it", () => {
    expect(script).toContain('hdiutil verify "$dmg_path"')
    expect(script).toContain('verify_app "$mounted_app"')
    expect(script).not.toContain('stapler validate "$dmg_path"')
  })
})

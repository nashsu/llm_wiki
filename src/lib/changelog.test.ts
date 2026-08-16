import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { CHANGELOG } from "@/lib/changelog"

function readJson(path: URL): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>
}

describe("release metadata", () => {
  it("keeps app manifests and the latest changelog version aligned", () => {
    const packageJson = readJson(new URL("../../package.json", import.meta.url))
    const tauriConfig = readJson(new URL("../../src-tauri/tauri.conf.json", import.meta.url))
    const cargoToml = readFileSync(
      new URL("../../src-tauri/Cargo.toml", import.meta.url),
      "utf8",
    )
    const cargoVersion = cargoToml.match(/^version\s*=\s*"([^"]+)"/m)?.[1]

    expect(CHANGELOG[0]?.version).toBe(packageJson.version)
    expect(tauriConfig.version).toBe(packageJson.version)
    expect(cargoVersion).toBe(packageJson.version)
  })
})

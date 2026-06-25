import { readFileSync } from "node:fs"

export const FALLBACK_VERSION = "0.0.0"

export function loadMcpServerVersion(metaUrl: string = import.meta.url): string {
  // These layouts are mutually exclusive: source/dev execution resolves via
  // ../package.json, while compiled dist/src execution resolves via
  // ../../package.json.
  for (const relativePackageJson of ["../package.json", "../../package.json"]) {
    try {
      const candidate = new URL(relativePackageJson, metaUrl)
      const parsed = JSON.parse(readFileSync(candidate, "utf8")) as { version?: unknown }
      if (typeof parsed.version === "string" && parsed.version.trim()) {
        return parsed.version
      }
    } catch {
      // Try the next layout.
    }
  }

  process.stderr.write("[llm-wiki-mcp] package.json version not found; using fallback 0.0.0\n")
  return FALLBACK_VERSION
}

export const VERSION = loadMcpServerVersion()

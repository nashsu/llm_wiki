/**
 * Structural parity check for the translation bundles.
 *
 * If en.json grows a key that zh.json doesn't have (or vice-versa),
 * the app either falls back to the raw key at runtime (ugly) or
 * silently shows the English string to Chinese users. Both are
 * regressions we want to catch at test time.
 *
 * This test is deliberately string-based rather than going through
 * i18next's runtime — it should fail on the FILE contents before
 * anyone notices in the UI.
 */
import { describe, it, expect } from "vitest"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { readFileSync, readdirSync } from "node:fs"
import en from "./en.json"

/** Flattens a nested translation object to "a.b.c" dot-path keys. */
function flattenKeys(obj: unknown, prefix = ""): string[] {
  if (obj === null || typeof obj !== "object") return []
  const out: string[] = []
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${k}` : k
    if (v !== null && typeof v === "object") {
      out.push(...flattenKeys(v, path))
    } else {
      out.push(path)
    }
  }
  return out
}

function valueAtPath(bundle: unknown, path: string): unknown {
  let value = bundle
  for (const part of path.split(".")) {
    if (value === null || typeof value !== "object") return undefined
    value = (value as Record<string, unknown>)[part]
  }
  return value
}

function interpolationVariables(value: string): string[] {
  return [...value.matchAll(/{{\s*([A-Za-z_][\w]*)/g)]
    .map((match) => match[1])
    .sort()
}

describe("i18n bundle parity", () => {
  const i18nDir = dirname(fileURLToPath(import.meta.url))
  const enKeys = new Set(flattenKeys(en))
  const locales = Object.fromEntries(
    readdirSync(i18nDir)
      .filter((fileName) => fileName.endsWith(".json") && fileName !== "en.json")
      .map((fileName) => [
        fileName.slice(0, -".json".length),
        JSON.parse(readFileSync(join(i18nDir, fileName), "utf8")) as unknown,
      ]),
  )

  it("does not contain duplicate top-level JSON keys", () => {
    const findDuplicates = (fileName: string) => {
      const text = readFileSync(join(i18nDir, fileName), "utf8")
      const seen = new Set<string>()
      const duplicates = new Set<string>()
      for (const match of text.matchAll(/^  "([^"]+)":/gm)) {
        const key = match[1]
        if (seen.has(key)) duplicates.add(key)
        seen.add(key)
      }
      return [...duplicates].sort()
    }

    for (const locale of ["en", ...Object.keys(locales)]) {
      expect(
        findDuplicates(`${locale}.json`),
        `duplicate top-level keys in ${locale}.json`,
      ).toEqual([])
    }
  })

  it("every locale has exactly the English key set", () => {
    for (const [locale, bundle] of Object.entries(locales)) {
      const keys = new Set(flattenKeys(bundle))
      const missing = [...enKeys].filter((key) => !keys.has(key)).sort()
      const orphaned = [...keys].filter((key) => !enKeys.has(key)).sort()
      expect(missing, `${locale}.json is missing:\n  ${missing.join("\n  ")}`).toEqual([])
      expect(orphaned, `${locale}.json has orphaned keys:\n  ${orphaned.join("\n  ")}`).toEqual([])
    }
  })

  it("every leaf value is a non-empty string (no null / empty / placeholder slips)", () => {
    const check = (bundle: unknown, label: string) => {
      const keys = flattenKeys(bundle)
      for (const path of keys) {
        // Walk back to pull the value.
        let ref: unknown = bundle
        for (const part of path.split(".")) {
          ref = (ref as Record<string, unknown>)[part]
        }
        expect(typeof ref, `${label}: ${path} is not a string`).toBe("string")
        expect((ref as string).length, `${label}: ${path} is empty`).toBeGreaterThan(0)
      }
    }
    check(en, "en.json")
    for (const [locale, bundle] of Object.entries(locales)) check(bundle, `${locale}.json`)
  })

  it("translated strings preserve English interpolation variables", () => {
    for (const [locale, bundle] of Object.entries(locales)) {
      for (const path of enKeys) {
        const translated = valueAtPath(bundle, path)
        // Missing/non-string values are reported by the structural tests with
        // a clearer diagnostic; do not turn them into an unrelated TypeError.
        if (typeof translated !== "string") continue
        expect(
          interpolationVariables(translated),
          `${locale}.json changes interpolation variables for ${path}`,
        ).toEqual(interpolationVariables(valueAtPath(en, path) as string))
      }
    }
  })

  it("pluralization keys come in pairs: every foo_plural has a matching foo", () => {
    // i18next plural convention — a `foo_plural` without `foo` means
    // the singular form will fall back to the raw key at runtime.
    const check = (bundle: unknown, label: string) => {
      const keys = new Set(flattenKeys(bundle))
      for (const k of keys) {
        if (k.endsWith("_plural")) {
          const singular = k.slice(0, -"_plural".length)
          expect(
            keys.has(singular),
            `${label}: found ${k} but no matching ${singular} (i18next will fall back to the raw key for count=1)`,
          ).toBe(true)
        }
      }
    }
    check(en, "en.json")
    for (const [locale, bundle] of Object.entries(locales)) check(bundle, `${locale}.json`)
  })

  it("every literal translation key used by frontend code exists", () => {
    const srcDir = join(i18nDir, "..")
    const sourceFiles: string[] = []
    const visit = (directory: string) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name)
        if (entry.isDirectory()) visit(path)
        else if (/\.(?:ts|tsx)$/.test(entry.name) && !entry.name.endsWith(".test.ts")) {
          sourceFiles.push(path)
        }
      }
    }
    visit(srcDir)

    const missing = new Set<string>()
    // Dynamic keys such as `sidebar.typeLabels.${type}` cannot be proven
    // statically and remain covered by bundle parity plus their fallback.
    const literalKey = /(?:\bt|i18n\.t)\(\s*["']([^"']+)["']/g
    for (const file of sourceFiles) {
      const source = readFileSync(file, "utf8")
      for (const match of source.matchAll(literalKey)) {
        if (!enKeys.has(match[1])) missing.add(match[1])
      }
    }

    expect(
      [...missing].sort(),
      "Literal i18n keys used by frontend code but missing from the bundles",
    ).toEqual([])
  })
})

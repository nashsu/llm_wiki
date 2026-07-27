/**
 * Structural and runtime checks for the translation bundles.
 *
 * These checks fail on bundle contents before missing, malformed, or
 * incorrectly registered translations can surface as raw keys in the UI.
 */
import { describe, it, expect } from "vitest"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { readFileSync, readdirSync } from "node:fs"
import en from "./en.json"
import zh from "./zh.json"
import ko from "./ko.json"
import i18n from "./index"

/** Flattens a nested translation object to "a.b.c" dot-path keys. */
function flattenKeys(obj: unknown, prefix = ""): string[] {
  if (obj === null || typeof obj !== "object") return []
  const out: string[] = []
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${key}` : key
    if (value !== null && typeof value === "object") {
      out.push(...flattenKeys(value, path))
    } else {
      out.push(path)
    }
  }
  return out
}

/** Finds duplicate keys within each object, including nested objects. */
function findDuplicateJsonKeys(text: string): string[] {
  let cursor = 0
  const duplicates = new Set<string>()

  const skipWhitespace = () => {
    while (/\s/.test(text[cursor] ?? "")) cursor += 1
  }

  const parseString = () => {
    skipWhitespace()
    const start = cursor
    cursor += 1
    while (cursor < text.length) {
      if (text[cursor] === "\\") {
        cursor += 2
      } else if (text[cursor] === '"') {
        cursor += 1
        return JSON.parse(text.slice(start, cursor)) as string
      } else {
        cursor += 1
      }
    }
    throw new Error("Unterminated JSON string")
  }

  const parseValue = (path: string[]): void => {
    skipWhitespace()
    if (text[cursor] === "{") {
      parseObject(path)
      return
    }
    if (text[cursor] === "[") {
      cursor += 1
      skipWhitespace()
      let index = 0
      while (text[cursor] !== "]") {
        parseValue([...path, String(index)])
        index += 1
        skipWhitespace()
        if (text[cursor] === ",") {
          cursor += 1
          skipWhitespace()
        } else {
          break
        }
      }
      cursor += 1
      return
    }
    if (text[cursor] === '"') {
      parseString()
      return
    }
    while (cursor < text.length && !/[\s,\]}]/.test(text[cursor])) cursor += 1
  }

  const parseObject = (path: string[]): void => {
    cursor += 1
    skipWhitespace()
    const seen = new Set<string>()
    while (text[cursor] !== "}") {
      const key = parseString()
      const keyPath = [...path, key].join(".")
      if (seen.has(key)) duplicates.add(keyPath)
      seen.add(key)
      skipWhitespace()
      if (text[cursor] !== ":") throw new Error(`Expected colon after ${keyPath}`)
      cursor += 1
      parseValue([...path, key])
      skipWhitespace()
      if (text[cursor] === ",") {
        cursor += 1
        skipWhitespace()
      } else {
        break
      }
    }
    cursor += 1
  }

  parseValue([])
  return [...duplicates].sort()
}

function leafEntries(bundle: unknown) {
  return flattenKeys(bundle).map((path) => {
    let value = bundle
    for (const part of path.split(".")) {
      value = (value as Record<string, unknown>)[part]
    }
    return [path, value] as const
  })
}

function interpolationVariables(value: string): string[] {
  const variables: string[] = []
  for (let index = 0; index < value.length - 1; index += 1) {
    if (value.slice(index, index + 2) !== "{{") continue
    let end = index + 2
    while (/\s/.test(value[end] ?? "")) end += 1
    const start = end
    while (end < value.length && !/[\s,{}]/.test(value[end])) end += 1
    if (end > start) variables.push(value.slice(start, end))
  }
  return variables.sort()
}

function hasBalancedInterpolationBraces(value: string): boolean {
  let balance = 0
  for (let index = 0; index < value.length - 1; index += 1) {
    const pair = value.slice(index, index + 2)
    if (pair === "{{") {
      balance += 1
      index += 1
    } else if (pair === "}}") {
      balance -= 1
      index += 1
      if (balance < 0) return false
    }
  }
  return balance === 0
}

describe("i18n bundle parity (en.json, zh.json, ko.json)", () => {
  const i18nDir = dirname(fileURLToPath(import.meta.url))
  const enKeys = new Set(flattenKeys(en))
  const zhKeys = new Set(flattenKeys(zh))
  const koKeys = new Set(flattenKeys(ko))

  it("does not contain duplicate JSON keys at any object depth", () => {
    for (const fileName of ["en.json", "zh.json", "ko.json"]) {
      const text = readFileSync(join(i18nDir, fileName), "utf8")
      expect(findDuplicateJsonKeys(text), `duplicate keys in ${fileName}`).toEqual([])
    }
  })

  it("every en.json key is also in zh.json", () => {
    const missing = [...enKeys].filter((key) => !zhKeys.has(key)).sort()
    expect(
      missing,
      `Keys in en.json but missing from zh.json — add Chinese translations for:\n  ${missing.join("\n  ")}`,
    ).toEqual([])
  })

  it("every zh.json key is also in en.json (no orphaned zh-only strings)", () => {
    const orphaned = [...zhKeys].filter((key) => !enKeys.has(key)).sort()
    expect(
      orphaned,
      `Keys in zh.json but missing from en.json — either add English translations or remove the stale zh-only keys:\n  ${orphaned.join("\n  ")}`,
    ).toEqual([])
  })

  it("every en.json key is also in ko.json", () => {
    const missing = [...enKeys].filter((key) => !koKeys.has(key)).sort()
    expect(
      missing,
      `Keys in en.json but missing from ko.json — add Korean translations for:\n  ${missing.join("\n  ")}`,
    ).toEqual([])
  })

  it("every ko.json key is also in en.json (no orphaned ko-only strings)", () => {
    const orphaned = [...koKeys].filter((key) => !enKeys.has(key)).sort()
    expect(
      orphaned,
      `Keys in ko.json but missing from en.json — either add English translations or remove the stale ko-only keys:\n  ${orphaned.join("\n  ")}`,
    ).toEqual([])
  })

  it("every leaf value is a non-empty string (no null / empty / placeholder slips)", () => {
    const check = (bundle: unknown, label: string) => {
      for (const [path, value] of leafEntries(bundle)) {
        expect(typeof value, `${label}: ${path} is not a string`).toBe("string")
        expect((value as string).length, `${label}: ${path} is empty`).toBeGreaterThan(0)
      }
    }
    check(en, "en.json")
    check(zh, "zh.json")
    check(ko, "ko.json")
  })

  it("pluralization variants have a matching base key", () => {
    const check = (bundle: unknown, label: string) => {
      const keys = new Set(flattenKeys(bundle))
      for (const key of keys) {
        const suffix = key.match(/_(?:zero|one|two|few|many|other|plural)$/)?.[0]
        if (suffix) {
          const singular = key.slice(0, -suffix.length)
          expect(
            keys.has(singular),
            `${label}: found ${key} but no matching ${singular}`,
          ).toBe(true)
        }
      }
    }
    check(en, "en.json")
    check(zh, "zh.json")
    check(ko, "ko.json")
  })

  it("translations preserve interpolation variable names and counts", () => {
    const enValues = new Map(leafEntries(en))
    for (const [label, bundle] of [
      ["zh.json", zh],
      ["ko.json", ko],
    ] as const) {
      for (const [path, value] of leafEntries(bundle)) {
        if (typeof value !== "string" || !enValues.has(path)) continue
        expect(
          interpolationVariables(value),
          `${label}: ${path} must preserve the interpolation variables from en.json`,
        ).toEqual(interpolationVariables(enValues.get(path) as string))
      }
    }
  })

  it("every translation has balanced interpolation braces", () => {
    for (const [label, bundle] of [
      ["en.json", en],
      ["zh.json", zh],
      ["ko.json", ko],
    ] as const) {
      for (const [path, value] of leafEntries(bundle)) {
        if (typeof value !== "string") continue
        expect(
          hasBalancedInterpolationBraces(value),
          `${label}: ${path} has unbalanced interpolation braces`,
        ).toBe(true)
      }
    }
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

describe("i18next runtime resources", () => {
  it("switches among the registered English, Chinese, and Korean resources", async () => {
    for (const [language, expected] of [
      ["en", en.nav.chat],
      ["zh", zh.nav.chat],
      ["ko", ko.nav.chat],
    ] as const) {
      await i18n.changeLanguage(language)
      expect(i18n.resolvedLanguage).toBe(language)
      expect(i18n.t("nav.chat")).toBe(expected)
    }
  })
})

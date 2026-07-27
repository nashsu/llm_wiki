/**
 * Structural and runtime checks for the translation bundles.
 *
 * These checks fail on bundle contents before missing, malformed, or
 * incorrectly registered translations can surface as raw keys in the UI.
 */
import { afterEach, beforeEach, describe, it, expect } from "vitest"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { readFileSync, readdirSync } from "node:fs"
import en from "./en.json"
import zh from "./zh.json"
import ko from "./ko.json"
import i18n from "./index"
import { useWikiStore } from "@/stores/wiki-store"
import { getOutputLanguage } from "@/lib/output-language"

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
    if (value[end] === "-") {
      end += 1
      while (/\s/.test(value[end] ?? "")) end += 1
    }
    const start = end
    while (end < value.length && !/[\s,{}]/.test(value[end])) end += 1
    if (end > start) variables.push(value.slice(start, end))
  }
  return variables.sort()
}

function hasBalancedInterpolationBraces(value: string): boolean {
  const parseInterpolation = (start: number, nested: boolean): number | null => {
    if (value.startsWith("{{{", start)) return null
    let cursor = start + 2
    let literalBraceDepth = 0

    while (cursor < value.length) {
      if (value.startsWith("{{{", cursor)) return null
      if (value.startsWith("{{", cursor)) {
        const nestedEnd = parseInterpolation(cursor, true)
        if (nestedEnd === null) return null
        cursor = nestedEnd
        continue
      }
      if (value.startsWith("}}", cursor) && literalBraceDepth === 0) {
        const end = cursor + 2
        if (!nested && value[end] === "}") return null
        return end
      }

      if (value[cursor] === "{") {
        literalBraceDepth += 1
      } else if (value[cursor] === "}") {
        if (literalBraceDepth === 0) return null
        literalBraceDepth -= 1
      }
      cursor += 1
    }

    return null
  }

  let cursor = 0
  let literalBraceDepth = 0
  while (cursor < value.length) {
    if (value.startsWith("{{{", cursor)) return false
    if (value.startsWith("{{", cursor)) {
      const end = parseInterpolation(cursor, false)
      if (end === null) return false
      cursor = end
      continue
    }
    if (value.startsWith("}}", cursor)) {
      if (literalBraceDepth < 2) return false
      literalBraceDepth -= 2
      cursor += 2
      continue
    }

    if (value[cursor] === "{") {
      literalBraceDepth += 1
    } else if (value[cursor] === "}" && literalBraceDepth > 0) {
      literalBraceDepth -= 1
    }
    cursor += 1
  }
  return true
}

describe("i18n bundle parity (en.json, zh.json, ko.json)", () => {
  const i18nDir = dirname(fileURLToPath(import.meta.url))
  const enKeys = new Set(flattenKeys(en))
  const zhKeys = new Set(flattenKeys(zh))
  const koKeys = new Set(flattenKeys(ko))

  it("keeps every shipped bundle at exactly 956 string leaves", () => {
    expect(flattenKeys(en)).toHaveLength(956)
    expect(flattenKeys(zh)).toHaveLength(956)
    expect(flattenKeys(ko)).toHaveLength(956)
  })

  it("detects duplicate keys in nested objects and objects inside arrays", () => {
    expect(findDuplicateJsonKeys('{"outer":{"same":1,"same":2}}')).toEqual(["outer.same"])
    expect(findDuplicateJsonKeys('{"items":[{"same":1,"same":2}]}')).toEqual(["items.0.same"])
  })

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

  it("parses escaped and unescaped i18next interpolation variables", () => {
    expect(interpolationVariables("{{name}} / {{- html}} / {{name}}")).toEqual([
      "html",
      "name",
      "name",
    ])
  })

  it("accepts valid interpolation and rejects stray or triple braces", () => {
    expect(hasBalancedInterpolationBraces("Hello {{name}}")).toBe(true)
    expect(hasBalancedInterpolationBraces("Use a single { literal brace")).toBe(true)
    expect(hasBalancedInterpolationBraces("Use a single } literal brace")).toBe(true)
    expect(hasBalancedInterpolationBraces("JSON body: { resolved?, action? }")).toBe(true)
    expect(hasBalancedInterpolationBraces('JSON: {"outer":{"inner":1}}')).toBe(true)
    expect(hasBalancedInterpolationBraces("Hello }}")).toBe(false)
    expect(hasBalancedInterpolationBraces("Hello {{name}} then }}")).toBe(false)
    expect(
      hasBalancedInterpolationBraces(
        "{{running}} active{{queued, plural, =0 {} other {, {{queued}} queued}}}",
      ),
    ).toBe(true)
    expect(hasBalancedInterpolationBraces("Hello {{- html}}")).toBe(true)
    expect(hasBalancedInterpolationBraces("Hello {{name}}}")).toBe(false)
    expect(hasBalancedInterpolationBraces("Hello {{{name}}}")).toBe(false)
    expect(hasBalancedInterpolationBraces("Hello {{name")).toBe(false)
    expect(hasBalancedInterpolationBraces("Hello {{name}")).toBe(false)
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

  it("preserves approved Korean UI terminology and technical literals", () => {
    expect(ko.sidebar.rawSources).toBe("원본 자료")
    expect(ko.sources.title).toBe("원본 자료")
    expect(ko.chat.retrievalModes.faithful).toBe("원본 자료만")
    expect(ko.chat.retrievalModeHint).toContain("원본 자료")

    expect(ko.nav.review).toBe("검토")
    expect(ko.review.title).toBe("검토")
    for (const translation of [
      ko.chat.selectionEdit.reviewHint,
      ko.research.emptyHint,
      ko.lint.sendSelectedToReview,
      ko.review.refreshHint,
      ko.review.allClear,
      ko.settings.sections.apiServer.endpointReviewsNote,
      ko.settings.sections.apiServer.endpointPatchReviewNote,
      ko.settings.sections.apiServer.endpointBulkResolveNote,
    ]) {
      expect(translation).toContain("검토")
    }

    expect(ko.nav.lint).toBe("위키 점검")
    expect(ko.lint.title).toBe("위키 점검")
    for (const translation of [
      ko.lint.runLint,
      ko.lint.runLintHint,
      ko.settings.sections.output.aiLanguageHint,
    ]) {
      expect(translation).toContain("위키 점검")
    }

    for (const translation of [
      ko.sidebar.noWikiPages,
      ko.sources.import,
      ko.sources.importHint,
      ko.sources.importing,
      ko.sources.importFiles,
      ko.sources.importSourceFiles,
      ko.sources.importSourceFolder,
      ko.sources.urlImport.title,
      ko.sources.urlImport.submit,
      ko.sources.urlImport.imported,
      ko.settings.categories.scheduledImport,
      ko.settings.sections.scheduledImport.title,
      ko.settings.sections.scheduledImport.description,
      ko.settings.sections.scheduledImport.enable,
      ko.settings.sections.maintenance.projectData.import,
      ko.settings.sections.maintenance.projectData.imported,
      ko.graph.importSourcesHint,
    ]) {
      expect(translation).toContain("가져")
    }

    for (const translation of [
      ko.sources.urlImport.description,
      ko.sources.refreshFolderTooltip,
      ko.sources.ingest,
      ko.chat.emptyHint,
      ko.settings.sections.llm.taskRouting.ingest,
      ko.settings.sections.llm.taskRouting.hint,
      ko.settings.sections.llm.projectOverride.hint,
      ko.settings.sections.llm.codexCliTimeoutHint,
      ko.settings.sections.llm.reasoning.hint,
      ko.settings.sections.multimodal.description,
      ko.settings.sections.multimodal.enableLabel,
      ko.settings.sections.multimodal.enableHint,
      ko.settings.sections.multimodal.modelHint,
      ko.settings.sections.multimodal.costPoint4,
      ko.settings.sections.sourceWatch.description,
      ko.settings.sections.sourceWatch.autoIngest,
      ko.settings.sections.sourceWatch.autoIngestDescription,
      ko.settings.sections.sourceWatch.maxSize,
      ko.settings.sections.scheduledImport.privacyNotice,
      ko.settings.sections.maintenance.description,
      ko.activity.ingestQueue,
      ko.activity.ingestQueuePaused,
      ko.activity.pauseQueueTitle,
      ko.activity.resumeQueueTitle,
      ko.activity.cancelAllConfirm,
      ko.activity.retryFailedTitle,
    ]) {
      expect(translation).toMatch(/위키(?:에)?\s*반영/)
    }

    expect(ko.chat.emptyHint).toBe("질문하거나 자료를 위키에 반영해 보세요.")
    expect(ko.settings.sections.multimodal.costPoint4).toContain(
      "여러 문서를 위키에 반영할 때",
    )
    expect(ko.settings.sections.sourceWatch.description).toContain(
      "자동으로 위키에 반영할 파일",
    )
    expect(ko.settings.sections.maintenance.description).toContain("위키에 반영")

    expect(ko.settings.sections.llm.taskRouting.ingest).toBe("위키 반영 모델")
    expect(ko.activity.ingestQueue).toBe("위키 반영 대기열")
    expect(ko.lint.addCrossRefsDescription).toContain("[[wikilinks]]")
    expect(ko.settings.sections.llm.customHeadersHint).toContain("Header-Name: value")
    expect(ko.settings.sections.llm.customHeadersHint).not.toContain("`Header-Name: value`")
  })
})

describe("i18next runtime resources", () => {
  let originalLanguage: string
  let originalOutputLanguage: ReturnType<typeof useWikiStore.getState>["outputLanguage"]

  beforeEach(() => {
    originalLanguage = i18n.language
    originalOutputLanguage = useWikiStore.getState().outputLanguage
  })

  afterEach(async () => {
    useWikiStore.getState().setOutputLanguage(originalOutputLanguage)
    await i18n.changeLanguage(originalLanguage)
  })

  it("switches UI resources without changing AI output language", async () => {
    useWikiStore.getState().setOutputLanguage("Japanese")
    const effectiveOutputLanguage = getOutputLanguage("English source")

    for (const [language, expected] of [
      ["en", en.nav.chat],
      ["zh", zh.nav.chat],
      ["ko", ko.nav.chat],
    ] as const) {
      await i18n.changeLanguage(language)
      expect(i18n.resolvedLanguage).toBe(language)
      expect(i18n.t("nav.chat")).toBe(expected)
      expect(useWikiStore.getState().outputLanguage).toBe("Japanese")
      expect(getOutputLanguage("English source")).toBe(effectiveOutputLanguage)
    }
  })
})

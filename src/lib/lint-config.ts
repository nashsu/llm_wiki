import { fileExists, readFile, writeFileAtomic } from "@/commands/fs"
import { normalizePath } from "@/lib/path-utils"

export interface LintConfig {
  ignoreOrphan: boolean
  ignoreNoOutlinks: boolean
  ignorePages: string[]
  /** Persist the UI "semantic" toggle so the scheduled runner can honor it. */
  includeSemantic: boolean
  scheduleEnabled: boolean
  /** Weekdays to run on, 0 = Sunday … 6 = Saturday. Empty disables the schedule. */
  scheduleWeekdays: number[]
  scheduleHour: number
  scheduleMinute: number
  lastScheduledRun: number | null
}

export const DEFAULT_LINT_CONFIG: LintConfig = {
  ignoreOrphan: false,
  ignoreNoOutlinks: false,
  ignorePages: [],
  includeSemantic: false,
  scheduleEnabled: false,
  scheduleWeekdays: [],
  scheduleHour: 0,
  scheduleMinute: 0,
  lastScheduledRun: null,
}

function clampInt(min: number, max: number, value: number | undefined, fallback: number): number {
  const n = Math.floor(value ?? fallback)
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback
}

export function normalizeLintConfig(config?: Partial<LintConfig> | null): LintConfig {
  const scheduleWeekdays = [
    ...new Set(
      (config?.scheduleWeekdays ?? [])
        .map((value) => Number(value))
        .filter((value) => Number.isInteger(value) && value >= 0 && value <= 6),
    ),
  ]
  const lastScheduledRun =
    typeof config?.lastScheduledRun === "number" && Number.isFinite(config.lastScheduledRun)
      ? config.lastScheduledRun
      : null
  return {
    ignoreOrphan: config?.ignoreOrphan === true,
    ignoreNoOutlinks: config?.ignoreNoOutlinks === true,
    ignorePages: [...new Set((config?.ignorePages ?? [])
      .flatMap((value) => value.split(/[,，\n]/))
      .map((value) => value.trim())
      .filter(Boolean))],
    includeSemantic: config?.includeSemantic === true,
    scheduleEnabled: config?.scheduleEnabled === true,
    scheduleWeekdays,
    scheduleHour: clampInt(0, 23, config?.scheduleHour, DEFAULT_LINT_CONFIG.scheduleHour),
    scheduleMinute: clampInt(0, 59, config?.scheduleMinute, DEFAULT_LINT_CONFIG.scheduleMinute),
    lastScheduledRun,
  }
}

function lintConfigPath(projectPath: string): string {
  return `${normalizePath(projectPath)}/.llm-wiki/lint-config.json`
}

export async function loadLintConfig(projectPath: string): Promise<LintConfig> {
  const path = lintConfigPath(projectPath)
  try {
    if (!(await fileExists(path))) return DEFAULT_LINT_CONFIG
    return normalizeLintConfig(JSON.parse(await readFile(path)) as Partial<LintConfig>)
  } catch (error) {
    console.warn("[lint] failed to load lint config:", error)
    return DEFAULT_LINT_CONFIG
  }
}

export async function saveLintConfig(
  projectPath: string,
  config: LintConfig,
): Promise<LintConfig> {
  const normalized = normalizeLintConfig(config)
  await writeFileAtomic(lintConfigPath(projectPath), JSON.stringify(normalized, null, 2))
  return normalized
}


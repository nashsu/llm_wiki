import { fileExists, readFile, writeFileAtomic } from "@/commands/fs"
import { normalizePath } from "@/lib/path-utils"

export interface LintConfig {
  ignoreOrphan: boolean
  ignoreNoOutlinks: boolean
  ignorePages: string[]
}

export const DEFAULT_LINT_CONFIG: LintConfig = {
  ignoreOrphan: false,
  ignoreNoOutlinks: false,
  ignorePages: [],
}

export function normalizeLintConfig(config?: Partial<LintConfig> | null): LintConfig {
  return {
    ignoreOrphan: config?.ignoreOrphan === true,
    ignoreNoOutlinks: config?.ignoreNoOutlinks === true,
    ignorePages: [...new Set((config?.ignorePages ?? [])
      .flatMap((value) => value.split(/[,，\n]/))
      .map((value) => value.trim())
      .filter(Boolean))],
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


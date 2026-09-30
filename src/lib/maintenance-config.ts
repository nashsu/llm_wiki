import { fileExists, readFile, writeFileAtomic } from "@/commands/fs"
import { normalizePath } from "@/lib/path-utils"

export interface MaintenanceConfig {
  indexScheduleEnabled: boolean
  indexScheduleIntervalMinutes: number
  lastScheduledIndexRun: number | null
}

export const DEFAULT_MAINTENANCE_CONFIG: MaintenanceConfig = {
  indexScheduleEnabled: false,
  indexScheduleIntervalMinutes: 1440,
  lastScheduledIndexRun: null,
}

export function normalizeMaintenanceConfig(
  config?: Partial<MaintenanceConfig> | null,
): MaintenanceConfig {
  const indexScheduleIntervalMinutes = Math.max(
    1,
    Math.min(
      1440,
      Math.floor(
        config?.indexScheduleIntervalMinutes ?? DEFAULT_MAINTENANCE_CONFIG.indexScheduleIntervalMinutes,
      ),
    ),
  )
  const lastScheduledIndexRun =
    typeof config?.lastScheduledIndexRun === "number" && Number.isFinite(config.lastScheduledIndexRun)
      ? config.lastScheduledIndexRun
      : null
  return {
    indexScheduleEnabled: config?.indexScheduleEnabled === true,
    indexScheduleIntervalMinutes,
    lastScheduledIndexRun,
  }
}

function maintenanceConfigPath(projectPath: string): string {
  return `${normalizePath(projectPath)}/.llm-wiki/maintenance-config.json`
}

export async function loadMaintenanceConfig(projectPath: string): Promise<MaintenanceConfig> {
  const path = maintenanceConfigPath(projectPath)
  try {
    if (!(await fileExists(path))) return DEFAULT_MAINTENANCE_CONFIG
    return normalizeMaintenanceConfig(
      JSON.parse(await readFile(path)) as Partial<MaintenanceConfig>,
    )
  } catch (error) {
    console.warn("[maintenance] failed to load maintenance config:", error)
    return DEFAULT_MAINTENANCE_CONFIG
  }
}

export async function saveMaintenanceConfig(
  projectPath: string,
  config: MaintenanceConfig,
): Promise<MaintenanceConfig> {
  const normalized = normalizeMaintenanceConfig(config)
  await writeFileAtomic(maintenanceConfigPath(projectPath), JSON.stringify(normalized, null, 2))
  return normalized
}

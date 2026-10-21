import type { WikiProject } from "@/types/wiki"
import { useWikiStore } from "@/stores/wiki-store"
import {
  loadMaintenanceConfig,
  saveMaintenanceConfig,
  normalizeMaintenanceConfig,
  type MaintenanceConfig,
} from "@/lib/maintenance-config"
import { rebuildIndexForProject } from "@/lib/rebuild-index"

let scanTimer: ReturnType<typeof setInterval> | null = null
let activeRunId = 0
let rebuilding = false

/** True once the configured interval has elapsed since the last scheduled run. */
export function isScheduledIndexDue(config: MaintenanceConfig, now = Date.now()): boolean {
  if (!config.indexScheduleEnabled || config.indexScheduleIntervalMinutes <= 0) return false
  if (config.lastScheduledIndexRun == null) return true
  const intervalMs =
    Math.max(1, Math.min(1440, Math.floor(config.indexScheduleIntervalMinutes))) * 60 * 1000
  return now - config.lastScheduledIndexRun >= intervalMs
}

async function sweep(project: WikiProject, runId: number): Promise<void> {
  if (runId !== activeRunId) return
  if (project.id !== useWikiStore.getState().project?.id) return

  let config: MaintenanceConfig
  try {
    config = normalizeMaintenanceConfig(await loadMaintenanceConfig(project.path))
  } catch {
    return
  }

  if (runId !== activeRunId) return
  if (project.id !== useWikiStore.getState().project?.id) return
  if (!config.indexScheduleEnabled) return
  if (!isScheduledIndexDue(config)) return
  if (rebuilding) return

  rebuilding = true
  try {
    await rebuildIndexForProject(project.path)
    if (runId !== activeRunId) return
    if (project.id !== useWikiStore.getState().project?.id) return
    await saveMaintenanceConfig(project.path, { ...config, lastScheduledIndexRun: Date.now() })
  } catch (err) {
    console.error("[scheduled-index] sweep failed:", err)
  } finally {
    rebuilding = false
  }
}

export function startScheduledIndex(project: WikiProject): void {
  stopScheduledIndex()
  const runId = ++activeRunId
  void sweep(project, runId).catch((err) =>
    console.error("[scheduled-index] initial sweep failed:", err),
  )
  scanTimer = setInterval(() => {
    void sweep(project, runId).catch((err) =>
      console.error("[scheduled-index] sweep failed:", err),
    )
  }, 60 * 1000)
}

export function stopScheduledIndex(): void {
  activeRunId += 1
  if (scanTimer) {
    clearInterval(scanTimer)
    scanTimer = null
  }
}

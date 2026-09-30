import type { WikiProject } from "@/types/wiki"
import { useWikiStore } from "@/stores/wiki-store"
import {
  loadLintConfig,
  saveLintConfig,
  normalizeLintConfig,
  type LintConfig,
} from "@/lib/lint-config"
import { runProjectLint } from "@/lib/lint"

// Scheduled lint runs at fixed weekly occurrences (selected weekdays at a
// fixed time), not on a repeating interval. Unlike the interval scheduler this
// arms a single setTimeout for the exact next occurrence. The lint view
// restarts the scheduler on save so enable/disable/edits take effect at once.

let runTimer: ReturnType<typeof setTimeout> | null = null
let activeRunId = 0
let sweeping = false

/** Earliest datetime on a selected weekday at scheduleHour:scheduleMinute that
 *  is strictly after `afterMs` (used as the next-run anchor). */
function nextScheduledTime(config: LintConfig, afterMs: number): number {
  const days = config.scheduleWeekdays.length > 0
    ? config.scheduleWeekdays
    : [new Date(afterMs).getDay()]
  const after = new Date(afterMs)
  for (let offset = 1; offset <= 7; offset += 1) {
    const day = new Date(after)
    day.setDate(after.getDate() + offset)
    if (days.includes(day.getDay())) {
      const candidate = new Date(day)
      candidate.setHours(config.scheduleHour, config.scheduleMinute, 0, 0)
      if (candidate.getTime() > afterMs) return candidate.getTime()
    }
  }
  // Fallback — 8 days out (the nearest selected weekday), avoids a stale anchor.
  const fallback = new Date(after)
  fallback.setDate(after.getDate() + 8)
  fallback.setHours(config.scheduleHour, config.scheduleMinute, 0, 0)
  return fallback.getTime()
}

async function scheduleNext(project: WikiProject, runId: number): Promise<void> {
  if (runId !== activeRunId) return
  if (project.id !== useWikiStore.getState().project?.id) return

  let config: LintConfig
  try {
    config = normalizeLintConfig(await loadLintConfig(project.path))
  } catch {
    return
  }
  if (runId !== activeRunId) return
  if (project.id !== useWikiStore.getState().project?.id) return
  if (!config.scheduleEnabled || config.scheduleWeekdays.length === 0) {
    if (runTimer) {
      clearTimeout(runTimer)
      runTimer = null
    }
    return
  }

  const anchor = config.lastScheduledRun ?? Date.now()
  const next = nextScheduledTime(config, anchor)
  const delay = Math.max(1, next - Date.now())
  if (runTimer) clearTimeout(runTimer)
  runTimer = setTimeout(() => {
    void executeAndReschedule(project, runId)
  }, delay)
}

async function executeAndReschedule(project: WikiProject, runId: number): Promise<void> {
  if (runId !== activeRunId) return
  if (project.id !== useWikiStore.getState().project?.id) return

  let config: LintConfig
  try {
    config = normalizeLintConfig(await loadLintConfig(project.path))
  } catch {
    return
  }
  if (runId !== activeRunId) return
  if (project.id !== useWikiStore.getState().project?.id) return
  if (!config.scheduleEnabled || config.scheduleWeekdays.length === 0) {
    void scheduleNext(project, runId)
    return
  }
  if (sweeping) return

  sweeping = true
  try {
    const results = await runProjectLint(project, config)
    // Only advance the checkpoint when a run actually happened (not skipped as
    // in-flight). This prevents a dodged run from suppressing the next one.
    if (results !== null) {
      if (runId !== activeRunId) return
      if (project.id !== useWikiStore.getState().project?.id) return
      await saveLintConfig(project.path, { ...config, lastScheduledRun: Date.now() })
    }
  } catch (err) {
    console.error("[scheduled-lint] run failed:", err)
  } finally {
    sweeping = false
  }
  if (runId === activeRunId) {
    void scheduleNext(project, runId)
  }
}

export function startScheduledLint(project: WikiProject): void {
  stopScheduledLint()
  const runId = ++activeRunId
  void scheduleNext(project, runId).catch((err) =>
    console.error("[scheduled-lint] start failed:", err),
  )
}

export function stopScheduledLint(): void {
  activeRunId += 1
  if (runTimer) {
    clearTimeout(runTimer)
    runTimer = null
  }
}

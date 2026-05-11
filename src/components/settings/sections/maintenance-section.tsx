import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import {
  Wrench,
  Loader2,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  Trash2,
  RotateCcw,
  Clock,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { useWikiStore } from "@/stores/wiki-store"
import { hasUsableLlm } from "@/lib/has-usable-llm"
import { runDuplicateDetection } from "@/lib/dedup-runner"
import { addNotDuplicate } from "@/lib/dedup-storage"
import {
  enqueueMerge,
  cancelTask,
  retryTask,
  getQueue,
  groupKey,
  type DedupTask,
} from "@/lib/dedup-queue"
import type { DuplicateGroup } from "@/lib/dedup"

interface GroupUiEntry {
  group: DuplicateGroup
  canonicalSlug: string
  /** Becomes true when the user marks the group as "not duplicates"
   *  in this session — the card transitions to skipped state. */
  skipped: boolean
}

/** Match a card to its task in the queue (if any) by slug-set. */
function findTaskForGroup(
  tasks: readonly DedupTask[],
  slugs: readonly string[],
): DedupTask | undefined {
  const key = groupKey(slugs)
  return tasks.find((t) => groupKey(t.group.slugs) === key)
}

export function MaintenanceSection() {
  const { t } = useTranslation()
  const llmConfig = useWikiStore((s) => s.llmConfig)
  const project = useWikiStore((s) => s.project)

  const [scanning, setScanning] = useState(false)
  const [scanError, setScanError] = useState<string | null>(null)
  const [groups, setGroups] = useState<GroupUiEntry[]>([])
  const [scanCompleted, setScanCompleted] = useState(false)

  // Poll the queue at 1Hz so the UI reflects pending → processing →
  // failed transitions and cross-window queue activity (e.g. a merge
  // that completed while the user was on a different settings tab).
  // Same pattern activity-panel uses for ingest-queue.
  const [tasks, setTasks] = useState<readonly DedupTask[]>([])
  const lastSeenTaskKeysRef = useRef<Set<string>>(new Set())
  const cancelledTaskKeysRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    setTasks([...getQueue()])
    const id = setInterval(() => setTasks([...getQueue()]), 1000)
    return () => clearInterval(id)
  }, [])

  const llmReady = hasUsableLlm(llmConfig)
  const projectReady = !!project

  const handleScan = useCallback(async () => {
    if (!project) return
    setScanning(true)
    setScanError(null)
    setGroups([])
    setScanCompleted(false)
    try {
      const detected = await runDuplicateDetection(project.path, llmConfig)
      setGroups(
        detected.map((g) => ({
          group: g,
          canonicalSlug: g.slugs[0],
          skipped: false,
        })),
      )
      setScanCompleted(true)
    } catch (err) {
      setScanError(err instanceof Error ? err.message : String(err))
    } finally {
      setScanning(false)
    }
  }, [project, llmConfig])

  const handleCanonicalChange = useCallback(
    (idx: number, slug: string) => {
      setGroups((prev) =>
        prev.map((g, i) => (i === idx ? { ...g, canonicalSlug: slug } : g)),
      )
    },
    [],
  )

  const handleEnqueue = useCallback(
    async (entry: GroupUiEntry) => {
      if (!project) return
      try {
        cancelledTaskKeysRef.current.delete(groupKey(entry.group.slugs))
        await enqueueMerge(project.id, entry.group, entry.canonicalSlug)
        // Refresh immediately so the card flips to "queued" without
        // waiting for the next 1s poll tick.
        setTasks([...getQueue()])
      } catch (err) {
        console.error("[Maintenance] enqueue failed:", err)
      }
    },
    [project],
  )

  const handleCancel = useCallback(async (taskId: string) => {
    const task = getQueue().find((t) => t.id === taskId)
    if (task) {
      cancelledTaskKeysRef.current.add(groupKey(task.group.slugs))
    }
    await cancelTask(taskId)
    setTasks([...getQueue()])
  }, [])

  const handleRetry = useCallback(async (taskId: string) => {
    await retryTask(taskId)
    setTasks([...getQueue()])
  }, [])

  const handleNotDuplicate = useCallback(
    async (idx: number) => {
      if (!project) return
      const entry = groups[idx]
      if (!entry) return
      try {
        await addNotDuplicate(project.path, entry.group.slugs)
        setGroups((prev) =>
          prev.map((g, i) => (i === idx ? { ...g, skipped: true } : g)),
        )
      } catch (err) {
        console.error("[Maintenance] addNotDuplicate failed:", err)
      }
    },
    [project, groups],
  )

  // Queue state drives each card:
  // - pending / processing / failed stay visible with their task status.
  // - explicitly cancelled tasks stay in the current scan result.
  // - tasks that vanish without a cancel were completed successfully,
  //   so remove their candidate group from the current scan result.
  useEffect(() => {
    const currentKeys = new Set(tasks.map((t) => groupKey(t.group.slugs)))
    const completedKeys = new Set<string>()

    for (const key of lastSeenTaskKeysRef.current) {
      if (currentKeys.has(key)) continue
      if (cancelledTaskKeysRef.current.has(key)) {
        cancelledTaskKeysRef.current.delete(key)
      } else {
        completedKeys.add(key)
      }
    }

    lastSeenTaskKeysRef.current = currentKeys
    if (completedKeys.size > 0) {
      setGroups((prev) =>
        prev.filter((g) => !completedKeys.has(groupKey(g.group.slugs))),
      )
    }
  }, [tasks])

  // Pending position helper: "queued (N ahead)" — count pending tasks
  // before this one in arrival order.
  const pendingPositionByTaskId = useMemo(() => {
    const positions = new Map<string, number>()
    let position = 0
    for (const t of tasks) {
      if (t.status === "pending") {
        positions.set(t.id, position)
        position++
      }
    }
    return positions
  }, [tasks])

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold">
          {t("settings.sections.maintenance.title", { defaultValue: "Maintenance" })}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("settings.sections.maintenance.description", {
            defaultValue:
              "Tools for cleaning up the wiki — detect and merge duplicate entities/concepts that the LLM created under different names across re-ingests.",
          })}
        </p>
      </div>

      <div className="space-y-3 rounded-lg border border-border/60 bg-muted/20 p-4">
        <div className="flex items-center gap-2">
          <Wrench className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-sm font-semibold">
            {t("settings.sections.maintenance.dedup.title", {
              defaultValue: "Detect duplicate entities / concepts",
            })}
          </h3>
        </div>
        <p className="text-xs leading-relaxed text-muted-foreground">
          {t("settings.sections.maintenance.dedup.description", {
            defaultValue:
              "Asks the LLM to scan all entity / concept pages and group ones that likely refer to the same topic under different names (English vs Chinese, plural vs singular, abbreviation vs full form). You confirm each group before merging. Merges are queued and run one at a time so cross-references stay consistent.",
          })}
        </p>

        {!projectReady && (
          <p className="text-xs text-amber-700 dark:text-amber-400">
            {t("settings.sections.maintenance.noProject", {
              defaultValue: "Open a project first.",
            })}
          </p>
        )}
        {projectReady && !llmReady && (
          <p className="text-xs text-amber-700 dark:text-amber-400">
            {t("settings.sections.maintenance.noLlm", {
              defaultValue: "Configure an LLM provider first.",
            })}
          </p>
        )}

        <Button
          onClick={() => void handleScan()}
          disabled={scanning || !projectReady || !llmReady}
        >
          {scanning ? (
            <>
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              {t("settings.sections.maintenance.dedup.scanning", {
                defaultValue: "Scanning…",
              })}
            </>
          ) : (
            t("settings.sections.maintenance.dedup.scanButton", {
              defaultValue: "Scan for duplicates",
            })
          )}
        </Button>

        {scanError && (
          <div className="flex items-start gap-1.5 rounded border border-rose-500/40 bg-rose-500/5 px-2 py-1.5 text-xs text-rose-700 dark:text-rose-400">
            <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <div>{scanError}</div>
          </div>
        )}

        {scanCompleted && groups.length === 0 && !scanError && (
          <div className="flex items-start gap-1.5 rounded border border-emerald-500/40 bg-emerald-500/5 px-2 py-1.5 text-xs text-emerald-700 dark:text-emerald-400">
            <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <div>
              {t("settings.sections.maintenance.dedup.noneFound", {
                defaultValue: "No duplicate groups found. The wiki is clean.",
              })}
            </div>
          </div>
        )}
      </div>

      <QueueOrphanList
        tasks={tasks}
        groups={groups}
        onCancel={(id) => void handleCancel(id)}
        onRetry={(id) => void handleRetry(id)}
        pendingPositionByTaskId={pendingPositionByTaskId}
      />

      {groups.map((entry, idx) => {
        const task = findTaskForGroup(tasks, entry.group.slugs)
        return (
          <DuplicateGroupCard
            key={entry.group.slugs.join(",")}
            entry={entry}
            task={task}
            pendingPosition={
              task && task.status === "pending"
                ? pendingPositionByTaskId.get(task.id) ?? 0
                : 0
            }
            onCanonicalChange={(slug) => handleCanonicalChange(idx, slug)}
            onEnqueue={() => void handleEnqueue(entry)}
            onCancel={() => task && void handleCancel(task.id)}
            onRetry={() => task && void handleRetry(task.id)}
            onNotDuplicate={() => void handleNotDuplicate(idx)}
          />
        )
      })}
    </div>
  )
}

// --- helpers ---------------------------------------------------------------

interface QueueOrphanListProps {
  tasks: readonly DedupTask[]
  groups: GroupUiEntry[]
  onCancel: (taskId: string) => void
  onRetry: (taskId: string) => void
  pendingPositionByTaskId: Map<string, number>
}

/**
 * Render queued tasks that don't have a matching card on screen. This
 * happens after the user closes the Maintenance pane and re-opens it,
 * or after an app restart with pending tasks: those tasks are real
 * but the user hasn't re-scanned, so without this list they'd be
 * invisible.
 */
function QueueOrphanList({
  tasks,
  groups,
  onCancel,
  onRetry,
  pendingPositionByTaskId,
}: QueueOrphanListProps) {
  const { t } = useTranslation()
  const groupKeys = new Set(groups.map((g) => groupKey(g.group.slugs)))
  const orphans = tasks.filter((t) => !groupKeys.has(groupKey(t.group.slugs)))

  if (orphans.length === 0) return null

  return (
    <div className="space-y-2 rounded-lg border border-border/60 bg-muted/10 p-4">
      <div className="flex items-center gap-2">
        <Clock className="h-4 w-4 text-muted-foreground" />
        <h3 className="text-sm font-semibold">
          {t("settings.sections.maintenance.dedup.queueTitle", {
            defaultValue: "In-progress merges",
          })}
        </h3>
      </div>
      <p className="text-xs text-muted-foreground">
        {t("settings.sections.maintenance.dedup.queueDescription", {
          defaultValue:
            "Tasks queued from a previous scan that haven't finished yet. Merges run one at a time.",
        })}
      </p>
      {orphans.map((task) => (
        <div
          key={task.id}
          className="flex flex-wrap items-center gap-2 rounded border border-border/40 bg-background px-3 py-2 text-xs"
        >
          <code className="font-mono">{task.group.slugs.join(" + ")}</code>
          <span className="text-muted-foreground">
            →{" "}
            <code className="font-mono">{task.canonicalSlug}</code>
          </span>
          <span className="ml-auto inline-flex items-center gap-1">
            <TaskStatusChip
              task={task}
              pendingPosition={pendingPositionByTaskId.get(task.id) ?? 0}
            />
            {task.status === "failed" && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => onRetry(task.id)}
              >
                <RotateCcw className="h-3.5 w-3.5" />
                {t("settings.sections.maintenance.dedup.retry", {
                  defaultValue: "Retry",
                })}
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={() => onCancel(task.id)}>
              <Trash2 className="h-3.5 w-3.5" />
              {t("settings.sections.maintenance.dedup.delete", {
                defaultValue: "Delete",
              })}
            </Button>
          </span>
          {task.error && task.status === "failed" && (
            <div className="basis-full rounded border border-rose-500/40 bg-rose-500/5 px-2 py-1 text-rose-700 dark:text-rose-400">
              {task.error}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

interface ChipProps {
  task: DedupTask
  pendingPosition: number
}

function TaskStatusChip({ task, pendingPosition }: ChipProps) {
  const { t } = useTranslation()
  if (task.status === "processing") {
    return (
      <span className="inline-flex items-center gap-1 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-amber-700 dark:text-amber-400">
        <Loader2 className="h-3 w-3 animate-spin" />
        {t("settings.sections.maintenance.dedup.merging", {
          defaultValue: "Merging…",
        })}
      </span>
    )
  }
  if (task.status === "pending") {
    if (pendingPosition === 0) {
      return (
        <span className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[10px] font-semibold uppercase text-muted-foreground">
          {t("settings.sections.maintenance.dedup.queued", {
            defaultValue: "Queued",
          })}
        </span>
      )
    }
    return (
      <span className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[10px] font-semibold uppercase text-muted-foreground">
        {t("settings.sections.maintenance.dedup.queuedAhead", {
          defaultValue: "Queued ({{n}} ahead)",
          n: pendingPosition,
        })}
      </span>
    )
  }
  if (task.status === "failed") {
    return (
      <span className="inline-flex items-center gap-1 rounded bg-rose-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-rose-700 dark:text-rose-400">
        <AlertTriangle className="h-3 w-3" />
        {t("settings.sections.maintenance.dedup.failed", {
          defaultValue: "Failed ({{retries}}/3)",
          retries: task.retryCount,
        })}
      </span>
    )
  }
  return null
}

interface CardProps {
  entry: GroupUiEntry
  task: DedupTask | undefined
  pendingPosition: number
  onCanonicalChange: (slug: string) => void
  onEnqueue: () => void
  onCancel: () => void
  onRetry: () => void
  onNotDuplicate: () => void
}

function DuplicateGroupCard({
  entry,
  task,
  pendingPosition,
  onCanonicalChange,
  onEnqueue,
  onCancel,
  onRetry,
  onNotDuplicate,
}: CardProps) {
  const { t } = useTranslation()
  const { group, canonicalSlug, skipped } = entry

  const inFlight = !!task && (task.status === "pending" || task.status === "processing")
  const failed = !!task && task.status === "failed"
  const finished = skipped

  const confidenceClass =
    group.confidence === "high"
      ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400"
      : group.confidence === "medium"
        ? "bg-amber-500/15 text-amber-700 dark:text-amber-400"
        : "bg-muted text-muted-foreground"

  return (
    <div
      className={`space-y-3 rounded-lg border px-4 py-3 ${
        finished ? "border-border/40 bg-muted/10 opacity-60" : "border-border bg-background"
      }`}
    >
      <div className="flex items-center gap-2">
        <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${confidenceClass}`}>
          {group.confidence}
        </span>
        <span className="text-xs text-muted-foreground">
          {t("settings.sections.maintenance.dedup.candidates", {
            defaultValue: "{{n}} candidates",
            n: group.slugs.length,
          })}
        </span>
        {skipped && (
          <span className="ml-auto inline-flex items-center gap-1 text-xs text-muted-foreground">
            {t("settings.sections.maintenance.dedup.skipped", { defaultValue: "Marked not duplicates" })}
          </span>
        )}
        {task && !finished && (
          <span className="ml-auto">
            <TaskStatusChip task={task} pendingPosition={pendingPosition} />
          </span>
        )}
      </div>

      {group.reason && (
        <div className="text-xs italic leading-relaxed text-muted-foreground">{group.reason}</div>
      )}

      {!finished && (
        <>
          <div className="space-y-1.5">
            <Label className="text-xs">
              {t("settings.sections.maintenance.dedup.canonicalLabel", {
                defaultValue: "Keep this slug as canonical:",
              })}
            </Label>
            {group.slugs.map((slug) => (
              <label
                key={slug}
                className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-sm hover:bg-accent"
              >
                <input
                  type="radio"
                  name={`canonical-${group.slugs.join(",")}`}
                  checked={canonicalSlug === slug}
                  onChange={() => onCanonicalChange(slug)}
                  disabled={inFlight}
                />
                <code className="font-mono text-xs">{slug}</code>
              </label>
            ))}
          </div>

          <div className="flex flex-wrap gap-2">
            {!task && (
              <>
                <Button size="sm" onClick={onEnqueue}>
                  {t("settings.sections.maintenance.dedup.mergeButton", {
                    defaultValue: "Merge into {{slug}}",
                    slug: canonicalSlug,
                  })}
                </Button>
                <Button size="sm" variant="ghost" onClick={onNotDuplicate}>
                  {t("settings.sections.maintenance.dedup.notDuplicates", {
                    defaultValue: "Not duplicates",
                  })}
                </Button>
              </>
            )}
            {inFlight && (
              <Button size="sm" variant="ghost" onClick={onCancel}>
                <Trash2 className="h-3.5 w-3.5" />
                {t("settings.sections.maintenance.dedup.cancel", {
                  defaultValue: "Cancel",
                })}
              </Button>
            )}
            {failed && (
              <>
                <Button size="sm" onClick={onRetry}>
                  <RotateCcw className="h-3.5 w-3.5" />
                  {t("settings.sections.maintenance.dedup.retry", {
                    defaultValue: "Retry",
                  })}
                </Button>
                <Button size="sm" variant="ghost" onClick={onCancel}>
                  <Trash2 className="h-3.5 w-3.5" />
                  {t("settings.sections.maintenance.dedup.delete", {
                    defaultValue: "Delete",
                  })}
                </Button>
              </>
            )}
          </div>
        </>
      )}

      {failed && task?.error && (
        <div className="flex items-start gap-1.5 rounded border border-rose-500/40 bg-rose-500/5 px-2 py-1.5 text-xs text-rose-700 dark:text-rose-400">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <div>{task.error}</div>
        </div>
      )}
    </div>
  )
}

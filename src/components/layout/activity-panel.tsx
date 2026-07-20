import { useState, useEffect, useRef, useCallback } from "react"
import {
  ChevronUp, ChevronDown, Loader2, CheckCircle2, AlertCircle,
  FileText, Users, Lightbulb, BookOpen, GitMerge, BarChart3, HelpCircle, Layout,
  RotateCcw, X, Clock, TrendingUp, Target, Pause, Play,
} from "lucide-react"
import { useTranslation } from "react-i18next"
import { useActivityStore, type ActivityItem } from "@/stores/activity-store"
import { useWikiStore } from "@/stores/wiki-store"
import { useFileSyncStore } from "@/stores/file-sync-store"
import { normalizePath, getFileName, isAbsolutePath } from "@/lib/path-utils"
import {
  getQueue,
  getQueueSummary,
  retryTask,
  retryAllFailedTasks,
  cancelTask,
  cancelAllTasks,
  pauseProcessing,
  resumeProcessing,
  type IngestTask,
} from "@/lib/ingest-queue"
import {
  ignoreFileChangeTask,
  rescanProjectFiles,
  retryFileChangeTask,
  type FileChangeTask,
} from "@/commands/file-sync"
import { inferWikiTypeFromPath, wikiTypeLabel } from "@/lib/wiki-page-types"

const FILE_TYPE_ICONS: Record<string, typeof FileText> = {
  sources: BookOpen,
  entities: Users,
  concepts: Lightbulb,
  queries: HelpCircle,
  synthesis: GitMerge,
  comparisons: BarChart3,
  findings: TrendingUp,
  thesis: Target,
  methodology: BookOpen,
  overview: Layout,
}

const WIKI_TYPE_ICON_KEYS: Record<string, keyof typeof FILE_TYPE_ICONS> = {
  entity: "entities",
  concept: "concepts",
  source: "sources",
  query: "queries",
  synthesis: "synthesis",
  comparison: "comparisons",
  finding: "findings",
  thesis: "thesis",
  methodology: "methodology",
  overview: "overview",
}

function getFileTypeInfo(path: string): { icon: typeof FileText; typeKey: string } {
  const inferred = inferWikiTypeFromPath(path)
  if (inferred) {
    const directoryIcon = FILE_TYPE_ICONS[WIKI_TYPE_ICON_KEYS[inferred]]
    return { icon: directoryIcon ?? FileText, typeKey: inferred }
  }
  for (const [dir, icon] of Object.entries(FILE_TYPE_ICONS)) {
    if (path.includes(`/${dir}/`) || path.startsWith(`wiki/${dir}/`)) {
      return { icon, typeKey: dir.replace(/s$/, "") }
    }
  }
  if (path.includes("index.md")) return { icon: Layout, typeKey: "index" }
  if (path.includes("log.md")) return { icon: FileText, typeKey: "log" }
  return { icon: FileText, typeKey: "file" }
}

export function ActivityPanel() {
  const { t } = useTranslation()
  const items = useActivityStore((s) => s.items)
  const clearDone = useActivityStore((s) => s.clearDone)
  const project = useWikiStore((s) => s.project)
  const fileSyncTasks = useFileSyncStore((s) => s.tasks)
  const setFileSyncTasks = useFileSyncStore((s) => s.setTasks)
  const fileSyncError = useFileSyncStore((s) => s.lastError)
  const [expanded, setExpanded] = useState(false)
  const [queueTasks, setQueueTasks] = useState<IngestTask[]>(() => [...getQueue()])
  const prevRunningRef = useRef(0)

  const runningCount = items.filter((i) => i.status === "running").length
  const hasItems = items.length > 0

  // Poll queue state
  useEffect(() => {
    const interval = setInterval(() => {
      setQueueTasks([...getQueue()])
    }, 1000)
    return () => clearInterval(interval)
  }, [])

  const queueSummary = getQueueSummary()
  const hasQueue = queueSummary.total > 0
  const shouldResumeQueue =
    queueSummary.userPaused ||
    (queueSummary.restoredBacklogWaiting && queueSummary.processing === 0)
  const hasFileSync = fileSyncTasks.length > 0 || Boolean(fileSyncError)
  const fileSyncPending = fileSyncTasks.filter((t) => t.status === "pending").length
  const fileSyncProcessing = fileSyncTasks.filter((t) => t.status === "processing").length
  const fileSyncFailed = fileSyncTasks.filter((t) => t.status === "failed").length

  // All hooks must be before any conditional return.
  // retryTask / cancelTask / cancelAllTasks all operate on the currently
  // active project implicitly (via module-scoped state in ingest-queue.ts)
  // — they take NO projectPath argument. An earlier version passed one in
  // and the extra arg silently became "taskId", making retry a no-op for
  // every failed task. Keep this minimal.
  const handleIngestRetry = useCallback((taskId: string) => {
    if (!project) return
    retryTask(taskId)
  }, [project])

  const handleRetryAllFailed = useCallback(() => {
    if (!project) return
    void retryAllFailedTasks()
      .then(() => setQueueTasks([...getQueue()]))
      .catch((err) => {
        console.error("[activity-panel] failed to retry failed ingest tasks:", err)
      })
  }, [project])

  const handleIngestCancel = useCallback((taskId: string) => {
    if (!project) return
    cancelTask(taskId)
  }, [project])

  const handleCancelAll = useCallback(() => {
    if (!project) return
    const activeCount = queueSummary.pending + queueSummary.processing
    if (activeCount === 0) return
    if (!window.confirm(t("activity.cancelAllConfirm", { count: activeCount }))) return
    cancelAllTasks()
  }, [project, queueSummary.pending, queueSummary.processing, t])

  const handleTogglePause = useCallback(() => {
    if (!project) return
    if (shouldResumeQueue) {
      resumeProcessing()
    } else {
      pauseProcessing()
    }
  }, [project, shouldResumeQueue])

  const handleFileSyncRescan = useCallback(() => {
    if (!project) return
    rescanProjectFiles(project.id, normalizePath(project.path), useWikiStore.getState().sourceWatchConfig)
      .then((result) => {
        setFileSyncTasks(result.queue.tasks)
        useFileSyncStore.getState().setLastError(null)
      })
      .catch((err) => useFileSyncStore.getState().setLastError(String(err)))
  }, [project, setFileSyncTasks])

  const handleFileSyncRetry = useCallback((taskId: string) => {
    if (!project) return
    retryFileChangeTask(project.id, normalizePath(project.path), taskId)
      .then((queue) => {
        setFileSyncTasks(queue.tasks)
        useFileSyncStore.getState().setLastError(null)
      })
      .catch((err) => useFileSyncStore.getState().setLastError(String(err)))
  }, [project, setFileSyncTasks])

  const handleFileSyncIgnore = useCallback((taskId: string) => {
    if (!project) return
    ignoreFileChangeTask(project.id, normalizePath(project.path), taskId)
      .then((queue) => {
        setFileSyncTasks(queue.tasks)
        useFileSyncStore.getState().setLastError(null)
      })
      .catch((err) => useFileSyncStore.getState().setLastError(String(err)))
  }, [project, setFileSyncTasks])

  // Auto-expand when a new task starts running
  useEffect(() => {
    if (runningCount > 0 && prevRunningRef.current === 0) {
      setExpanded(true)
    }
    if ((hasQueue || hasFileSync) && !expanded) {
      setExpanded(true)
    }
    prevRunningRef.current = runningCount
  }, [runningCount, hasQueue, hasFileSync, expanded])

  if (!hasItems && !hasQueue && !hasFileSync) return null

  const latestItem = items[0]

  // Build status text
  let statusText = ""
  if (queueSummary.processing > 0 || queueSummary.pending > 0) {
    const done = queueSummary.completed + queueSummary.failed
    statusText = `Queue: ${done}/${queueSummary.total}`
    if (queueSummary.failed > 0) statusText += ` (${queueSummary.failed} failed)`
  } else if (runningCount > 0) {
    statusText = `Processing: ${latestItem?.title ?? "..."}`
  } else if (queueSummary.failed > 0) {
    statusText = `${queueSummary.failed} failed task${queueSummary.failed > 1 ? "s" : ""}`
  } else if (fileSyncProcessing > 0 || fileSyncPending > 0) {
    statusText = `File sync: ${fileSyncProcessing + fileSyncPending} pending`
  } else if (fileSyncFailed > 0) {
    statusText = `File sync: ${fileSyncFailed} failed`
  } else if (fileSyncError) {
    statusText = "File sync failed"
  } else {
    statusText = `Done: ${latestItem?.title ?? "All tasks complete"}`
  }

  const isActive = runningCount > 0 || queueSummary.processing > 0 || queueSummary.pending > 0 || fileSyncProcessing > 0 || fileSyncPending > 0

  return (
    <div className="border-t bg-muted/30">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-muted-foreground hover:bg-accent/50"
      >
        {isActive ? (
          <Loader2 className="h-3 w-3 animate-spin shrink-0" />
        ) : queueSummary.failed > 0 || fileSyncFailed > 0 || fileSyncError ? (
          <AlertCircle className="h-3 w-3 shrink-0 text-destructive" />
        ) : (
          <CheckCircle2 className="h-3 w-3 shrink-0 text-emerald-500" />
        )}
        <span className="flex-1 truncate text-left">{statusText}</span>
        {expanded ? (
          <ChevronDown className="h-3 w-3 shrink-0" />
        ) : (
          <ChevronUp className="h-3 w-3 shrink-0" />
        )}
      </button>

      {expanded && (
        <div className="max-h-64 overflow-y-auto border-t">
          {hasFileSync && (
            <div className="border-b border-border/50 px-3 py-1.5">
              <div className="mb-1 flex items-center justify-between gap-2 text-[10px] text-muted-foreground">
                <span>{t("activity.fileSync")}</span>
                <button
                  onClick={handleFileSyncRescan}
                  className="rounded px-1.5 py-0.5 text-[10px] hover:bg-accent hover:text-foreground"
                  title={t("activity.rescanTitle")}
                >
                  {t("activity.rescan")}
                </button>
              </div>
              {fileSyncError && (
                <div className="mb-1 truncate text-[10px] text-destructive">{fileSyncError}</div>
              )}
              {fileSyncTasks.map((task) => (
                <FileSyncRow
                  key={task.id}
                  task={task}
                  onRetry={handleFileSyncRetry}
                  onIgnore={handleFileSyncIgnore}
                />
              ))}
            </div>
          )}

          {/* Queue progress bar */}
          {hasQueue && (queueSummary.processing > 0 || queueSummary.pending > 0) && (
            <div className="px-3 py-1.5 border-b border-border/50">
              <div className="flex items-center justify-between text-[10px] text-muted-foreground mb-1 gap-2">
                <span>
                  {queueSummary.paused && queueSummary.processing === 0
                    ? t("activity.ingestQueuePaused")
                    : t("activity.ingestQueue")}
                </span>
                <span className="flex-1 text-right">
                  {t("activity.queueCompleteCount", {
                    done: queueSummary.completed + queueSummary.failed,
                    total: queueSummary.total,
                  })}
                </span>
                {(queueSummary.processing > 0 || queueSummary.pending > 0 || queueSummary.paused) && (
                  <button
                    onClick={handleTogglePause}
                    className="flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[10px] hover:bg-accent hover:text-foreground"
                    title={
                      shouldResumeQueue
                        ? t("activity.resumeQueueTitle")
                        : t("activity.pauseQueueTitle")
                    }
                  >
                    {shouldResumeQueue
                      ? <Play className="h-2.5 w-2.5" />
                      : <Pause className="h-2.5 w-2.5" />}
                    {shouldResumeQueue
                      ? t("activity.resumeQueue")
                      : t("activity.pauseQueue")}
                  </button>
                )}
                {queueSummary.pending + queueSummary.processing >= 2 && (
                  <button
                    onClick={handleCancelAll}
                    className="rounded px-1.5 py-0.5 text-[10px] text-destructive hover:bg-destructive/10"
                    title={t("activity.cancelAllTitle")}
                  >
                    {t("activity.cancelAll")}
                  </button>
                )}
                {queueSummary.failed > 0 && (
                  <button
                    onClick={handleRetryAllFailed}
                    className="rounded px-1.5 py-0.5 text-[10px] hover:bg-accent hover:text-foreground"
                    title={t("activity.retryFailedTitle")}
                  >
                    {t("activity.retryFailed")}
                  </button>
                )}
              </div>
              <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                <div
                  className="h-full rounded-full bg-primary transition-all"
                  style={{ width: `${((queueSummary.completed + queueSummary.failed) / Math.max(queueSummary.total, 1)) * 100}%` }}
                />
              </div>
            </div>
          )}

          {hasQueue && queueSummary.processing === 0 && queueSummary.pending === 0 && queueSummary.failed > 0 && (
            <div className="px-3 py-1.5 border-b border-border/50">
              <div className="flex items-center justify-between text-[10px] text-muted-foreground gap-2">
                <span>{t("activity.ingestQueue")}</span>
                <span className="flex-1 text-right">
                  {t("activity.failedCount", { count: queueSummary.failed })}
                </span>
                <button
                  onClick={handleRetryAllFailed}
                  className="rounded px-1.5 py-0.5 text-[10px] hover:bg-accent hover:text-foreground"
                  title={t("activity.retryFailedTitle")}
                >
                  {t("activity.retryFailed")}
                </button>
              </div>
            </div>
          )}

          {/* Queue tasks */}
          {queueTasks.filter((t) => t.status === "processing").map((task) => (
            <QueueRow key={task.id} task={task} onRetry={handleIngestRetry} onCancel={handleIngestCancel} />
          ))}
          {queueTasks.filter((t) => t.status === "pending").map((task) => (
            <QueueRow key={task.id} task={task} onRetry={handleIngestRetry} onCancel={handleIngestCancel} />
          ))}
          {queueTasks.filter((t) => t.status === "failed").map((task) => (
            <QueueRow key={task.id} task={task} onRetry={handleIngestRetry} onCancel={handleIngestCancel} />
          ))}

          {/* Activity items */}
          {items.map((item) => {
            // Find matching queue task for cancel button
            const matchingTask = item.status === "running"
              ? queueTasks.find((t) => t.status === "processing" && getFileName(t.sourcePath) === item.title)
              : undefined
            return (
              <ActivityRow
                key={item.id}
                item={item}
                onCancel={matchingTask ? () => handleIngestCancel(matchingTask.id) : undefined}
              />
            )
          })}
          {items.some((i) => i.status !== "running") && (
            <button
              onClick={clearDone}
              className="w-full px-3 py-1 text-center text-[10px] text-muted-foreground hover:underline"
            >
              {t("activity.clearCompleted")}
            </button>
          )}
        </div>
      )}
    </div>
  )
}

function QueueRow({ task, onRetry, onCancel }: { task: IngestTask; onRetry: (id: string) => void; onCancel: (id: string) => void }) {
  const { t } = useTranslation()
  const fileName = getFileName(task.sourcePath)

  return (
    <div className="px-3 py-2 text-xs border-b border-border/50">
      <div className="flex items-center gap-2">
        <div className="shrink-0">
          {task.status === "processing" && <Loader2 className="h-3 w-3 animate-spin text-primary" />}
          {task.status === "pending" && <Clock className="h-3 w-3 text-muted-foreground" />}
          {task.status === "failed" && <AlertCircle className="h-3 w-3 text-destructive" />}
        </div>
        <div className="min-w-0 flex-1">
          <div className="font-medium truncate">{fileName}</div>
          {task.folderContext && (
            <div className="text-[10px] text-muted-foreground/70 truncate">{task.folderContext}</div>
          )}
          {task.status === "failed" && task.error && (
            <div className="text-[10px] text-destructive mt-0.5 truncate">{task.error}</div>
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {task.status === "failed" && (
            <button
              onClick={() => onRetry(task.id)}
              className="p-0.5 rounded hover:bg-accent text-muted-foreground hover:text-foreground"
              title={t("common.retry")}
            >
              <RotateCcw className="h-3 w-3" />
            </button>
          )}
          {(task.status === "pending" || task.status === "processing") && (
            <button
              onClick={() => onCancel(task.id)}
              className="p-0.5 rounded hover:bg-destructive/20 text-muted-foreground hover:text-destructive"
              title={t("common.cancel")}
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

function FileSyncRow({ task, onRetry, onIgnore }: { task: FileChangeTask; onRetry: (id: string) => void; onIgnore: (id: string) => void }) {
  const { t } = useTranslation()
  const fileName = getFileName(task.path)
  const kindLabel = t(`activity.changeKinds.${task.kind}`, { defaultValue: task.kind })

  return (
    <div className="py-1.5 text-xs">
      <div className="flex items-center gap-2">
        <div className="shrink-0">
          {task.status === "processing" && <Loader2 className="h-3 w-3 animate-spin text-primary" />}
          {task.status === "pending" && <Clock className="h-3 w-3 text-muted-foreground" />}
          {task.status === "failed" && <AlertCircle className="h-3 w-3 text-destructive" />}
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium">{fileName}</div>
          <div className="truncate text-[10px] text-muted-foreground/70">{kindLabel} - {task.path}</div>
          {task.status === "failed" && task.error && (
            <div className="mt-0.5 truncate text-[10px] text-destructive">{task.error}</div>
          )}
        </div>
        {task.status === "failed" && (
          <div className="flex shrink-0 items-center gap-1">
            <button
              onClick={() => onRetry(task.id)}
              className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
              title={t("common.retry")}
            >
              <RotateCcw className="h-3 w-3" />
            </button>
            <button
              onClick={() => onIgnore(task.id)}
              className="rounded p-0.5 text-muted-foreground hover:bg-destructive/20 hover:text-destructive"
              title={t("common.ignore")}
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

function ActivityRow({ item, onCancel }: { item: ActivityItem; onCancel?: () => void }) {
  const { t } = useTranslation()
  const openPathInPreview = useWikiStore((s) => s.openPathInPreview)
  const project = useWikiStore((s) => s.project)

  function handleFileClick(filePath: string) {
    if (!project) return
    const pp = normalizePath(project.path)
    const fullPath = isAbsolutePath(filePath)
      ? normalizePath(filePath)
      : `${pp}/${filePath}`
    openPathInPreview(fullPath)
  }

  return (
    <div className="px-3 py-2 text-xs border-b border-border/50 last:border-b-0">
      <div className="flex items-start gap-2">
        <div className="mt-0.5 shrink-0">
          {item.status === "running" && <Loader2 className="h-3 w-3 animate-spin text-primary" />}
          {item.status === "done" && <CheckCircle2 className="h-3 w-3 text-emerald-500" />}
          {item.status === "error" && <AlertCircle className="h-3 w-3 text-destructive" />}
        </div>
        <div className="min-w-0 flex-1">
          <div className="font-medium">{item.title}</div>
          <div className="text-muted-foreground mt-0.5">{item.detail}</div>
        </div>
        {item.status === "running" && onCancel && (
          <button
            onClick={onCancel}
            className="shrink-0 p-0.5 rounded hover:bg-destructive/20 text-muted-foreground hover:text-destructive"
            title={t("common.cancel")}
          >
            <X className="h-3 w-3" />
          </button>
        )}
      </div>

      {/* File list with types */}
      {item.filesWritten.length > 0 && item.status === "done" && (
        <div className="mt-1.5 ml-5 flex flex-col gap-0.5">
          {item.filesWritten.map((filePath) => {
            const { icon: Icon, typeKey } = getFileTypeInfo(filePath)
            const fileName = getFileName(filePath)
            return (
              <button
                key={filePath}
                type="button"
                onClick={() => handleFileClick(filePath)}
                className="flex items-center gap-1.5 rounded px-1 py-0.5 text-left text-muted-foreground hover:bg-accent/50 hover:text-foreground transition-colors"
              >
                <Icon className="h-3 w-3 shrink-0" />
                <span className="text-[10px] font-medium text-muted-foreground/70 w-14 shrink-0">
                  {t(`activity.fileTypes.${typeKey}`, { defaultValue: wikiTypeLabel(typeKey) })}
                </span>
                <span className="truncate">{fileName}</span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

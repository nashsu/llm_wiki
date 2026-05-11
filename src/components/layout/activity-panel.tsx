import { useState, useEffect, useRef, useCallback } from "react"
import {
  ChevronUp, ChevronDown, Loader2, CheckCircle2, AlertCircle,
  FileText, Users, Lightbulb, BookOpen, GitMerge, BarChart3, HelpCircle, Layout,
  RotateCcw, X, Clock,
} from "lucide-react"
import { useActivityStore, type ActivityItem } from "@/stores/activity-store"
import { useWikiStore } from "@/stores/wiki-store"
import { normalizePath, getFileName, isAbsolutePath } from "@/lib/path-utils"
import { getQueue, getQueueSummary, retryTask, cancelTask, cancelAllTasks, type IngestTask } from "@/lib/ingest-queue"

const FILE_TYPE_ICONS: Record<string, typeof FileText> = {
  sources: BookOpen,
  entities: Users,
  concepts: Lightbulb,
  queries: HelpCircle,
  synthesis: GitMerge,
  comparisons: BarChart3,
}

function getFileTypeInfo(path: string): { icon: typeof FileText; type: string } {
  for (const [dir, icon] of Object.entries(FILE_TYPE_ICONS)) {
    if (path.includes(`/${dir}/`) || path.startsWith(`wiki/${dir}/`)) {
      return { icon, type: dir.charAt(0).toUpperCase() + dir.slice(1, -1) }
    }
  }
  if (path.includes("index.md")) return { icon: Layout, type: "Index" }
  if (path.includes("log.md")) return { icon: FileText, type: "Log" }
  return { icon: FileText, type: "File" }
}

export function ActivityPanel() {
  const items = useActivityStore((s) => s.items)
  const clearDone = useActivityStore((s) => s.clearDone)
  const project = useWikiStore((s) => s.project)
  const [expanded, setExpanded] = useState(false)
  const [queueTasks, setQueueTasks] = useState<IngestTask[]>([])
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

  // All hooks must be before any conditional return.
  // retryTask / cancelTask / cancelAllTasks all operate on the currently
  // active project implicitly (via module-scoped state in ingest-queue.ts)
  // — they take NO projectPath argument. An earlier version passed one in
  // and the extra arg silently became "taskId", making retry a no-op for
  // every failed task. Keep this minimal.
  const handleRetry = useCallback((taskId: string) => {
    if (!project) return
    retryTask(taskId)
  }, [project])

  const handleCancel = useCallback((taskId: string) => {
    if (!project) return
    cancelTask(taskId)
  }, [project])

  const handleCancelAll = useCallback(() => {
    if (!project) return
    const activeCount = queueSummary.pending + queueSummary.processing
    if (activeCount === 0) return
    if (!window.confirm(
      `取消全部 ${activeCount} 个排队/处理中的任务？` +
      `正在处理任务的临时文件会被移除。` +
      `失败任务会保留，之后仍可重试。`,
    )) return
    cancelAllTasks()
  }, [project, queueSummary.pending, queueSummary.processing])

  // Auto-expand when a new task starts running
  useEffect(() => {
    if (runningCount > 0 && prevRunningRef.current === 0) {
      setExpanded(true)
    }
    if (hasQueue && !expanded) {
      setExpanded(true)
    }
    prevRunningRef.current = runningCount
  }, [runningCount, hasQueue, expanded])

  if (!hasItems && !hasQueue) return null

  const latestItem = items[0]

  // Build status text
  let statusText = ""
  if (queueSummary.processing > 0 || queueSummary.pending > 0) {
    const done = queueSummary.total - queueSummary.pending - queueSummary.processing
    statusText = `队列：${done}/${queueSummary.total}`
    if (queueSummary.failed > 0) statusText += `（${queueSummary.failed} 个失败）`
  } else if (runningCount > 0) {
    statusText = `处理中：${latestItem?.title ?? "..."}`
  } else if (queueSummary.failed > 0) {
    statusText = `${queueSummary.failed} 个失败任务`
  } else {
    statusText = `完成：${latestItem?.title ?? "所有任务已完成"}`
  }

  const isActive = runningCount > 0 || queueSummary.processing > 0 || queueSummary.pending > 0

  return (
    <div className="border-t bg-muted/30">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-muted-foreground hover:bg-accent/50"
      >
        {isActive ? (
          <Loader2 className="h-3 w-3 animate-spin shrink-0" />
        ) : queueSummary.failed > 0 ? (
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
          {/* Queue progress bar */}
          {hasQueue && (queueSummary.processing > 0 || queueSummary.pending > 0) && (
            <div className="px-3 py-1.5 border-b border-border/50">
              <div className="flex items-center justify-between text-[10px] text-muted-foreground mb-1 gap-2">
                <span>提取队列</span>
                <span className="flex-1 text-right">
                  已完成 {queueSummary.total - queueSummary.pending - queueSummary.processing}/{queueSummary.total}
                </span>
                {queueSummary.pending + queueSummary.processing >= 2 && (
                  <button
                    onClick={handleCancelAll}
                    className="rounded px-1.5 py-0.5 text-[10px] text-destructive hover:bg-destructive/10"
                    title="取消全部排队和处理中的任务"
                  >
                    全部取消
                  </button>
                )}
              </div>
              <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                <div
                  className="h-full rounded-full bg-primary transition-all"
                  style={{ width: `${((queueSummary.total - queueSummary.pending - queueSummary.processing) / Math.max(queueSummary.total, 1)) * 100}%` }}
                />
              </div>
            </div>
          )}

          {/* Queue tasks */}
          {queueTasks.filter((t) => t.status === "processing").map((task) => (
            <QueueRow key={task.id} task={task} onRetry={handleRetry} onCancel={handleCancel} />
          ))}
          {queueTasks.filter((t) => t.status === "pending").map((task) => (
            <QueueRow key={task.id} task={task} onRetry={handleRetry} onCancel={handleCancel} />
          ))}
          {queueTasks.filter((t) => t.status === "failed").map((task) => (
            <QueueRow key={task.id} task={task} onRetry={handleRetry} onCancel={handleCancel} />
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
                onCancel={matchingTask ? () => handleCancel(matchingTask.id) : undefined}
              />
            )
          })}
          {items.some((i) => i.status !== "running") && (
            <button
              onClick={clearDone}
              className="w-full px-3 py-1 text-center text-[10px] text-muted-foreground hover:underline"
            >
              清除已完成
            </button>
          )}
        </div>
      )}
    </div>
  )
}

function QueueRow({ task, onRetry, onCancel }: { task: IngestTask; onRetry: (id: string) => void; onCancel: (id: string) => void }) {
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
              title="重试"
            >
              <RotateCcw className="h-3 w-3" />
            </button>
          )}
          {(task.status === "pending" || task.status === "processing") && (
            <button
              onClick={() => onCancel(task.id)}
              className="p-0.5 rounded hover:bg-destructive/20 text-muted-foreground hover:text-destructive"
              title="取消"
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

function ActivityRow({ item, onCancel }: { item: ActivityItem; onCancel?: () => void }) {
  const setSelectedFile = useWikiStore((s) => s.setSelectedFile)
  const project = useWikiStore((s) => s.project)

  function handleFileClick(filePath: string) {
    if (!project) return
    const pp = normalizePath(project.path)
    const fullPath = isAbsolutePath(filePath)
      ? normalizePath(filePath)
      : `${pp}/${filePath}`
    setSelectedFile(fullPath)
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
            title="取消"
          >
            <X className="h-3 w-3" />
          </button>
        )}
      </div>

      {/* File list with types */}
      {item.filesWritten.length > 0 && item.status === "done" && (
        <div className="mt-1.5 ml-5 flex flex-col gap-0.5">
          {item.filesWritten.map((filePath) => {
            const { icon: Icon, type } = getFileTypeInfo(filePath)
            const fileName = getFileName(filePath)
            return (
              <button
                key={filePath}
                type="button"
                onClick={() => handleFileClick(filePath)}
                className="flex items-center gap-1.5 rounded px-1 py-0.5 text-left text-muted-foreground hover:bg-accent/50 hover:text-foreground transition-colors"
              >
                <Icon className="h-3 w-3 shrink-0" />
                <span className="text-[10px] font-medium text-muted-foreground/70 w-14 shrink-0">{type}</span>
                <span className="truncate">{fileName}</span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

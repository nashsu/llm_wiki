import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  CheckCircle2,
  CloudUpload,
  FolderOpen,
  Loader2,
  X,
  XCircle,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { getQueue, uploadForIngest, type IngestTask } from "@/api/ingest"
import { connectEvents } from "@/api/events"
import { attachRelativePath, extractDroppedFiles } from "@/lib/folder-drop"

export interface DropZoneProps {
  projectId: number
  onUploadComplete?: () => void
  className?: string
}

type FileStatus = "uploading" | "queued" | "processing" | "done" | "error"

interface UploadEntry {
  id: string
  /** Display path — folder drops keep "folder/sub/file.md". */
  name: string
  size: number
  status: FileStatus
  /** 0..100; upload phase drives 0..100, server ingest refines after queueing. */
  progress: number
  error?: string
  taskId?: number
}

const STATUS_LABEL: Record<FileStatus, string> = {
  uploading: "Uploading",
  queued: "Queued",
  processing: "Processing",
  done: "Done",
  error: "Failed",
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Drag-and-drop ingest surface for the web client.
 *
 * Accepts loose files and whole folders (via the FileSystem Entries API in
 * `@/lib/folder-drop`), uploads each file through the ingest API, then tracks
 * server-side progress over SSE (`ingest:progress` / `ingest:complete` /
 * `ingest:error`), falling back to queue polling when the stream is down.
 */
export function DropZone({ projectId, onUploadComplete, className }: DropZoneProps) {
  const [entries, setEntries] = useState<UploadEntry[]>([])
  const [dragActive, setDragActive] = useState(false)
  const dragDepth = useRef(0)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const entrySeq = useRef(0)

  const patchEntry = useCallback((id: string, patch: Partial<UploadEntry>) => {
    setEntries((prev) => prev.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry)))
  }, [])

  const patchByTaskId = useCallback((taskId: number, patch: Partial<UploadEntry>) => {
    setEntries((prev) =>
      prev.map((entry) => (entry.taskId === taskId ? { ...entry, ...patch } : entry)),
    )
  }, [])

  const uploadOne = useCallback(
    async (file: File, id: string) => {
      try {
        const res = await uploadForIngest(projectId, file)
        patchEntry(id, { status: "queued", progress: 100, taskId: res.taskId })
      } catch (err) {
        patchEntry(id, { status: "error", error: errorMessage(err) })
      }
    },
    [projectId, patchEntry],
  )

  const handleFiles = useCallback(
    async (files: File[]) => {
      if (files.length === 0) return
      const fresh: UploadEntry[] = []
      const jobs: Array<Promise<void>> = []
      for (const file of files) {
        entrySeq.current += 1
        const id = `upload-${entrySeq.current}`
        fresh.push({
          id,
          name: file.webkitRelativePath || file.name,
          size: file.size,
          status: "uploading",
          progress: 0,
        })
        jobs.push(uploadOne(file, id))
      }
      setEntries((prev) => [...prev, ...fresh])
      await Promise.all(jobs)
      onUploadComplete?.()
    },
    [onUploadComplete, uploadOne],
  )

  const handleDrop = useCallback(
    async (event: React.DragEvent<HTMLElement>) => {
      event.preventDefault()
      dragDepth.current = 0
      setDragActive(false)
      const items = event.dataTransfer.items
      if (!items || items.length === 0) return
      const dropped = await extractDroppedFiles(items)
      const files = dropped.map(({ file, relativePath }) =>
        attachRelativePath(file, relativePath),
      )
      void handleFiles(files)
    },
    [handleFiles],
  )

  const handleDragEnter = useCallback((event: React.DragEvent<HTMLElement>) => {
    event.preventDefault()
    dragDepth.current += 1
    setDragActive(true)
  }, [])

  const handleDragLeave = useCallback((event: React.DragEvent<HTMLElement>) => {
    event.preventDefault()
    dragDepth.current = Math.max(0, dragDepth.current - 1)
    if (dragDepth.current === 0) setDragActive(false)
  }, [])

  const handleDragOver = useCallback((event: React.DragEvent<HTMLElement>) => {
    event.preventDefault()
    if (event.dataTransfer.dropEffect !== "copy") {
      event.dataTransfer.dropEffect = "copy"
    }
  }, [])

  const handleInputChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const selected = event.target.files
      if (!selected) return
      void handleFiles(Array.from(selected))
      // Reset so picking the same file twice still fires change.
      event.target.value = ""
    },
    [handleFiles],
  )

  // Server-side progress over SSE. Envelope payloads are untyped, so parse
  // defensively; events for other projects are ignored.
  useEffect(() => {
    const disconnect = connectEvents((evt) => {
      const payload = evt.payload as
        | { projectId?: number; taskId?: number; progress?: number; error?: string }
        | null
      if (!payload || typeof payload !== "object") return
      if (typeof payload.projectId === "number" && payload.projectId !== projectId) return
      const taskId = typeof payload.taskId === "number" ? payload.taskId : null
      if (taskId === null) return

      if (evt.event === "ingest:progress") {
        const progress = typeof payload.progress === "number" ? payload.progress : undefined
        if (progress === undefined) return
        patchByTaskId(taskId, { status: "processing", progress })
      } else if (evt.event === "ingest:complete") {
        patchByTaskId(taskId, { status: "done", progress: 100 })
      } else if (evt.event === "ingest:error") {
        patchByTaskId(taskId, {
          status: "error",
          error: typeof payload.error === "string" ? payload.error : "Ingest failed",
        })
      }
    })
    return disconnect
  }, [projectId, patchByTaskId])

  // Poll the queue as a fallback: covers browsers without SSE support and
  // tasks whose progress events were missed (e.g. stream reconnecting).
  const hasTrackableRef = useRef(false)
  useEffect(() => {
    hasTrackableRef.current = entries.some(
      (entry) =>
        entry.taskId !== undefined &&
        (entry.status === "queued" || entry.status === "processing"),
    )
  })

  useEffect(() => {
    const timer = setInterval(() => {
      if (!hasTrackableRef.current) return
      getQueue(projectId, { limit: 200 })
        .then((queue) => {
          const byId = new Map<number, IngestTask>(queue.tasks.map((task) => [task.id, task]))
          setEntries((current) =>
            current.map((entry) => {
              if (entry.taskId === undefined) return entry
              if (entry.status !== "queued" && entry.status !== "processing") return entry
              const task = byId.get(entry.taskId)
              if (!task) return entry
              if (task.status === "completed") return { ...entry, status: "done", progress: 100 }
              if (task.status === "failed") {
                return { ...entry, status: "error", error: task.error ?? "Ingest failed" }
              }
              if (task.status === "processing") {
                return { ...entry, status: "processing", progress: task.progress }
              }
              return entry
            }),
          )
        })
        .catch(() => {
          /* transient — next tick retries */
        })
    }, 2000)
    return () => clearInterval(timer)
  }, [projectId])

  const stats = useMemo(() => {
    const total = entries.length
    const finished = entries.filter((entry) => entry.status === "done").length
    const failed = entries.filter((entry) => entry.status === "error").length
    const active = entries.filter(
      (entry) => entry.status === "uploading" || entry.status === "queued" || entry.status === "processing",
    ).length
    const percent =
      total === 0 ? 0 : Math.round(entries.reduce((sum, entry) => sum + entry.progress, 0) / total)
    return { total, finished, failed, active, percent }
  }, [entries])

  const clearFinished = useCallback(() => {
    setEntries((prev) => prev.filter((entry) => entry.status !== "done" && entry.status !== "error"))
  }, [])

  const hasFinished = stats.finished + stats.failed > 0

  return (
    <div className={cn("flex w-full flex-col gap-3", className)}>
      <div
        role="button"
        tabIndex={0}
        aria-label="Drop files or folders here to ingest them"
        onClick={() => inputRef.current?.click()}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault()
            inputRef.current?.click()
          }
        }}
        onDrop={handleDrop}
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
        onDragOver={handleDragOver}
        className={cn(
          "group relative flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-6 py-10 text-center outline-none transition-all duration-200",
          "focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50",
          dragActive
            ? "border-primary bg-primary/10 ring-3 ring-primary/30"
            : "border-border bg-muted/30 hover:border-primary/50 hover:bg-muted/60",
        )}
      >
        <span
          className={cn(
            "flex size-12 items-center justify-center rounded-full transition-all duration-200",
            dragActive
              ? "scale-110 bg-primary/20 text-primary"
              : "bg-muted text-muted-foreground group-hover:bg-primary/10 group-hover:text-primary",
          )}
        >
          {dragActive ? (
            <FolderOpen className="size-6" />
          ) : (
            <CloudUpload className="size-6 transition-transform duration-200 group-hover:-translate-y-0.5" />
          )}
        </span>
        <p className={cn("text-sm font-medium", dragActive ? "text-primary" : "text-foreground")}>
          {dragActive ? "Release to ingest" : "Drag files or folders here"}
        </p>
        <p className="text-xs text-muted-foreground">
          {dragActive
            ? "Folder structure is preserved"
            : "or click to browse — folder structure is preserved"}
        </p>
        <input
          ref={inputRef}
          type="file"
          multiple
          className="hidden"
          onChange={handleInputChange}
          // @ts-expect-error -- non-standard attribute enabling folder picking
          webkitdirectory=""
        />
      </div>

      {entries.length > 0 && (
        <div className="rounded-xl border bg-card">
          <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
            <span className="text-xs font-medium text-muted-foreground">
              {stats.active > 0
                ? `${stats.finished}/${stats.total} complete`
                : `${stats.finished}/${stats.total} complete${stats.failed > 0 ? ` · ${stats.failed} failed` : ""}`}
            </span>
            {hasFinished && (
              <button
                type="button"
                onClick={clearFinished}
                className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                <X className="size-3" />
                Clear finished
              </button>
            )}
          </div>

          {/* Aggregate progress while anything is still in flight. */}
          {stats.active > 0 && (
            <div className="h-1 w-full overflow-hidden bg-muted">
              <div
                className="h-full bg-primary transition-[width] duration-300 ease-out"
                style={{ width: `${stats.percent}%` }}
              />
            </div>
          )}

          <ul className="max-h-64 divide-y overflow-y-auto">
            {entries.map((entry) => (
              <li key={entry.id} className="flex items-center gap-2.5 px-3 py-2">
                <EntryStatusIcon status={entry.status} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="truncate text-xs font-medium" title={entry.name}>
                      {entry.name}
                    </span>
                    <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
                      {entry.status === "error"
                        ? entry.error ?? "Failed"
                        : `${formatBytes(entry.size)} · ${STATUS_LABEL[entry.status]}`}
                    </span>
                  </div>
                  <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-muted">
                    <div
                      className={cn(
                        "h-full rounded-full transition-[width] duration-300 ease-out",
                        entry.status === "error"
                          ? "bg-destructive"
                          : entry.status === "done"
                            ? "bg-primary/60"
                            : "bg-primary",
                      )}
                      style={{ width: `${entry.status === "error" ? 100 : entry.progress}%` }}
                    />
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

function EntryStatusIcon({ status }: { status: FileStatus }) {
  switch (status) {
    case "uploading":
    case "queued":
    case "processing":
      return <Loader2 className="size-4 shrink-0 animate-spin text-primary" />
    case "done":
      return <CheckCircle2 className="size-4 shrink-0 text-emerald-500" />
    case "error":
      return <XCircle className="size-4 shrink-0 text-destructive" />
  }
}

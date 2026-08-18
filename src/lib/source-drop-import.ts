import type { EventCallback, UnlistenFn } from "@tauri-apps/api/event"
import type { DragDropEvent } from "@tauri-apps/api/webview"

export interface NativeDragDropEventSource {
  onDragDropEvent: (handler: EventCallback<DragDropEvent>) => Promise<UnlistenFn>
}

export interface SourceDropSubscriptionHandlers {
  isActive: () => boolean
  onDraggingChange: (dragging: boolean) => void
  onDrop: (paths: string[]) => void
  onError: (error: unknown) => void
}

/**
 * Subscribe to Tauri's native drag-and-drop boundary and translate its four
 * event variants into the state changes needed by the Sources view.
 */
export function subscribeToSourceDrops(
  source: NativeDragDropEventSource,
  handlers: SourceDropSubscriptionHandlers,
): UnlistenFn {
  let disposed = false
  let unlisten: UnlistenFn | undefined

  void source.onDragDropEvent((event) => {
    if (disposed || !handlers.isActive()) return

    switch (event.payload.type) {
      case "enter":
      case "over":
        handlers.onDraggingChange(true)
        break
      case "leave":
        handlers.onDraggingChange(false)
        break
      case "drop":
        handlers.onDraggingChange(false)
        handlers.onDrop(event.payload.paths)
        break
    }
  }).then((stop) => {
    if (disposed) {
      stop()
    } else {
      unlisten = stop
    }
  }).catch((error) => {
    if (!disposed) handlers.onError(error)
  })

  return () => {
    if (disposed) return
    disposed = true
    unlisten?.()
  }
}

export interface DroppedSourcePathImporters {
  isDirectory: (path: string) => Promise<boolean>
  importFiles: (paths: string[]) => Promise<string[]>
  importFolder: (path: string) => Promise<string[]>
}

export interface DroppedSourceImportResult {
  importedPaths: string[]
  errors: string[]
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Classify native Tauri drop paths, then send them through the same import
 * functions used by the Sources toolbar. Native drop events provide absolute
 * paths; keep them intact so filesystem commands can resolve the dropped item.
 */
export async function importDroppedSourcePaths(
  paths: string[],
  importers: DroppedSourcePathImporters,
): Promise<DroppedSourceImportResult> {
  const filePaths: string[] = []
  const folderPaths: string[] = []
  const errors: string[] = []

  const classifications = await Promise.allSettled(
    paths.map((path) => importers.isDirectory(path)),
  )

  for (const [index, classification] of classifications.entries()) {
    const path = paths[index]
    if (classification.status === "rejected") {
      errors.push(`${path}: ${errorMessage(classification.reason)}`)
    } else if (classification.value) {
      folderPaths.push(path)
    } else {
      filePaths.push(path)
    }
  }

  const importedPaths: string[] = []
  if (filePaths.length > 0) {
    try {
      importedPaths.push(...await importers.importFiles(filePaths))
    } catch (error) {
      errors.push(errorMessage(error))
    }
  }

  for (const path of folderPaths) {
    try {
      importedPaths.push(...await importers.importFolder(path))
    } catch (error) {
      errors.push(`${path}: ${errorMessage(error)}`)
    }
  }

  return { importedPaths, errors }
}

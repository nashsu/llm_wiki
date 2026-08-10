import { describe, expect, it, vi } from "vitest"
import type { EventCallback, UnlistenFn } from "@tauri-apps/api/event"
import type { DragDropEvent } from "@tauri-apps/api/webview"
import {
  importDroppedSourcePaths,
  subscribeToSourceDrops,
} from "./source-drop-import"

function nativeEvent(payload: DragDropEvent): Parameters<EventCallback<DragDropEvent>>[0] {
  return {
    event: `tauri://drag-${payload.type}`,
    id: 1,
    payload,
  }
}

describe("subscribeToSourceDrops", () => {
  it("translates active native events into hover state and absolute drop paths", async () => {
    let listener: EventCallback<DragDropEvent> | undefined
    const stop = vi.fn()
    const onDraggingChange = vi.fn()
    const onDrop = vi.fn()
    const onError = vi.fn()
    const source = {
      onDragDropEvent: vi.fn((handler: EventCallback<DragDropEvent>) => {
        listener = handler
        return Promise.resolve(stop)
      }),
    }

    const dispose = subscribeToSourceDrops(source, {
      isActive: () => true,
      onDraggingChange,
      onDrop,
      onError,
    })

    listener?.(nativeEvent({
      type: "enter",
      paths: ["/tmp/native-drag-probe.md"],
      position: { x: 10, y: 20 },
    } as DragDropEvent))
    listener?.(nativeEvent({
      type: "drop",
      paths: ["/tmp/native-drag-probe.md"],
      position: { x: 10, y: 20 },
    } as DragDropEvent))

    expect(onDraggingChange).toHaveBeenNthCalledWith(1, true)
    expect(onDraggingChange).toHaveBeenNthCalledWith(2, false)
    expect(onDrop).toHaveBeenCalledWith(["/tmp/native-drag-probe.md"])
    expect(onError).not.toHaveBeenCalled()

    await Promise.resolve()
    dispose()
    expect(stop).toHaveBeenCalledOnce()
  })

  it("ignores native drag events while Sources is inactive", () => {
    let listener: EventCallback<DragDropEvent> | undefined
    const onDraggingChange = vi.fn()
    const onDrop = vi.fn()
    const source = {
      onDragDropEvent: vi.fn((handler: EventCallback<DragDropEvent>) => {
        listener = handler
        return new Promise<UnlistenFn>(() => undefined)
      }),
    }

    subscribeToSourceDrops(source, {
      isActive: () => false,
      onDraggingChange,
      onDrop,
      onError: vi.fn(),
    })
    listener?.(nativeEvent({
      type: "drop",
      paths: ["/tmp/ignored.md"],
      position: { x: 10, y: 20 },
    } as DragDropEvent))

    expect(onDraggingChange).not.toHaveBeenCalled()
    expect(onDrop).not.toHaveBeenCalled()
  })

  it("clears hover without dropping paths when an active native drag leaves", () => {
    let listener: EventCallback<DragDropEvent> | undefined
    const onDraggingChange = vi.fn()
    const onDrop = vi.fn()
    const source = {
      onDragDropEvent: vi.fn((handler: EventCallback<DragDropEvent>) => {
        listener = handler
        return new Promise<UnlistenFn>(() => undefined)
      }),
    }

    subscribeToSourceDrops(source, {
      isActive: () => true,
      onDraggingChange,
      onDrop,
      onError: vi.fn(),
    })
    listener?.(nativeEvent({ type: "leave" } as DragDropEvent))

    expect(onDraggingChange).toHaveBeenCalledOnce()
    expect(onDraggingChange).toHaveBeenCalledWith(false)
    expect(onDrop).not.toHaveBeenCalled()
  })

  it("unsubscribes if the component is disposed before registration finishes", async () => {
    let listener: EventCallback<DragDropEvent> | undefined
    let resolveRegistration: ((stop: UnlistenFn) => void) | undefined
    const stop = vi.fn()
    const onDraggingChange = vi.fn()
    const onDrop = vi.fn()
    const source = {
      onDragDropEvent: vi.fn((handler: EventCallback<DragDropEvent>) => new Promise<UnlistenFn>((resolve) => {
        listener = handler
        resolveRegistration = resolve
      })),
    }

    const dispose = subscribeToSourceDrops(source, {
      isActive: () => true,
      onDraggingChange,
      onDrop,
      onError: vi.fn(),
    })
    dispose()
    listener?.(nativeEvent({
      type: "drop",
      paths: ["/tmp/ignored-after-dispose.md"],
      position: { x: 10, y: 20 },
    } as DragDropEvent))
    resolveRegistration?.(stop)
    await Promise.resolve()

    expect(onDraggingChange).not.toHaveBeenCalled()
    expect(onDrop).not.toHaveBeenCalled()
    expect(stop).toHaveBeenCalledOnce()
  })

  it("reports a rejected native drag registration", async () => {
    const registrationError = new Error("registration failed")
    const onError = vi.fn()
    const source = {
      onDragDropEvent: vi.fn().mockRejectedValue(registrationError),
    }

    subscribeToSourceDrops(source, {
      isActive: () => true,
      onDraggingChange: vi.fn(),
      onDrop: vi.fn(),
      onError,
    })

    await vi.waitFor(() => {
      expect(onError).toHaveBeenCalledOnce()
    })
    expect(onError).toHaveBeenCalledWith(registrationError)
  })

  it("ignores a registration failure after the subscription is disposed", async () => {
    let rejectRegistration: ((error: unknown) => void) | undefined
    const onError = vi.fn()
    const source = {
      onDragDropEvent: vi.fn(() => new Promise<UnlistenFn>((_resolve, reject) => {
        rejectRegistration = reject
      })),
    }

    const dispose = subscribeToSourceDrops(source, {
      isActive: () => true,
      onDraggingChange: vi.fn(),
      onDrop: vi.fn(),
      onError,
    })

    dispose()
    rejectRegistration?.(new Error("late registration failure"))
    await Promise.resolve()

    expect(onError).not.toHaveBeenCalled()
  })
})

describe("importDroppedSourcePaths", () => {
  it("passes a native drop's absolute file path to the file importer", async () => {
    const importFiles = vi.fn().mockResolvedValue([
      "/project/raw/sources/native-drag-probe.md",
    ])
    const importFolder = vi.fn()

    const result = await importDroppedSourcePaths(
      ["/tmp/native-drag-probe.md"],
      {
        isDirectory: vi.fn().mockResolvedValue(false),
        importFiles,
        importFolder,
      },
    )

    expect(importFiles).toHaveBeenCalledWith(["/tmp/native-drag-probe.md"])
    expect(importFiles).not.toHaveBeenCalledWith(["native-drag-probe.md"])
    expect(importFolder).not.toHaveBeenCalled()
    expect(result).toEqual({
      importedPaths: ["/project/raw/sources/native-drag-probe.md"],
      errors: [],
    })
  })

  it("routes a mixed native drop to the existing file and folder importers", async () => {
    const importFiles = vi.fn().mockResolvedValue(["/project/raw/sources/notes.md"])
    const importFolder = vi.fn().mockResolvedValue([
      "/project/raw/sources/reference/chapter.md",
    ])

    const result = await importDroppedSourcePaths(
      ["/tmp/notes.md", "/tmp/reference"],
      {
        isDirectory: vi.fn((path: string) => Promise.resolve(path.endsWith("reference"))),
        importFiles,
        importFolder,
      },
    )

    expect(importFiles).toHaveBeenCalledWith(["/tmp/notes.md"])
    expect(importFolder).toHaveBeenCalledWith("/tmp/reference")
    expect(result).toEqual({
      importedPaths: [
        "/project/raw/sources/notes.md",
        "/project/raw/sources/reference/chapter.md",
      ],
      errors: [],
    })
  })

  it("reports a rejected file import while still importing a valid folder", async () => {
    const importFiles = vi.fn().mockRejectedValue(new Error("file import failed"))
    const importFolder = vi.fn().mockResolvedValue([
      "/project/raw/sources/reference/chapter.md",
    ])

    const result = await importDroppedSourcePaths(
      ["/tmp/notes.md", "/tmp/reference"],
      {
        isDirectory: vi.fn((path: string) => Promise.resolve(path.endsWith("reference"))),
        importFiles,
        importFolder,
      },
    )

    expect(importFiles).toHaveBeenCalledWith(["/tmp/notes.md"])
    expect(importFolder).toHaveBeenCalledWith("/tmp/reference")
    expect(result).toEqual({
      importedPaths: ["/project/raw/sources/reference/chapter.md"],
      errors: ["file import failed"],
    })
  })

  it("reports a failed folder with its path and continues with later folders", async () => {
    const importFolder = vi.fn()
      .mockRejectedValueOnce(new Error("folder import failed"))
      .mockResolvedValueOnce(["/project/raw/sources/later/chapter.md"])

    const result = await importDroppedSourcePaths(
      ["/tmp/broken", "/tmp/later"],
      {
        isDirectory: vi.fn().mockResolvedValue(true),
        importFiles: vi.fn(),
        importFolder,
      },
    )

    expect(importFolder).toHaveBeenNthCalledWith(1, "/tmp/broken")
    expect(importFolder).toHaveBeenNthCalledWith(2, "/tmp/later")
    expect(result).toEqual({
      importedPaths: ["/project/raw/sources/later/chapter.md"],
      errors: ["/tmp/broken: folder import failed"],
    })
  })

  it("reports an item that cannot be classified while still importing valid paths", async () => {
    const importFiles = vi.fn().mockResolvedValue(["/project/raw/sources/notes.md"])

    const result = await importDroppedSourcePaths(
      ["/tmp/notes.md", "/tmp/missing.md"],
      {
        isDirectory: vi.fn((path: string) => {
          if (path.endsWith("missing.md")) return Promise.reject(new Error("not found"))
          return Promise.resolve(false)
        }),
        importFiles,
        importFolder: vi.fn(),
      },
    )

    expect(importFiles).toHaveBeenCalledWith(["/tmp/notes.md"])
    expect(result).toEqual({
      importedPaths: ["/project/raw/sources/notes.md"],
      errors: ["/tmp/missing.md: not found"],
    })
  })
})

// Folder-drop support for the web client.
//
// Browsers expose dropped directories through the non-standard FileSystem
// Entries API (`DataTransferItem.webkitGetAsEntry()`, Chromium + Firefox).
// lib.dom intentionally does not type it, so this module declares the minimal
// structural surface it needs and walks the entry tree recursively, returning
// plain `File` objects with their drop-relative paths preserved (e.g.
// "docs/notes/intro.md" for a file nested two levels inside a dropped folder).

/** Minimal structural type for a FileSystemEntry (not in lib.dom). */
interface FileSystemEntryLike {
  readonly isFile: boolean
  readonly isDirectory: boolean
  readonly name: string
  /** POSIX-style path rooted at the drop, e.g. "/research/notes.md". */
  readonly fullPath: string
}

interface FileSystemFileEntryLike extends FileSystemEntryLike {
  file(successCallback: (file: File) => void, errorCallback?: (error: DOMException) => void): void
}

interface FileSystemDirectoryEntryLike extends FileSystemEntryLike {
  createReader(): FileSystemDirectoryReaderLike
}

interface FileSystemDirectoryReaderLike {
  readEntries(
    successCallback: (entries: FileSystemEntryLike[]) => void,
    errorCallback?: (error: DOMException) => void,
  ): void
}

type DataTransferItemWithEntry = DataTransferItem & {
  webkitGetAsEntry?: () => FileSystemEntryLike | null
}

/** A dropped file plus its path relative to the drop root. */
export interface DroppedFile {
  file: File
  /** "name.md" for loose files; "folder/sub/name.md" for folder contents. */
  relativePath: string
}

interface PendingDrop {
  entry: FileSystemEntryLike | null
  fallbackFile: File | null
}

/**
 * Extract every file from a drop, recursing into directories.
 *
 * IMPORTANT: `DataTransferItemList` is only valid for the duration of the
 * drop event, so all entries/files are collected synchronously up front;
 * only the (callback-based) tree traversal runs asynchronously afterwards.
 */
export async function extractDroppedFiles(
  items: ArrayLike<DataTransferItem>,
): Promise<DroppedFile[]> {
  // Synchronous pass — must complete before the event handler returns.
  const pending: PendingDrop[] = []
  for (let i = 0; i < items.length; i++) {
    const item = items[i] as DataTransferItemWithEntry
    if (item.kind !== "file") continue
    let entry: FileSystemEntryLike | null = null
    try {
      entry = typeof item.webkitGetAsEntry === "function" ? item.webkitGetAsEntry() : null
    } catch {
      entry = null
    }
    pending.push({ entry, fallbackFile: entry ? null : item.getAsFile() })
  }

  // Asynchronous pass — walk directory trees, fall back to loose files.
  const results: DroppedFile[] = []
  for (const drop of pending) {
    if (drop.entry) {
      results.push(...(await traverseEntry(drop.entry)))
    } else if (drop.fallbackFile) {
      results.push({ file: drop.fallbackFile, relativePath: drop.fallbackFile.name })
    }
  }
  return results
}

/**
 * Stamp `webkitRelativePath` onto a File so downstream consumers (mirroring
 * `<input webkitdirectory>` behaviour) can recover the folder structure.
 * The property is read-only in the WebIDL, so it is (re)defined directly;
 * engines that refuse the redefinition still yield a perfectly usable File.
 */
export function attachRelativePath(file: File, relativePath: string): File {
  if (file.webkitRelativePath === relativePath) return file
  try {
    Object.defineProperty(file, "webkitRelativePath", { value: relativePath, configurable: true })
  } catch {
    /* best effort — the file itself is still uploadable */
  }
  return file
}

async function traverseEntry(entry: FileSystemEntryLike): Promise<DroppedFile[]> {
  if (entry.isFile) {
    return [await fileEntryToDroppedFile(entry as FileSystemFileEntryLike)]
  }
  if (entry.isDirectory) {
    const children = await readAllEntries((entry as FileSystemDirectoryEntryLike).createReader())
    const nested = await Promise.all(children.map(traverseEntry))
    return nested.flat()
  }
  return []
}

function fileEntryToDroppedFile(entry: FileSystemFileEntryLike): Promise<DroppedFile> {
  return new Promise((resolve, reject) => {
    entry.file(
      (file) => resolve({ file, relativePath: normalizeEntryPath(entry.fullPath, file.name) }),
      (error) => reject(error),
    )
  })
}

/**
 * Drain a directory reader. `readEntries` returns at most ~100 entries per
 * call and signals completion with an empty batch, so keep reading until it
 * reports done.
 */
function readAllEntries(reader: FileSystemDirectoryReaderLike): Promise<FileSystemEntryLike[]> {
  return new Promise((resolve, reject) => {
    const collected: FileSystemEntryLike[] = []
    const readBatch = (): void => {
      reader.readEntries(
        (batch) => {
          if (batch.length === 0) {
            resolve(collected)
            return
          }
          collected.push(...batch)
          readBatch()
        },
        (error) => reject(error),
      )
    }
    readBatch()
  })
}

/** "/research/notes.md" -> "research/notes.md" (backslashes normalised too). */
function normalizeEntryPath(fullPath: string | undefined, fallbackName: string): string {
  const raw = fullPath && fullPath.length > 0 ? fullPath : `/${fallbackName}`
  return raw.replace(/^\/+/, "").replace(/\\/g, "/")
}

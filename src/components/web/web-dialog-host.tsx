/**
 * Renders dialogs the web backend needs from the React tree: a server-side
 * folder picker (replacing the native directory chooser) and plain message
 * boxes. Mounted once in `main.tsx`; does nothing in the desktop app.
 */

import { useCallback, useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { ArrowUp, Folder, FolderPlus, Loader2, Upload } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { invoke } from "@/lib/backend"
import { pickAndUploadFiles } from "@/lib/backend/web"
import { useWebDialogStore } from "@/lib/backend/web-dialog-store"
import type { OpenDialogOptions } from "@/lib/backend/types"

interface DirListing {
  path: string
  parent: string | null
  entries: { name: string; path: string }[]
}

export function WebDialogHost() {
  const current = useWebDialogStore((state) => state.queue[0])
  const settle = useWebDialogStore((state) => state.settle)
  if (!current) return null

  if (current.request.kind === "message") {
    return (
      <MessageDialog
        key={current.id}
        text={current.request.text}
        title={current.request.title}
        onClose={() => settle(current.id, null)}
      />
    )
  }
  return (
    <DirectoryPicker
      key={current.id}
      options={current.request.options}
      onPick={(value) => settle(current.id, value)}
    />
  )
}

function MessageDialog({ text, title, onClose }: { text: string; title?: string; onClose: () => void }) {
  const { t } = useTranslation()
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{title ?? t("common.notice")}</DialogTitle>
          <DialogDescription className="whitespace-pre-wrap break-words">{text}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button onClick={onClose} autoFocus>
            {t("common.ok")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function DirectoryPicker({
  options,
  onPick,
}: {
  options: OpenDialogOptions
  onPick: (path: string | null) => void
}) {
  const { t } = useTranslation()
  const [listing, setListing] = useState<DirListing | null>(null)
  const [pathInput, setPathInput] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [newFolder, setNewFolder] = useState("")
  const [creating, setCreating] = useState(false)

  const load = useCallback(async (path?: string) => {
    setLoading(true)
    setError(null)
    try {
      const result = await invoke<DirListing>("web_list_dirs", { path: path ?? null })
      setListing(result)
      setPathInput(result.path)
    } catch (err) {
      setError(String(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load(options.defaultPath)
  }, [load, options.defaultPath])

  const createFolder = async () => {
    if (!listing || !newFolder.trim()) return
    const separator = listing.path.includes("\\") ? "\\" : "/"
    const target = `${listing.path.replace(/[\\/]+$/, "")}${separator}${newFolder.trim()}`
    setCreating(true)
    try {
      await invoke("create_directory", { path: target })
      setNewFolder("")
      await load(target)
    } catch (err) {
      setError(String(err))
    } finally {
      setCreating(false)
    }
  }

  const uploadFolder = async () => {
    const uploaded = await pickAndUploadFiles({ ...options, folder: true })
    if (uploaded && uploaded[0]) onPick(uploaded[0])
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onPick(null)}>
      <DialogContent className="sm:max-w-xl" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{options.title ?? t("web.pickFolder", { defaultValue: "Choose a folder on the server" })}</DialogTitle>
          <DialogDescription>
            {t("web.pickFolderHint", {
              defaultValue: "Browse the server's file system and choose a folder.",
            })}
          </DialogDescription>
        </DialogHeader>

        <div className="flex gap-2">
          <Input
            value={pathInput}
            onChange={(e) => setPathInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void load(pathInput)
            }}
            spellCheck={false}
          />
          <Button variant="outline" onClick={() => void load(pathInput)} disabled={loading}>
            {t("web.go", { defaultValue: "Go" })}
          </Button>
        </div>

        <div className="max-h-72 overflow-y-auto rounded-md border text-sm">
          {listing?.parent && (
            <button
              type="button"
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-accent"
              onClick={() => void load(listing.parent ?? undefined)}
            >
              <ArrowUp className="size-4 opacity-60" />
              ..
            </button>
          )}
          {loading && (
            <div className="flex items-center gap-2 px-3 py-2 text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              {t("common.loading", { defaultValue: "Loading…" })}
            </div>
          )}
          {!loading &&
            listing?.entries.map((entry) => (
              <button
                key={entry.path}
                type="button"
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-accent"
                onDoubleClick={() => onPick(entry.path)}
                onClick={() => void load(entry.path)}
              >
                <Folder className="size-4 opacity-60" />
                <span className="truncate">{entry.name}</span>
              </button>
            ))}
          {!loading && listing && listing.entries.length === 0 && (
            <div className="px-3 py-2 text-muted-foreground">
              {t("web.noSubfolders", { defaultValue: "No subfolders" })}
            </div>
          )}
          {error && <div className="px-3 py-2 text-destructive">{error}</div>}
        </div>

        <div className="flex gap-2">
          <Input
            placeholder={t("web.newFolderName", { defaultValue: "New folder name" })}
            value={newFolder}
            onChange={(e) => setNewFolder(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void createFolder()
            }}
          />
          <Button variant="outline" onClick={() => void createFolder()} disabled={creating || !newFolder.trim()}>
            <FolderPlus data-icon="inline-start" />
            {t("web.createFolder", { defaultValue: "Create" })}
          </Button>
        </div>

        <DialogFooter className="sm:justify-between">
          {options.allowUpload ? (
            <Button variant="ghost" onClick={() => void uploadFolder()}>
              <Upload data-icon="inline-start" />
              {t("web.uploadFolder", { defaultValue: "Upload a folder from this device" })}
            </Button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => onPick(null)}>
              {t("common.cancel")}
            </Button>
            <Button onClick={() => listing && onPick(listing.path)} disabled={!listing}>
              {t("web.selectThisFolder", { defaultValue: "Select this folder" })}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

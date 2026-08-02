import { useCallback, useState } from "react"
import { useTranslation } from "react-i18next"
import { open } from "@tauri-apps/plugin-dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Button } from "@/components/ui/button"
import { Folder, Play, Plus, RefreshCw, Trash2 } from "lucide-react"
import type { SettingsDraft, DraftSetter } from "../settings-types"
import { useWikiStore } from "@/stores/wiki-store"
import type { ScheduledImportDirectory } from "@/stores/wiki-store"
import {
  createScheduledImportDirectory,
  getScheduledImportPathIssue,
  requestScheduledImportScan,
} from "@/lib/scheduled-import"

interface Props {
  draft: SettingsDraft
  setDraft: DraftSetter
}

function displayTime(value: number | null, never: string): string {
  return value ? new Date(value).toLocaleString() : never
}

export function ScheduledImportSection({ draft, setDraft }: Props) {
  const { t } = useTranslation()
  const project = useWikiStore((s) => s.project)
  const scheduledImportConfig = useWikiStore((s) => s.scheduledImportConfig)
  const [scanningId, setScanningId] = useState<string | null>(null)
  const [addError, setAddError] = useState<string | null>(null)

  const updateDirectories = useCallback((directories: ScheduledImportDirectory[]) => {
    setAddError(null)
    setDraft("scheduledImportDirectories", directories)
  }, [setDraft])

  const handleAddDirectory = useCallback(async () => {
    if (!project) return
    const selected = await open({
      directory: true,
      title: t("settings.sections.scheduledImport.selectDirectory", {
        defaultValue: "Select Directory to Monitor",
      }),
    })
    if (!selected || typeof selected !== "string") return

    const issue = getScheduledImportPathIssue(project.path, selected, draft.scheduledImportDirectories)
    if (issue) {
      const messages: Record<string, string> = {
        "inside-project": "The selected folder is inside this project. Choose an external folder.",
        "contains-project": "The selected folder contains this project. Choose a different folder.",
        "duplicate-directory": "This folder is already being monitored.",
        "overlaps-directory": "This folder overlaps another monitored folder.",
      }
      setAddError(t("settings.sections.scheduledImport.directoryInvalid", {
        defaultValue: messages[issue],
      }))
      return
    }
    updateDirectories([
      ...draft.scheduledImportDirectories,
      createScheduledImportDirectory(selected, draft.scheduledImportDirectories),
    ])
  }, [project, t, draft.scheduledImportDirectories, updateDirectories])

  const handleManualScan = useCallback(async (directoryId?: string) => {
    if (!project || scanningId) return
    setScanningId(directoryId ?? "all")
    try {
      await requestScheduledImportScan(project, scheduledImportConfig, directoryId)
    } catch (error) {
      console.error("[scheduled-import] manual scan failed:", error)
    } finally {
      setScanningId(null)
    }
  }, [project, scheduledImportConfig, scanningId])

  const savedDirectoryById = new Map(scheduledImportConfig.directories.map((directory) => [directory.id, directory]))
  const enabledDirectories = draft.scheduledImportDirectories.filter((directory) => directory.enabled)
  const hasUnsavedDirectoryChanges = JSON.stringify(draft.scheduledImportDirectories) !== JSON.stringify(scheduledImportConfig.directories)
  const never = t("settings.sections.scheduledImport.never", { defaultValue: "Never" })

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold">
          {t("settings.sections.scheduledImport.title", { defaultValue: "Scheduled Import" })}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("settings.sections.scheduledImport.description", {
            defaultValue: "Monitor external directories and import new or modified files at regular intervals.",
          })}
        </p>
      </div>

      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={draft.scheduledImportEnabled}
          onChange={(event) => setDraft("scheduledImportEnabled", event.target.checked)}
          className="h-4 w-4"
        />
        <span className="text-sm">
          {t("settings.sections.scheduledImport.enable", { defaultValue: "Enable scheduled import" })}
        </span>
      </label>

      {draft.scheduledImportEnabled && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-200">
          {t("settings.sections.scheduledImport.privacyNotice", {
            defaultValue: "Files are copied into this project before ingest. Removed source files are not automatically deleted from the project.",
          })}
        </div>
      )}

      <div className="space-y-2">
        <div className="flex items-center justify-between gap-3">
          <Label>{t("settings.sections.scheduledImport.directory", { defaultValue: "Monitor Directories" })}</Label>
          <Button variant="outline" size="sm" onClick={handleAddDirectory} disabled={!project}>
            <Plus className="mr-2 h-4 w-4" />
            {t("settings.sections.scheduledImport.addDirectory", { defaultValue: "Add directory" })}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          {t("settings.sections.scheduledImport.directoryHelp", {
            defaultValue: "Choose external folders outside this LLM Wiki project. Overlapping folders are not allowed.",
          })}
        </p>
        {addError && <p className="text-xs text-destructive">{addError}</p>}
        {draft.scheduledImportDirectories.length === 0 ? (
          <div className="rounded-md border border-dashed px-3 py-4 text-sm text-muted-foreground">
            {t("settings.sections.scheduledImport.noDirectories", { defaultValue: "No external directories selected." })}
          </div>
        ) : (
          <div className="space-y-2">
            {draft.scheduledImportDirectories.map((directory) => {
              const saved = savedDirectoryById.get(directory.id)
              const isScanning = scanningId === directory.id || scanningId === "all"
              return (
                <div key={directory.id} className="rounded-md border px-3 py-3">
                  <div className="flex items-start gap-3">
                    <input
                      type="checkbox"
                      checked={directory.enabled}
                      onChange={(event) => updateDirectories(draft.scheduledImportDirectories.map((item) =>
                        item.id === directory.id ? { ...item, enabled: event.target.checked } : item,
                      ))}
                      className="mt-1 h-4 w-4"
                      aria-label={t("settings.sections.scheduledImport.enableDirectory", { defaultValue: "Enable directory" })}
                    />
                    <Folder className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium">{directory.name}</div>
                      <div className="truncate text-xs text-muted-foreground" title={directory.path}>{directory.path}</div>
                      <div className="mt-1 text-xs text-muted-foreground">
                        {t("settings.sections.scheduledImport.lastScan", {
                          defaultValue: "Last scan: {{time}}",
                          time: displayTime(saved?.lastScan ?? directory.lastScan, never),
                        })}
                        {saved?.lastError && <span className="ml-2 text-destructive">{saved.lastError}</span>}
                      </div>
                    </div>
                    <Button variant="ghost" size="icon" onClick={() => void handleManualScan(directory.id)} disabled={!directory.enabled || isScanning || hasUnsavedDirectoryChanges} title={t("settings.sections.scheduledImport.scanNow", { defaultValue: "Scan now" })}>
                      {isScanning ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
                    </Button>
                    <Button variant="ghost" size="icon" onClick={() => updateDirectories(draft.scheduledImportDirectories.filter((item) => item.id !== directory.id))} title={t("settings.sections.scheduledImport.removeDirectory", { defaultValue: "Remove directory" })}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      <div className="space-y-2">
        <Label htmlFor="scheduled-import-interval">
          {t("settings.sections.scheduledImport.interval", { defaultValue: "Scan Interval (minutes)" })}
        </Label>
        <Input id="scheduled-import-interval" type="number" min={1} max={1440} value={draft.scheduledImportInterval} onChange={(event) => {
          const value = Number.parseInt(event.target.value, 10)
          if (!Number.isNaN(value) && value >= 1) setDraft("scheduledImportInterval", value)
        }} className="w-32" />
        <p className="text-xs text-muted-foreground">
          {t("settings.sections.scheduledImport.intervalHelp", { defaultValue: "One project-level scheduler scans all enabled directories. Minimum: 1 minute." })}
        </p>
      </div>

      <Button variant="outline" size="sm" onClick={() => void handleManualScan()} disabled={!project || enabledDirectories.length === 0 || scanningId !== null || hasUnsavedDirectoryChanges}>
        {scanningId === "all" ? <RefreshCw className="mr-2 h-4 w-4 animate-spin" /> : <Play className="mr-2 h-4 w-4" />}
        {scanningId === "all"
          ? t("settings.sections.scheduledImport.scanning", { defaultValue: "Scanning..." })
          : t("settings.sections.scheduledImport.scanAll", { defaultValue: "Scan all now" })}
      </Button>
      {hasUnsavedDirectoryChanges && (
        <p className="text-xs text-muted-foreground">
          {t("settings.sections.scheduledImport.saveBeforeScan", { defaultValue: "Save directory changes before scanning." })}
        </p>
      )}
    </div>
  )
}

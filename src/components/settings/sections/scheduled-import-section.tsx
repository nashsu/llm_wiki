import { useState, useCallback } from "react"
import { useTranslation } from "react-i18next"
import { open } from "@tauri-apps/plugin-dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Button } from "@/components/ui/button"
import { Folder, Play, RefreshCw } from "lucide-react"
import type { SettingsDraft, DraftSetter } from "../settings-types"
import { useWikiStore } from "@/stores/wiki-store"
import {
  isProjectManagedScheduledImportPath,
  resolveImportPath,
  scanAndImport,
} from "@/lib/scheduled-import"

interface Props {
  draft: SettingsDraft
  setDraft: DraftSetter
}

export function ScheduledImportSection({ draft, setDraft }: Props) {
  const { t } = useTranslation()
  const project = useWikiStore((s) => s.project)
  const scheduledImportConfig = useWikiStore((s) => s.scheduledImportConfig)
  const [isScanning, setIsScanning] = useState(false)

  const handleSelectDirectory = async () => {
    const selected = await open({
      directory: true,
      title: t("settings.sections.scheduledImport.selectDirectory", {
        defaultValue: "Select Directory to Monitor",
      }),
    })

    if (selected && typeof selected === "string") {
      setDraft("scheduledImportPath", selected)
    }
  }

  const handleManualScan = useCallback(async () => {
    if (!project || isScanning) return

    setIsScanning(true)
    try {
      await scanAndImport(project, draft.scheduledImportPath)
    } catch (err) {
      console.error("[Scheduled Import] Manual scan failed:", err)
    } finally {
      setIsScanning(false)
    }
  }, [project, draft.scheduledImportPath, isScanning])

  const lastScanDate = scheduledImportConfig.lastScan
    ? new Date(scheduledImportConfig.lastScan).toLocaleString()
    : t("settings.sections.scheduledImport.never", { defaultValue: "Never" })
  const managedPathSelected = Boolean(
    project &&
    draft.scheduledImportPath &&
    isProjectManagedScheduledImportPath(
      project.path,
      resolveImportPath(project.path, draft.scheduledImportPath),
    ),
  )

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold">
          {t("settings.sections.scheduledImport.title", {
            defaultValue: "Scheduled Import",
          })}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("settings.sections.scheduledImport.description", {
            defaultValue:
              "Automatically monitor a directory and import new or modified files at regular intervals.",
          })}
        </p>
      </div>

      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={draft.scheduledImportEnabled}
          onChange={(e) => setDraft("scheduledImportEnabled", e.target.checked)}
          className="h-4 w-4"
        />
        <span className="text-sm">
          {t("settings.sections.scheduledImport.enable", {
            defaultValue: "Enable scheduled import",
          })}
        </span>
      </label>

      {draft.scheduledImportEnabled && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-200">
          {t("settings.sections.scheduledImport.privacyNotice", {
            defaultValue:
              "Files from the selected directory may be copied into this project and sent to your configured LLM during ingest. Removed files are not automatically deleted from the project.",
          })}
        </div>
      )}

      <div className="space-y-2">
        <Label>
          {t("settings.sections.scheduledImport.directory", {
            defaultValue: "Monitor Directory",
          })}
        </Label>
        <div className="flex gap-2">
          <Input
            value={draft.scheduledImportPath}
            onChange={(e) => setDraft("scheduledImportPath", e.target.value)}
            placeholder="raw/sources"
            disabled={!draft.scheduledImportEnabled}
            className="flex-1"
          />
          <Button
            variant="outline"
            size="icon"
            onClick={handleSelectDirectory}
            disabled={!draft.scheduledImportEnabled}
            title={t("settings.sections.scheduledImport.browse", {
              defaultValue: "Browse",
            })}
          >
            <Folder className="h-4 w-4" />
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          {t("settings.sections.scheduledImport.directoryHelp", {
            defaultValue:
              "Choose an external folder outside the current LLM Wiki project. Project folders are already handled by source folder monitoring.",
          })}
        </p>
        {managedPathSelected && (
          <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-200">
            {t("settings.sections.scheduledImport.managedPathWarning", {
              defaultValue:
                "This path is inside the current LLM Wiki project and is already managed by source folder monitoring. Pick an external folder to avoid duplicate scans.",
            })}
          </p>
        )}
      </div>

      <div className="space-y-2">
        <Label htmlFor="scheduled-import-interval">
          {t("settings.sections.scheduledImport.interval", {
            defaultValue: "Scan Interval (minutes)",
          })}
        </Label>
        <Input
          id="scheduled-import-interval"
          type="number"
          min={1}
          max={1440}
          value={draft.scheduledImportInterval}
          onChange={(e) => {
            const val = parseInt(e.target.value, 10)
            if (!isNaN(val) && val >= 1) {
              setDraft("scheduledImportInterval", val)
            }
          }}
          disabled={!draft.scheduledImportEnabled}
          className="w-32"
        />
        <p className="text-xs text-muted-foreground">
          {t("settings.sections.scheduledImport.intervalHelp", {
            defaultValue: "How often to check for changes. Minimum: 1 minute.",
          })}
        </p>
      </div>

      <div className="flex items-center gap-4">
        <Button
          variant="outline"
          size="sm"
          onClick={handleManualScan}
          disabled={!draft.scheduledImportEnabled || !draft.scheduledImportPath || managedPathSelected || isScanning}
        >
          {isScanning ? (
            <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <Play className="mr-2 h-4 w-4" />
          )}
          {isScanning
            ? t("settings.sections.scheduledImport.scanning", { defaultValue: "Scanning..." })
            : t("settings.sections.scheduledImport.scanNow", { defaultValue: "Scan Now" })}
        </Button>

        <span className="text-xs text-muted-foreground">
          {t("settings.sections.scheduledImport.lastScan", {
            defaultValue: "Last scan: {{time}}",
            time: lastScanDate,
          })}
        </span>
      </div>
    </div>
  )
}

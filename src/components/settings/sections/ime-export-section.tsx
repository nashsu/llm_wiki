import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Download, Folder, Play, RefreshCw } from "lucide-react"
import { openUrl } from "@tauri-apps/plugin-opener"
import type { SettingsDraft, DraftSetter } from "../settings-types"
import { useWikiStore } from "@/stores/wiki-store"
import { exportWikiDict, qingjianDictTarget } from "@/lib/wiki-dict-export"
import { revealInFileManager } from "@/commands/fs"

const QINGJIAN_DRIVE_URL =
  "https://drive.cvte.com/d/home#/sandbox/96c/2f0fb0aa7790023d/%2F4.%E8%BD%AF%E4%BB%B6%2FMCU%E7%BB%84%2F2.%E5%B7%A5%E5%85%B7%2F%E9%9D%92%E7%AE%80%E8%BE%93%E5%85%A5%E6%B3%95/"
const QINGJIAN_GITHUB_URL =
  "https://github.com/qingjian-team/qingjian/releases/tag/v0.1.4"

interface Props {
  draft: SettingsDraft
  setDraft: DraftSetter
}

export function ImeExportSection({ draft, setDraft }: Props) {
  const { t } = useTranslation()
  const project = useWikiStore((s) => s.project)
  const [targetPath, setTargetPath] = useState<string | null>(null)
  const [exporting, setExporting] = useState(false)
  const [result, setResult] = useState<{ entries: number } | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    qingjianDictTarget()
      .then(setTargetPath)
      .catch(() => setTargetPath(null))
  }, [])

  const handleExport = async () => {
    if (!project || exporting) return
    setExporting(true)
    setError(null)
    setResult(null)
    try {
      const r = await exportWikiDict(project.path)
      setResult({ entries: r.entries })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setExporting(false)
    }
  }

  const openTarget = async () => {
    if (!targetPath) return
    try {
      await revealInFileManager(targetPath)
    } catch (err) {
      console.warn("[ime-export] failed to open dict dir:", err)
    }
  }

  const openChannel = async (url: string) => {
    try {
      await openUrl(url)
    } catch (err) {
      console.warn("[ime-export] failed to open download page:", err)
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold">
          {t("settings.sections.imeExport.title")}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("settings.sections.imeExport.description")}
        </p>
      </div>

      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={draft.wikiDictEnabled}
          onChange={(e) => setDraft("wikiDictEnabled", e.target.checked)}
          className="h-4 w-4"
        />
        <span className="text-sm">
          {t("settings.sections.imeExport.enable")}
        </span>
      </label>

      <div className="space-y-2">
        <Label>{t("settings.sections.imeExport.target")}</Label>
        <div className="flex items-center gap-2">
          <code className="flex-1 truncate rounded-md border bg-muted/50 px-3 py-2 text-xs">
            {targetPath ?? t("settings.sections.imeExport.targetUnavailable")}
          </code>
          <Button
            variant="outline"
            size="icon"
            onClick={openTarget}
            disabled={!targetPath}
            title={t("settings.sections.imeExport.openFolder")}
          >
            <Folder className="h-4 w-4" />
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          {t("settings.sections.imeExport.targetHelp")}
        </p>
      </div>

      <div className="flex items-center gap-4">
        <Button
          variant="outline"
          size="sm"
          onClick={handleExport}
          disabled={!project || exporting}
        >
          {exporting ? (
            <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <Play className="mr-2 h-4 w-4" />
          )}
          {exporting
            ? t("settings.sections.imeExport.exporting")
            : t("settings.sections.imeExport.exportNow")}
        </Button>
        {result && (
          <span className="text-xs text-muted-foreground">
            {t("settings.sections.imeExport.exported", { count: result.entries })}
          </span>
        )}
        {error && <span className="text-xs text-destructive">{error}</span>}
      </div>

      <div className="space-y-2">
        <Label>{t("settings.sections.imeExport.downloadQingjian")}</Label>
        {[
          {
            label: t("settings.sections.imeExport.downloadInternal"),
            url: QINGJIAN_DRIVE_URL,
          },
          {
            label: t("settings.sections.imeExport.downloadGithub"),
            url: QINGJIAN_GITHUB_URL,
          },
        ].map((channel) => (
          <div key={channel.url} className="space-y-1">
            <Button
              variant="link"
              size="sm"
              className="h-auto p-0"
              onClick={() => void openChannel(channel.url)}
            >
              <Download className="mr-1 h-3.5 w-3.5" />
              {channel.label}
            </Button>
            <code className="block w-full select-all break-all rounded-md border bg-muted/50 px-2 py-1 text-xs leading-relaxed">
              {channel.url}
            </code>
          </div>
        ))}
      </div>
    </div>
  )
}

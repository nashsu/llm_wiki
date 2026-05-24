import { useState } from "react"
import { Download, FileText, Loader2 } from "lucide-react"
import { open } from "@tauri-apps/plugin-dialog"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import { useWikiStore } from "@/stores/wiki-store"
import { exportAsMarkdownSite } from "@/lib/export"

export function ExportSection() {
  const { t } = useTranslation()
  const project = useWikiStore((s) => s.project)
  const [exporting, setExporting] = useState<"markdown" | "pdf" | null>(null)
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null)

  async function handleMarkdownExport() {
    if (!project) return
    setExporting("markdown")
    setMessage(null)
    try {
      const outputDir = await open({
        directory: true,
        multiple: false,
        title: t("settings.sections.export.selectOutputDir"),
      })
      if (!outputDir) {
        setExporting(null)
        return
      }
      await exportAsMarkdownSite(project.path, outputDir)
      setMessage({ type: "success", text: t("settings.sections.export.markdownSuccess") })
    } catch (err) {
      setMessage({ type: "error", text: String(err) })
    } finally {
      setExporting(null)
    }
  }

  async function handlePdfExport() {
    if (!project) return
    setExporting("pdf")
    setMessage(null)
    try {
      const { exportAsPdf } = await import("@/lib/export")
      await exportAsPdf(project.path, [])
      setMessage({ type: "success", text: t("settings.sections.export.pdfSuccess") })
    } catch (err) {
      setMessage({ type: "error", text: String(err) })
    } finally {
      setExporting(null)
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-sm font-medium">{t("settings.sections.export.title")}</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          {t("settings.sections.export.description")}
        </p>
      </div>

      <div className="space-y-4">
        <div className="flex items-start justify-between rounded-lg border p-4">
          <div className="flex items-start gap-3">
            <FileText className="mt-0.5 h-5 w-5 text-muted-foreground" />
            <div>
              <p className="text-sm font-medium">{t("settings.sections.export.markdownTitle")}</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {t("settings.sections.export.markdownDescription")}
              </p>
            </div>
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={handleMarkdownExport}
            disabled={exporting !== null}
          >
            {exporting === "markdown" ? (
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            ) : (
              <Download className="mr-1.5 h-3.5 w-3.5" />
            )}
            {t("settings.sections.export.exportButton")}
          </Button>
        </div>

        <div className="flex items-start justify-between rounded-lg border p-4">
          <div className="flex items-start gap-3">
            <FileText className="mt-0.5 h-5 w-5 text-muted-foreground" />
            <div>
              <p className="text-sm font-medium">{t("settings.sections.export.pdfTitle")}</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {t("settings.sections.export.pdfDescription")}
              </p>
            </div>
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={handlePdfExport}
            disabled={exporting !== null}
          >
            {exporting === "pdf" ? (
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            ) : (
              <Download className="mr-1.5 h-3.5 w-3.5" />
            )}
            {t("settings.sections.export.exportButton")}
          </Button>
        </div>
      </div>

      {message && (
        <p className={`text-xs ${message.type === "success" ? "text-emerald-600" : "text-destructive"}`}>
          {message.text}
        </p>
      )}
    </div>
  )
}

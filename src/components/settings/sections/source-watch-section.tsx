import { useEffect, useMemo, useState } from "react"
import { FolderSync, ShieldAlert } from "lucide-react"
import { useTranslation } from "react-i18next"
import type { SettingsDraft, DraftSetter } from "../settings-types"
import {
  normalizeSourceWatchConfig,
  SOURCE_WATCH_FILE_TYPE_GROUPS,
} from "@/lib/source-watch-config"

interface Props {
  draft: SettingsDraft
  setDraft: DraftSetter
  projectReady: boolean
}

function updateListValue(value: string): string[] {
  return value
    .split(/[,\n]/)
    .map((item) => item.trim())
    .filter(Boolean)
}

function joinList(values: readonly string[]): string {
  return values.join(", ")
}

export function SourceWatchSection({ draft, setDraft, projectReady }: Props) {
  const { t } = useTranslation()
  const config = normalizeSourceWatchConfig(draft.sourceWatchConfig)
  const selected = useMemo(() => new Set(config.includeExtensions), [config.includeExtensions])
  const [editingList, setEditingList] = useState<"dirs" | "extensions" | "globs" | null>(null)
  const [excludeDirsText, setExcludeDirsText] = useState(() => joinList(config.excludeDirs))
  const [excludeExtensionsText, setExcludeExtensionsText] = useState(() => joinList(config.excludeExtensions))
  const [excludeGlobsText, setExcludeGlobsText] = useState(() => joinList(config.excludeGlobs))
  const excludeDirsKey = config.excludeDirs.join("\0")
  const excludeExtensionsKey = config.excludeExtensions.join("\0")
  const excludeGlobsKey = config.excludeGlobs.join("\0")

  useEffect(() => {
    if (editingList !== "dirs") setExcludeDirsText(joinList(config.excludeDirs))
    if (editingList !== "extensions") setExcludeExtensionsText(joinList(config.excludeExtensions))
    if (editingList !== "globs") setExcludeGlobsText(joinList(config.excludeGlobs))
  }, [editingList, excludeDirsKey, excludeExtensionsKey, excludeGlobsKey])

  const updateConfig = (patch: Partial<typeof config>) => {
    setDraft("sourceWatchConfig", normalizeSourceWatchConfig({ ...config, ...patch }))
  }

  const finishListEdit = (field: "dirs" | "extensions" | "globs", value: string) => {
    const normalized = normalizeSourceWatchConfig({
      ...config,
      ...(field === "dirs" ? { excludeDirs: updateListValue(value) } : {}),
      ...(field === "extensions" ? { excludeExtensions: updateListValue(value) } : {}),
      ...(field === "globs" ? { excludeGlobs: updateListValue(value) } : {}),
    })
    setEditingList(null)
    if (field === "dirs") setExcludeDirsText(joinList(normalized.excludeDirs))
    if (field === "extensions") setExcludeExtensionsText(joinList(normalized.excludeExtensions))
    if (field === "globs") setExcludeGlobsText(joinList(normalized.excludeGlobs))
  }

  const toggleExtension = (ext: string, checked: boolean) => {
    const next = new Set(config.includeExtensions)
    if (checked) {
      next.add(ext)
    } else {
      next.delete(ext)
    }
    updateConfig({ includeExtensions: [...next].sort() })
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold">
          {t("settings.sections.sourceWatch.title", { defaultValue: "Source Folder Auto Watch" })}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("settings.sections.sourceWatch.description", {
            defaultValue:
              "Monitor raw/sources for external changes and choose which files are allowed into automatic ingest.",
          })}
        </p>
      </div>

      <div className="space-y-4 rounded-lg border border-border/60 bg-muted/20 p-4">
        <label className="flex items-start gap-3">
          <input
            type="checkbox"
            checked={config.enabled}
            onChange={(event) => updateConfig({ enabled: event.target.checked })}
            disabled={!projectReady}
            className="mt-1 h-4 w-4"
          />
          <div className="space-y-1">
            <div className="flex items-center gap-2 text-sm font-semibold">
              <FolderSync className="h-4 w-4 text-muted-foreground" />
              {t("settings.sections.sourceWatch.enable", { defaultValue: "Monitor project source folder" })}
            </div>
            <p className="text-xs leading-relaxed text-muted-foreground">
              {t("settings.sections.sourceWatch.enableDescription", {
                defaultValue:
                  "Refreshes the Sources view and indexes allowed new or modified files under raw/sources.",
              })}
            </p>
          </div>
        </label>

        <label className="flex items-start gap-3">
          <input
            type="checkbox"
            checked={config.autoIngest}
            onChange={(event) => updateConfig({ autoIngest: event.target.checked })}
            disabled={!projectReady || !config.enabled}
            className="mt-1 h-4 w-4"
          />
          <div className="space-y-1">
            <span className="text-sm font-semibold">
              {t("settings.sections.sourceWatch.autoIngest", { defaultValue: "Auto-ingest allowed source files" })}
            </span>
            <p className="text-xs leading-relaxed text-muted-foreground">
              {t("settings.sections.sourceWatch.autoIngestDescription", {
                defaultValue:
                  "When disabled, external changes still refresh the file tree but do not create ingest tasks.",
              })}
            </p>
          </div>
        </label>

        {!projectReady && (
          <p className="text-xs text-muted-foreground">
            {t("settings.sections.sourceWatch.noProject", {
              defaultValue: "Open a project to change this project-level setting.",
            })}
          </p>
        )}
      </div>

      <div className="space-y-4 rounded-lg border border-border/60 bg-muted/20 p-4">
        <div>
          <h3 className="text-sm font-semibold">
            {t("settings.sections.sourceWatch.fileTypes", { defaultValue: "Allowed file types" })}
          </h3>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            {t("settings.sections.sourceWatch.fileTypesDescription", {
              defaultValue:
                "Document types are enabled by default. Media, binaries, source code, and config-like formats stay off unless selected.",
            })}
          </p>
        </div>

        <div className="space-y-4">
          {SOURCE_WATCH_FILE_TYPE_GROUPS.map((group) => (
            <div key={group.id} className="space-y-2">
              <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {t(`settings.sections.sourceWatch.groups.${group.id}`, { defaultValue: group.id })}
              </div>
              <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
                {group.extensions.map((ext) => (
                  <label
                    key={ext}
                    className="flex items-center gap-2 rounded-md border border-border/60 bg-background px-2 py-1.5 text-xs"
                  >
                    <input
                      type="checkbox"
                      checked={selected.has(ext)}
                      onChange={(event) => toggleExtension(ext, event.target.checked)}
                      disabled={!projectReady || !config.enabled}
                      className="h-3.5 w-3.5"
                    />
                    <span>.{ext}</span>
                  </label>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="space-y-4 rounded-lg border border-border/60 bg-muted/20 p-4">
        <div className="flex items-center gap-2">
          <ShieldAlert className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-sm font-semibold">
            {t("settings.sections.sourceWatch.exclusions", { defaultValue: "Exclusions and limits" })}
          </h3>
        </div>

        <label className="block space-y-1.5">
          <span className="text-xs font-medium">
            {t("settings.sections.sourceWatch.maxSize", { defaultValue: "Maximum auto-ingest file size (MB)" })}
          </span>
          <input
            type="number"
            min={1}
            max={4096}
            value={config.maxFileSizeMb}
            onChange={(event) => updateConfig({ maxFileSizeMb: Number(event.target.value) || 1 })}
            disabled={!projectReady || !config.enabled}
            className="w-32 rounded-md border border-input bg-background px-2 py-1 text-sm"
          />
        </label>

        <label className="block space-y-1.5">
          <span className="text-xs font-medium">
            {t("settings.sections.sourceWatch.excludeDirs", { defaultValue: "Excluded folders" })}
          </span>
          <textarea
            value={excludeDirsText}
            onFocus={() => setEditingList("dirs")}
            onChange={(event) => {
              setExcludeDirsText(event.target.value)
              updateConfig({ excludeDirs: updateListValue(event.target.value) })
            }}
            onBlur={() => finishListEdit("dirs", excludeDirsText)}
            placeholder={t("settings.sections.sourceWatch.excludeDirsPlaceholder", {
              defaultValue: ".git, node_modules, drafts, subdir/drafts",
            })}
            disabled={!projectReady || !config.enabled}
            rows={2}
            className="w-full rounded-md border border-input bg-background px-2 py-1 text-sm"
          />
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            {t("settings.sections.sourceWatch.excludeDirsHint", {
              defaultValue: "Folder names match any path segment. Paths such as subdir/drafts match that nested folder.",
            })}
          </p>
        </label>

        <label className="block space-y-1.5">
          <span className="text-xs font-medium">
            {t("settings.sections.sourceWatch.excludeExtensions", { defaultValue: "Excluded file extensions" })}
          </span>
          <textarea
            value={excludeExtensionsText}
            onFocus={() => setEditingList("extensions")}
            onChange={(event) => {
              setExcludeExtensionsText(event.target.value)
              updateConfig({ excludeExtensions: updateListValue(event.target.value) })
            }}
            onBlur={() => finishListEdit("extensions", excludeExtensionsText)}
            placeholder={t("settings.sections.sourceWatch.excludeExtensionsPlaceholder", {
              defaultValue: "tmp, bak, exe, dll, iso, dmg",
            })}
            disabled={!projectReady || !config.enabled}
            rows={2}
            className="w-full rounded-md border border-input bg-background px-2 py-1 text-sm"
          />
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            {t("settings.sections.sourceWatch.excludeExtensionsHint", {
              defaultValue: "Use extensions without dots. These override the allowed file type checkboxes.",
            })}
          </p>
        </label>

        <label className="block space-y-1.5">
          <span className="text-xs font-medium">
            {t("settings.sections.sourceWatch.excludeGlobs", { defaultValue: "Excluded filename patterns" })}
          </span>
          <textarea
            value={excludeGlobsText}
            onFocus={() => setEditingList("globs")}
            onChange={(event) => {
              setExcludeGlobsText(event.target.value)
              updateConfig({ excludeGlobs: updateListValue(event.target.value) })
            }}
            onBlur={() => finishListEdit("globs", excludeGlobsText)}
            disabled={!projectReady || !config.enabled}
            rows={2}
            className="w-full rounded-md border border-input bg-background px-2 py-1 text-sm"
          />
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            {t("settings.sections.sourceWatch.excludeGlobsHint", {
              defaultValue: "Use comma-separated patterns such as *.draft.*, ~$*, .~lock.*#.",
            })}
          </p>
        </label>
      </div>
    </div>
  )
}

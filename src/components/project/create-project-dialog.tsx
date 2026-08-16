import { useState } from "react"
import { useTranslation } from "react-i18next"
import { open } from "@tauri-apps/plugin-dialog"
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { FolderOpen } from "lucide-react"
import { createProject, writeFile, createDirectory } from "@/commands/fs"
import { getTemplate } from "@/lib/templates"
import { TemplatePicker } from "@/components/project/template-picker"
import type { WikiProject } from "@/types/wiki"
import { normalizePath } from "@/lib/path-utils"
import { OUTPUT_LANGUAGE_OPTIONS } from "@/lib/output-language-options"
import { useWikiStore, type OutputLanguage } from "@/stores/wiki-store"
import { saveOutputLanguage } from "@/lib/project-store"

interface CreateProjectDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: (project: WikiProject) => void
}

export interface CreateProjectFormStatus {
  missingRequired: boolean
  canCreate: boolean
  footerMessageKey: string | null
  footerError: string
}

export function getCreateProjectFormStatus(
  name: string,
  path: string,
  language: string,
  error: string,
  hasInteracted: boolean,
): CreateProjectFormStatus {
  const missingRequired = !name.trim() || !path.trim() || !language
  return {
    missingRequired,
    canCreate: !missingRequired,
    footerError: error,
    footerMessageKey: !error && hasInteracted && missingRequired ? "project.requiredHint" : null,
  }
}

export function CreateProjectDialog({ open: isOpen, onOpenChange, onCreated }: CreateProjectDialogProps) {
  const { t } = useTranslation()
  const [name, setName] = useState("")
  const [path, setPath] = useState("")
  const [selectedTemplate, setSelectedTemplate] = useState("general")
  // Empty string = "user hasn't picked yet"; we validate this on
  // submit so a fresh project never starts in implicit auto-detect
  // mode. Once chosen, the value is one of OUTPUT_LANGUAGE_OPTIONS
  // (`auto` is a valid explicit choice — the user is then opting
  // INTO auto-detect rather than getting it by accident).
  const [language, setLanguage] = useState<string>("")
  const [error, setError] = useState("")
  const [hasInteracted, setHasInteracted] = useState(false)
  const [creating, setCreating] = useState(false)
  const setOutputLanguage = useWikiStore((s) => s.setOutputLanguage)
  const formStatus = getCreateProjectFormStatus(name, path, language, error, hasInteracted)

  function markEdited() {
    setHasInteracted(true)
    setError("")
  }

  function resetForm() {
    setName("")
    setPath("")
    setSelectedTemplate("general")
    setLanguage("")
    setError("")
    setHasInteracted(false)
  }

  function handleOpenChange(nextOpen: boolean) {
    if (!nextOpen) {
      resetForm()
    }
    onOpenChange(nextOpen)
  }

  async function handleBrowse() {
    const selected = await open({
      directory: true,
      multiple: false,
      title: t("project.browse"),
    })
    if (selected) {
      markEdited()
      setPath(selected)
    }
  }

  async function handleCreate() {
    // Keep these guards even though the button is disabled in normal UI use:
    // keyboard/event edge cases and future callers should still fail clearly.
    if (!name.trim() || !path.trim()) {
      setError(t("project.errorNameRequired"))
      setHasInteracted(true)
      return
    }
    if (!language) {
      setError(t("project.errorLanguageRequired"))
      setHasInteracted(true)
      return
    }
    setCreating(true)
    setError("")
    try {
      const project = await createProject(name.trim(), path.trim())
      const pp = normalizePath(project.path)

      const template = getTemplate(selectedTemplate)
      await writeFile(`${pp}/schema.md`, template.schema)
      await writeFile(`${pp}/purpose.md`, template.purpose)
      for (const dir of template.extraDirs) {
        await createDirectory(`${pp}/${dir}`)
      }

      // Persist the user's language choice. The store / disk
      // mirror is what the rest of the app reads via
      // `getOutputLanguage()` — without this write the choice
      // wouldn't survive past the dialog closing.
      const lang = language as OutputLanguage
      setOutputLanguage(lang)
      await saveOutputLanguage(lang, project.id)

      onCreated(project)
      handleOpenChange(false)
    } catch (err) {
      setError(String(err))
    } finally {
      setCreating(false)
    }
  }

  return (
    <Dialog open={isOpen} onOpenChange={handleOpenChange}>
      <DialogContent className="grid max-h-[calc(100vh-1rem)] w-[calc(100vw-1rem)] max-w-lg grid-rows-[auto_minmax(0,1fr)_auto] gap-0 overflow-hidden p-0 sm:max-h-[calc(100vh-2rem)] sm:w-full sm:max-w-lg">
        <DialogHeader className="shrink-0 border-b px-4 py-3 pr-12 sm:px-6 sm:py-4">
          <DialogTitle>{t("project.createTitle")}</DialogTitle>
        </DialogHeader>
        <div className="min-h-0 overscroll-contain overflow-y-auto px-4 py-4 [scrollbar-gutter:stable] sm:px-6">
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="name">
                {t("project.name")} <span className="text-destructive">{t("project.requiredMarker")}</span>
              </Label>
              <Input
                id="name"
                value={name}
                onChange={(e) => {
                  markEdited()
                  setName(e.target.value)
                }}
                placeholder={t("project.namePlaceholder")}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="language">
                {t("project.aiOutputLanguage")} <span className="text-destructive">{t("project.requiredMarker")}</span>
              </Label>
              <select
                id="language"
                value={language}
                onChange={(e) => {
                  markEdited()
                  setLanguage(e.target.value)
                }}
                className="w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              >
                <option value="" disabled>
                  {t("project.pickLanguage")}
                </option>
                {OUTPUT_LANGUAGE_OPTIONS.filter((l) => l.value !== "auto").map((l) => (
                  <option key={l.value} value={l.value}>
                    {l.label}
                  </option>
                ))}
              </select>
              <p className="text-xs text-muted-foreground">
                {t("project.aiOutputLanguageHint")}
              </p>
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="path">
                {t("project.parentDir")} <span className="text-destructive">{t("project.requiredMarker")}</span>
              </Label>
              <div className="flex gap-2">
                <Input
                  id="path"
                  value={path}
                  onChange={(e) => {
                    markEdited()
                    setPath(e.target.value)
                  }}
                  placeholder={t("project.parentDirPlaceholder")}
                  className="min-w-0 flex-1"
                />
                <Button variant="outline" size="icon" onClick={handleBrowse} type="button">
                  <FolderOpen className="h-4 w-4" />
                </Button>
              </div>
            </div>
            <div className="flex flex-col gap-2">
              <Label>{t("project.template")}</Label>
              <TemplatePicker selected={selectedTemplate} onSelect={setSelectedTemplate} />
            </div>
          </div>
        </div>
        <DialogFooter className="mx-0 mb-0 shrink-0 flex-col gap-2 rounded-none border-t bg-background px-4 py-3 sm:flex-row sm:items-center sm:px-6">
          <div className="min-h-5 min-w-0 flex-1 break-words text-left text-xs text-destructive sm:text-sm">
            {formStatus.footerError || (formStatus.footerMessageKey ? t(formStatus.footerMessageKey) : "")}
          </div>
          <div className="flex shrink-0 justify-end gap-2">
            <Button variant="outline" onClick={() => handleOpenChange(false)}>{t("project.cancel")}</Button>
            <Button onClick={handleCreate} disabled={creating || !formStatus.canCreate}>{creating ? t("project.creating") : t("project.create")}</Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

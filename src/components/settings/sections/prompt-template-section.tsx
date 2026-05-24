import { useState, useEffect, useCallback } from "react"
import { useTranslation } from "react-i18next"
import { Label } from "@/components/ui/label"
import { Button } from "@/components/ui/button"
import { BUILTIN_TEMPLATES, getTemplate } from "@/lib/prompt-templates"
import { useWikiStore } from "@/stores/wiki-store"
import { savePromptConfig } from "@/lib/project-store"

export function PromptTemplateSection() {
  const { t } = useTranslation()
  const activePromptTemplate = useWikiStore((s) => s.activePromptTemplate)
  const customPromptTemplates = useWikiStore((s) => s.customPromptTemplates)
  const setActivePromptTemplate = useWikiStore((s) => s.setActivePromptTemplate)
  const setCustomPromptTemplates = useWikiStore((s) => s.setCustomPromptTemplates)

  const [saved, setSaved] = useState(false)
  const [localActiveId, setLocalActiveId] = useState<string | null>(activePromptTemplate)
  const [editText, setEditText] = useState("")
  const [editName, setEditName] = useState("")

  // Resolve the prompt text for the currently selected template
  const resolvePromptText = useCallback(
    (id: string | null): string => {
      if (!id) return getDefaultPrompt()
      if (customPromptTemplates[id]) return customPromptTemplates[id]
      const builtin = getTemplate(id)
      return builtin?.systemPrompt ?? getDefaultPrompt()
    },
    [customPromptTemplates],
  )

  // Initialize edit text when active template changes
  useEffect(() => {
    setLocalActiveId(activePromptTemplate)
    setEditText(resolvePromptText(activePromptTemplate))
    setEditName("")
  }, [activePromptTemplate, resolvePromptText])

  // When the dropdown selection changes locally (before save)
  const handleSelectTemplate = useCallback(
    (id: string) => {
      if (id === "__none__") {
        setLocalActiveId(null)
        setEditText(getDefaultPrompt())
      } else {
        setLocalActiveId(id)
        setEditText(resolvePromptText(id))
      }
      setEditName("")
    },
    [resolvePromptText],
  )

  const handleSave = useCallback(async () => {
    setActivePromptTemplate(localActiveId)
    await savePromptConfig(localActiveId, customPromptTemplates)
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }, [localActiveId, customPromptTemplates, setActivePromptTemplate])

  const handleSaveAsCustom = useCallback(async () => {
    const id = editName.trim()
    if (!id || !editText.trim()) return
    const newTemplates = {
      ...customPromptTemplates,
      [id]: editText.trim(),
    }
    setCustomPromptTemplates(newTemplates)
    setActivePromptTemplate(id)
    await savePromptConfig(id, newTemplates)
    setEditName("")
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }, [editName, editText, customPromptTemplates, setCustomPromptTemplates, setActivePromptTemplate])

  const handleDeleteCustom = useCallback(
    async (id: string) => {
      const newTemplates = { ...customPromptTemplates }
      delete newTemplates[id]
      setCustomPromptTemplates(newTemplates)
      // If the deleted template was active, reset to null
      if (localActiveId === id) {
        setLocalActiveId(null)
        setActivePromptTemplate(null)
        setEditText(getDefaultPrompt())
        await savePromptConfig(null, newTemplates)
      } else {
        await savePromptConfig(localActiveId, newTemplates)
      }
    },
    [customPromptTemplates, localActiveId, setCustomPromptTemplates, setActivePromptTemplate],
  )

  const handleResetToDefault = useCallback(() => {
    setLocalActiveId(null)
    setEditText(getDefaultPrompt())
    setEditName("")
  }, [])

  // Build the list of all template options
  const customIds = Object.keys(customPromptTemplates)

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold">
          {t("settings.sections.promptTemplate.title")}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("settings.sections.promptTemplate.description")}
        </p>
      </div>

      {/* Template selector */}
      <div className="space-y-2">
        <Label>{t("settings.sections.promptTemplate.activeTemplate")}</Label>
        <select
          value={localActiveId ?? "__none__"}
          onChange={(e) => handleSelectTemplate(e.target.value)}
          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
        >
          <option value="__none__">
            {t("settings.sections.promptTemplate.none")}
          </option>
          <optgroup label={t("settings.sections.promptTemplate.builtinGroup")}>
            {BUILTIN_TEMPLATES.map((tmpl) => (
              <option key={tmpl.id} value={tmpl.id}>
                {tmpl.name} — {tmpl.description}
              </option>
            ))}
          </optgroup>
          {customIds.length > 0 && (
            <optgroup label={t("settings.sections.promptTemplate.customGroup")}>
              {customIds.map((id) => (
                <option key={id} value={id}>
                  {t("settings.sections.promptTemplate.customPrefix")}
                  {id}
                </option>
              ))}
            </optgroup>
          )}
        </select>
        <p className="text-xs text-muted-foreground">
          {t("settings.sections.promptTemplate.activeHint")}
        </p>
      </div>

      {/* Preview / edit area */}
      <div className="space-y-2">
        <Label>{t("settings.sections.promptTemplate.systemPrompt")}</Label>
        <textarea
          value={editText}
          onChange={(e) => setEditText(e.target.value)}
          rows={8}
          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-ring"
        />
        <p className="text-xs text-muted-foreground">
          {t("settings.sections.promptTemplate.editHint")}
        </p>
      </div>

      {/* Custom template name input */}
      <div className="space-y-2">
        <Label>{t("settings.sections.promptTemplate.saveAsLabel")}</Label>
        <div className="flex gap-2">
          <input
            type="text"
            value={editName}
            onChange={(e) => setEditName(e.target.value)}
            placeholder={t("settings.sections.promptTemplate.templateNamePlaceholder")}
            className="flex-1 rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          />
          <Button
            variant="outline"
            size="sm"
            onClick={handleSaveAsCustom}
            disabled={!editName.trim() || !editText.trim()}
          >
            {t("settings.sections.promptTemplate.saveAsCustom")}
          </Button>
        </div>
      </div>

      {/* Apply / Reset buttons */}
      <div className="flex items-center gap-3">
        <Button size="sm" onClick={handleSave}>
          {saved ? t("settings.saved") : t("settings.sections.promptTemplate.apply")}
        </Button>
        <Button variant="outline" size="sm" onClick={handleResetToDefault}>
          {t("settings.sections.promptTemplate.resetToDefault")}
        </Button>
        {saved && (
          <span className="text-xs text-green-600">{t("settings.savedTick")}</span>
        )}
      </div>

      {/* Custom templates management */}
      {customIds.length > 0 && (
        <div className="space-y-2">
          <Label>{t("settings.sections.promptTemplate.customTemplates")}</Label>
          <div className="space-y-1">
            {customIds.map((id) => (
              <div
                key={id}
                className="flex items-center justify-between rounded-md border px-3 py-2 text-sm"
              >
                <span className="truncate">{id}</span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="ml-2 h-7 text-muted-foreground hover:text-destructive"
                  onClick={() => handleDeleteCustom(id)}
                >
                  {t("settings.sections.promptTemplate.delete")}
                </Button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function getDefaultPrompt(): string {
  return `You are a knowledgeable wiki assistant. Answer questions based on the wiki content provided below.`
}

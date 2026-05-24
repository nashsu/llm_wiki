import { useTranslation } from "react-i18next"
import { useWikiStore } from "@/stores/wiki-store"
import { WORKFLOW_PRESETS } from "@/lib/workflow-presets"
import { Check } from "lucide-react"

export function WorkflowSection() {
  const { t } = useTranslation()
  const activeWorkflowPreset = useWikiStore((s) => s.activeWorkflowPreset)
  const setActiveWorkflowPreset = useWikiStore((s) => s.setActiveWorkflowPreset)

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold">
          {t("settings.sections.workflow.title")}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("settings.sections.workflow.description")}
        </p>
      </div>

      <div className="grid gap-3">
        {WORKFLOW_PRESETS.map((preset) => {
          const isActive = activeWorkflowPreset === preset.id
          return (
            <button
              key={preset.id}
              type="button"
              onClick={() => setActiveWorkflowPreset(isActive ? null : preset.id)}
              className={`flex items-start gap-3 rounded-lg border p-4 text-left transition-colors ${
                isActive
                  ? "border-primary/50 bg-primary/5 ring-1 ring-primary/30"
                  : "border-border hover:border-primary/30 hover:bg-accent/50"
              }`}
            >
              <div
                className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border ${
                  isActive
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-muted-foreground/40"
                }`}
              >
                {isActive && <Check className="h-3 w-3" />}
              </div>
              <div className="min-w-0 flex-1">
                <div className="font-medium leading-tight">
                  {t(preset.labelKey)}
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {t(preset.descriptionKey)}
                </p>
                <div className="mt-2 flex gap-2">
                  <span className="inline-flex items-center rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                    {t("settings.sections.workflow.depthLabel")}: {preset.ingestDepth}
                  </span>
                  <span className="inline-flex items-center rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                    {t("settings.sections.workflow.pageTypeLabel")}: {preset.defaultPageType}
                  </span>
                </div>
              </div>
            </button>
          )
        })}
      </div>

      {activeWorkflowPreset && (
        <p className="text-xs text-muted-foreground">
          {t("settings.sections.workflow.activeHint")}
        </p>
      )}
    </div>
  )
}

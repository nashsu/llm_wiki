import { useTranslation } from "react-i18next"
import { Label } from "@/components/ui/label"
import type { CloseBehavior } from "@/stores/wiki-store"
import type { SettingsDraft, DraftSetter } from "../settings-types"

interface Props {
  draft: SettingsDraft
  setDraft: DraftSetter
}

const CLOSE_BEHAVIORS: Array<{ value: CloseBehavior; labelKey: string; hintKey: string }> = [
  {
    value: "ask",
    labelKey: "settings.sections.general.closeAsk",
    hintKey: "settings.sections.general.closeAskHint",
  },
  {
    value: "minimize",
    labelKey: "settings.sections.general.closeMinimize",
    hintKey: "settings.sections.general.closeMinimizeHint",
  },
  {
    value: "exit",
    labelKey: "settings.sections.general.closeExit",
    hintKey: "settings.sections.general.closeExitHint",
  },
]

export function GeneralSection({ draft, setDraft }: Props) {
  const { t } = useTranslation()

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold">
          {t("settings.sections.general.title", { defaultValue: "General" })}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("settings.sections.general.description", {
            defaultValue: "Startup and window behavior for the desktop app.",
          })}
        </p>
      </div>

      <label className="flex items-start gap-2">
        <input
          type="checkbox"
          checked={draft.autostart}
          onChange={(e) => setDraft("autostart", e.target.checked)}
          className="mt-0.5 h-4 w-4"
        />
        <div className="space-y-1">
          <span className="text-sm">
            {t("settings.sections.general.autostart", { defaultValue: "Launch at system startup" })}
          </span>
          <p className="text-xs text-muted-foreground">
            {t("settings.sections.general.autostartHint", {
              defaultValue: "Starts LLM Wiki automatically after you sign in to this computer.",
            })}
          </p>
        </div>
      </label>

      <div className="space-y-2">
        <Label>{t("settings.sections.general.closeBehavior", { defaultValue: "When closing the window" })}</Label>
        <div className="grid gap-2">
          {CLOSE_BEHAVIORS.map((option) => {
            const active = draft.closeBehavior === option.value
            return (
              <button
                key={option.value}
                type="button"
                onClick={() => setDraft("closeBehavior", option.value)}
                className={`rounded-md border px-3 py-2 text-left text-sm transition-colors ${
                  active
                    ? "border-primary bg-primary/10 text-foreground ring-1 ring-primary/30"
                    : "border-border hover:bg-accent"
                }`}
              >
                <span className="font-medium">{t(option.labelKey)}</span>
                <span className="mt-0.5 block text-xs text-muted-foreground">
                  {t(option.hintKey)}
                </span>
              </button>
            )
          })}
        </div>
        <p className="text-xs text-muted-foreground">
          {t("settings.sections.general.closeBehaviorHint", {
            defaultValue: "This setting applies when you click the title-bar close button. The tray menu can still quit the app directly.",
          })}
        </p>
      </div>
    </div>
  )
}

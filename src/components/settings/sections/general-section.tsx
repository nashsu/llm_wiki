import type { CloseBehavior } from "@/stores/wiki-store"
import { useTranslation } from "react-i18next"
import { invoke } from "@tauri-apps/api/core"
import type { SettingsDraft, DraftSetter } from "../settings-types"

interface Props {
  draft: SettingsDraft
  setDraft: DraftSetter
}

export function GeneralSection({ draft, setDraft }: Props) {
  const { t } = useTranslation()

  async function handleCloseBehaviorChange(value: CloseBehavior) {
    setDraft("closeBehavior", value)
    try {
      await invoke("set_close_behavior", { value })
    } catch (err) {
      console.warn("[general] failed to set close behavior:", err)
    }
  }

  const options: { value: CloseBehavior; label: string }[] = [
    {
      value: "ask",
      label: t("settings.sections.general.closeBehaviorOptions.ask", {
        defaultValue: "Ask each time",
      }),
    },
    {
      value: "minimize",
      label: t("settings.sections.general.closeBehaviorOptions.minimize", {
        defaultValue: "Minimize to tray",
      }),
    },
    {
      value: "exit",
      label: t("settings.sections.general.closeBehaviorOptions.exit", {
        defaultValue: "Exit directly",
      }),
    },
  ]

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold">
          {t("settings.sections.general.title", { defaultValue: "General" })}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("settings.sections.general.description", {
            defaultValue:
              "Startup behavior and window close action. Changes apply on Save.",
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
            {t("settings.sections.general.autostart", {
              defaultValue: "Start on system boot",
            })}
          </span>
          <p className="text-xs text-muted-foreground">
            {t("settings.sections.general.autostartHint", {
              defaultValue:
                "Registers this app in the OS startup list. Disable to require manual launch.",
            })}
          </p>
        </div>
      </label>

      <div className="flex items-center justify-between rounded-md border border-border/50 bg-muted/20 px-4 py-3">
        <div className="space-y-0.5">
          <span className="text-sm font-medium">
            {t("settings.sections.general.closeBehavior", {
              defaultValue: "When closing window",
            })}
          </span>
          <p className="text-xs text-muted-foreground">
            {t("settings.sections.general.closeBehaviorSubtitle", {
              defaultValue: "Default action when clicking the close button",
            })}
          </p>
        </div>
        <select
          value={draft.closeBehavior}
          onChange={(e) => handleCloseBehaviorChange(e.target.value as CloseBehavior)}
          className="rounded-md border border-input bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
        >
          {options.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>
    </div>
  )
}

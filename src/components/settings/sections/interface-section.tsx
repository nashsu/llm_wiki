import { useTranslation } from "react-i18next"
import { Monitor, Moon, Sun } from "lucide-react"
import { Label } from "@/components/ui/label"
import { activateUiTheme, type UiTheme } from "@/lib/theme"
import type { SettingsDraft, DraftSetter } from "../settings-types"

interface Props {
  draft: SettingsDraft
  setDraft: DraftSetter
}

const UI_LANGUAGES = [
  { value: "en", label: "English" },
  { value: "zh", label: "中文" },
]

const UI_THEMES: Array<{ value: UiTheme; labelKey: string; icon: typeof Monitor }> = [
  { value: "system", labelKey: "settings.sections.interface.themeSystem", icon: Monitor },
  { value: "light", labelKey: "settings.sections.interface.themeLight", icon: Sun },
  { value: "dark", labelKey: "settings.sections.interface.themeDark", icon: Moon },
]

export function InterfaceSection({ draft, setDraft }: Props) {
  const { t } = useTranslation()
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold">{t("settings.sections.interface.title")}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("settings.sections.interface.description")}
        </p>
      </div>

      <div className="space-y-2">
        <Label>{t("settings.sections.interface.uiLanguage")}</Label>
        <div className="flex flex-wrap gap-2">
          {UI_LANGUAGES.map((l) => {
            const active = draft.uiLanguage === l.value
            return (
              <button
                key={l.value}
                type="button"
                onClick={() => setDraft("uiLanguage", l.value)}
                className={`rounded-md border px-3 py-1.5 text-sm transition-colors ${
                  active
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border hover:bg-accent"
                }`}
              >
                {l.label}
              </button>
            )
          })}
        </div>
        <p className="text-xs text-muted-foreground">
          {t("settings.sections.interface.uiLanguageHint")}
        </p>
      </div>

      <div className="space-y-2">
        <Label>{t("settings.sections.interface.theme")}</Label>
        <div className="flex flex-wrap gap-2">
          {UI_THEMES.map((theme) => {
            const active = draft.uiTheme === theme.value
            const Icon = theme.icon
            return (
              <button
                key={theme.value}
                type="button"
                onClick={() => {
                  setDraft("uiTheme", theme.value)
                  activateUiTheme(theme.value)
                }}
                className={`inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm transition-colors ${
                  active
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border hover:bg-accent"
                }`}
              >
                <Icon className="h-4 w-4" />
                {t(theme.labelKey)}
              </button>
            )
          })}
        </div>
        <p className="text-xs text-muted-foreground">
          {t("settings.sections.interface.themeHint")}
        </p>
      </div>
    </div>
  )
}

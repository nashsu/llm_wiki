import { useTranslation } from "react-i18next"
import { Label } from "@/components/ui/label"
import type { SettingsDraft, DraftSetter } from "../settings-types"

interface Props {
  draft: SettingsDraft
  setDraft: DraftSetter
}

const LANGUAGE_OPTIONS = [
  { value: "auto", label: "Auto (detect from input/source)" },
  { value: "English", label: "English" },
  { value: "Chinese", label: "简体中文 (Simplified Chinese)" },
  { value: "Traditional Chinese", label: "繁體中文 (Traditional Chinese)" },
  { value: "Japanese", label: "日本語 (Japanese)" },
  { value: "Korean", label: "한국어 (Korean)" },
  { value: "Vietnamese", label: "Tiếng Việt (Vietnamese)" },
  { value: "French", label: "Français (French)" },
  { value: "German", label: "Deutsch (German)" },
  { value: "Spanish", label: "Español (Spanish)" },
  { value: "Portuguese", label: "Português (Portuguese)" },
  { value: "Italian", label: "Italiano (Italian)" },
  { value: "Russian", label: "Русский (Russian)" },
  { value: "Arabic", label: "العربية (Arabic)" },
  { value: "Hindi", label: "हिन्दी (Hindi)" },
  { value: "Turkish", label: "Türkçe (Turkish)" },
  { value: "Dutch", label: "Nederlands (Dutch)" },
  { value: "Polish", label: "Polski (Polish)" },
  { value: "Swedish", label: "Svenska (Swedish)" },
  { value: "Indonesian", label: "Bahasa Indonesia (Indonesian)" },
  { value: "Thai", label: "ไทย (Thai)" },
]

const HISTORY_OPTIONS = [2, 4, 6, 8, 10, 20]

export function OutputSection({ draft, setDraft }: Props) {
  const { t } = useTranslation()

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold">{t("settings.outputHeading")}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("settings.outputDescription")}
        </p>
      </div>

      <div className="space-y-2">
        <Label>{t("settings.outputLanguageLabel")}</Label>
        <p className="text-xs text-muted-foreground">
          {t("settings.outputLanguageHint")}
        </p>
        <select
          value={draft.outputLanguage}
          onChange={(e) => setDraft("outputLanguage", e.target.value)}
          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
        >
          {LANGUAGE_OPTIONS.map((l) => (
            <option key={l.value} value={l.value}>
              {l.label}
            </option>
          ))}
        </select>
      </div>

      <div className="space-y-2">
        <Label>{t("settings.historyLength")}</Label>
        <p className="text-xs text-muted-foreground">
          {t("settings.historyLengthHint")}
        </p>
        <div className="flex flex-wrap gap-2">
          {HISTORY_OPTIONS.map((n) => {
            const active = draft.maxHistoryMessages === n
            return (
              <button
                key={n}
                type="button"
                onClick={() => setDraft("maxHistoryMessages", n)}
                className={`rounded-md border px-3 py-1.5 text-sm transition-colors ${
                  active
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border hover:bg-accent"
                }`}
              >
                {n}
              </button>
            )
          })}
        </div>
        <p className="text-xs text-muted-foreground">
          {t("settings.historyLengthCurrent", {
            count: draft.maxHistoryMessages,
            turns: Math.floor(draft.maxHistoryMessages / 2),
          })}
        </p>
      </div>
    </div>
  )
}

import { useTranslation } from "react-i18next"
import { Label } from "@/components/ui/label"
import type { SettingsDraft, DraftSetter } from "../settings-types"
import { OUTPUT_LANGUAGE_OPTIONS as LANGUAGE_OPTIONS } from "@/lib/output-language-options"

interface Props {
  draft: SettingsDraft
  setDraft: DraftSetter
}

const HISTORY_OPTIONS = [2, 4, 6, 8, 10, 20]

export function OutputSection({ draft, setDraft }: Props) {
  const { t } = useTranslation()
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold">{t("settings.sections.output.title")}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("settings.sections.output.description")}
        </p>
      </div>

      <div className="space-y-2">
        <Label>{t("settings.sections.output.aiLanguage")}</Label>
        <p className="text-xs text-muted-foreground">
          {t("settings.sections.output.aiLanguageHint")}
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
        <Label>{t("settings.sections.output.historyLength")}</Label>
        <p className="text-xs text-muted-foreground">
          {t("settings.sections.output.historyHint")}
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
          {t("settings.sections.output.historyCurrent", {
            count: draft.maxHistoryMessages,
            turns: draft.maxHistoryMessages / 2,
          })}
        </p>
      </div>
    </div>
  )
}

import { useTranslation } from "react-i18next"
import { Label } from "@/components/ui/label"
import { Plus, Minus } from "lucide-react"
import type { SettingsDraft, DraftSetter } from "../settings-types"
import type { AppTheme } from "@/lib/theme"
import { useState, useEffect } from "react"

interface Props {
  draft: SettingsDraft
  setDraft: DraftSetter
  onThemeChange?: (theme: AppTheme) => void
}

const UI_LANGUAGES = [
  { value: "en", label: "English" },
  { value: "zh", label: "中文" },
]

const THEMES = [
  { value: "light" as const, labelKey: "settings.sections.interface.themeLight" },
  { value: "dark" as const, labelKey: "settings.sections.interface.themeDark" },
  { value: "system" as const, labelKey: "settings.sections.interface.themeSystem" },
]

const MIN_ZOOM = 0.5
const MAX_ZOOM = 3
const STEP = 0.05

function clampZoom(v: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, v))
}

export function InterfaceSection({ draft, setDraft, onThemeChange }: Props) {
  const { t } = useTranslation()
  const level = draft.zoomLevel
  const [inputText, setInputText] = useState(String(Math.round(level * 100)))

  // Sync local input text when draft changes externally (e.g. +/− buttons)
  useEffect(() => {
    setInputText(String(Math.round(level * 100)))
  }, [level])

  const handleZoom = (next: number) => {
    setDraft("zoomLevel", clampZoom(next))
  }

  const commitInput = () => {
    const raw = inputText.replace(/[^0-9.]/g, "")
    const parsed = parseFloat(raw)
    if (!isNaN(parsed) && parsed > 0) {
      setDraft("zoomLevel", clampZoom(parsed / 100))
    } else {
      // Reset to current draft value
      setInputText(String(Math.round(level * 100)))
    }
  }
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
          {THEMES.map((th) => {
            const active = draft.theme === th.value
            return (
              <button
                key={th.value}
                type="button"
                onClick={() => {
                  setDraft("theme", th.value)
                  onThemeChange?.(th.value)
                }}
                className={`rounded-md border px-3 py-1.5 text-sm transition-colors ${
                  active
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border hover:bg-accent"
                }`}
              >
                {t(th.labelKey)}
              </button>
            )
          })}
        </div>
        <p className="text-xs text-muted-foreground">
          {t("settings.sections.interface.themeHint")}
        </p>
      </div>

      <div className="space-y-2">
        <Label>{t("settings.sections.interface.zoom")}</Label>
        <div className="flex items-center gap-1">
          <button
            onClick={() => handleZoom(level - STEP)}
            disabled={level <= MIN_ZOOM}
            className="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground disabled:opacity-30 disabled:pointer-events-none transition-colors"
            aria-label="Zoom out"
          >
            <Minus className="size-3.5" />
          </button>

          <div className="relative flex-1 max-w-[70px]">
            <input
              type="text"
              inputMode="decimal"
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              onBlur={commitInput}
              onKeyDown={(e) => e.key === "Enter" && commitInput()}
              className="w-full rounded-md bg-muted pr-3 pl-1 py-1 text-sm font-semibold text-foreground tabular-nums text-center outline-none focus:ring-2 focus:ring-ring focus:ring-inset [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
            />
            <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
              %
            </span>
          </div>

          <button
            onClick={() => handleZoom(level + STEP)}
            disabled={level >= MAX_ZOOM}
            className="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground disabled:opacity-30 disabled:pointer-events-none transition-colors"
            aria-label="Zoom in"
          >
            <Plus className="size-3.5" />
          </button>
        </div>
      </div>
    </div>
  )
}

import { useTranslation } from "react-i18next"
import { CHANGELOG } from "@/lib/changelog"

export function ChangelogSection() {
  const { t, i18n } = useTranslation()
  // Match the ui language to either the en or zh highlight list.
  // Anything other than "zh" falls back to English so unsupported
  // locales degrade gracefully.
  const lang: "en" | "zh" = i18n.language?.startsWith("zh") ? "zh" : "en"

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold">
          {t("settings.sections.changelog.title", { defaultValue: "Changelog" })}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("settings.sections.changelog.description", {
            defaultValue: "Notable user-visible changes in each released version, newest first.",
          })}
        </p>
      </div>

      <div className="space-y-6">
        {CHANGELOG.map((entry) => (
          <div
            key={entry.version}
            className="rounded-lg border border-border/60 bg-muted/20 p-4"
          >
            <div className="flex items-baseline gap-3">
              <span className="rounded bg-primary/15 px-2 py-0.5 text-sm font-semibold text-primary">
                v{entry.version}
              </span>
              <span className="text-xs text-muted-foreground">{entry.date}</span>
            </div>
            <ul className="mt-3 space-y-2 text-sm leading-relaxed text-foreground/90">
              {entry.highlights[lang].map((line, i) => (
                <li key={i} className="flex gap-2">
                  <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-primary/60" />
                  <span>{line}</span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </div>
  )
}

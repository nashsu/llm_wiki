import { useEffect, useState, useCallback } from "react"
import { Download, RefreshCw, CheckCircle2, Sparkles } from "lucide-react"
import { useTranslation } from "react-i18next"
import { openUrl } from "@tauri-apps/plugin-opener"
import { clipServerStatus } from "@/commands/fs"
import { Button } from "@/components/ui/button"
import { useUpdateStore, hasAvailableUpdate } from "@/stores/update-store"
import { checkForUpdates, toLatestReleaseUrl } from "@/lib/update-check"
import { saveUpdateCheckState } from "@/lib/project-store"

export function AboutSection() {
  const { t } = useTranslation()
  const [clipStatus, setClipStatus] = useState<string>("...")
  const updateStore = useUpdateStore()

  useEffect(() => {
    let alive = true
    clipServerStatus()
      .then((s) => {
        if (alive) setClipStatus(s)
      })
      .catch(() => {
        if (alive) setClipStatus("unknown")
      })
    return () => {
      alive = false
    }
  }, [])

  const handleCheckNow = useCallback(async () => {
    useUpdateStore.getState().setChecking(true)
    const result = await checkForUpdates({
      currentVersion: __APP_VERSION__,
      repo: "nashsu/llm_wiki",
    })
    const now = Date.now()
    useUpdateStore.getState().setResult(result, now)
    // On a manual check, wipe any prior "dismissed" memo so that if
    // the user re-clicks they see the banner again for the same
    // version — a manual check implies "I want to see this now".
    useUpdateStore.getState().setDismissed(null)
    await saveUpdateCheckState({
      enabled: useUpdateStore.getState().enabled,
      lastCheckedAt: now,
      dismissedVersion: null,
    })
  }, [])

  const handleDismiss = useCallback(async () => {
    const result = useUpdateStore.getState().lastResult
    if (result?.kind !== "available") return
    useUpdateStore.getState().setDismissed(result.remote)
    await saveUpdateCheckState({
      enabled: useUpdateStore.getState().enabled,
      lastCheckedAt: useUpdateStore.getState().lastCheckedAt ?? Date.now(),
      dismissedVersion: result.remote,
    })
  }, [])

  const handleToggleAutoCheck = useCallback(async () => {
    const next = !useUpdateStore.getState().enabled
    useUpdateStore.getState().setEnabled(next)
    await saveUpdateCheckState({
      enabled: next,
      lastCheckedAt: useUpdateStore.getState().lastCheckedAt,
      dismissedVersion: useUpdateStore.getState().dismissedVersion,
    })
  }, [])

  const rows: Array<{ label: string; value: string; mono?: boolean }> = [
    { label: t("settings.sections.about.version"), value: `v${__APP_VERSION__}`, mono: true },
    { label: t("settings.sections.about.clipServer"), value: `${clipStatus}  @  127.0.0.1:19827`, mono: true },
  ]

  // About panel = user-initiated navigation. They came here on
  // purpose (often guided by the gear / About red dot) and expect
  // to see WHY the dot is there. So this surface ignores the
  // user's "dismiss" preference — that preference only suppresses
  // the unrequested TOP banner. Within Settings, an available
  // update is always shown in detail.
  const showAvailable = hasAvailableUpdate(updateStore)
  const lastCheckFailed = updateStore.lastResult?.kind === "error"
  const lastCheckedLabel = updateStore.lastCheckedAt
    ? lastCheckFailed
      // Failed checks are overwhelmingly "GitHub unreachable from the
      // user's network" (common in mainland China). Not actionable,
      // so don't display a colored warning — keep the status in the
      // same muted timestamp line and move on.
      ? `${formatRelative(updateStore.lastCheckedAt, t)} · ${t("settings.sections.about.unreachable")}`
      : formatRelative(updateStore.lastCheckedAt, t)
    : t("settings.sections.about.lastCheckedNever")

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold">{t("settings.sections.about.title")}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("settings.sections.about.description")}
        </p>
      </div>

      <div className="rounded-md border divide-y">
        {rows.map((r) => (
          <div key={r.label} className="flex items-center justify-between px-4 py-2.5">
            <span className="text-sm text-muted-foreground">{r.label}</span>
            <span className={`text-sm ${r.mono ? "font-mono" : ""}`}>{r.value}</span>
          </div>
        ))}
      </div>

      {/* ── Update check card ──────────────────────────────────── */}
      <div className="space-y-3 rounded-md border p-4">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-sm font-medium">{t("settings.sections.about.updateCheck")}</div>
            <div className="mt-0.5 text-xs text-muted-foreground">
              {t("settings.sections.about.lastChecked")}: {lastCheckedLabel}
            </div>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={handleCheckNow}
            disabled={updateStore.checking}
            className="shrink-0 gap-1.5"
          >
            <RefreshCw
              className={`h-3.5 w-3.5 ${updateStore.checking ? "animate-spin" : ""}`}
            />
            {updateStore.checking
              ? t("settings.sections.about.checking")
              : t("settings.sections.about.checkNow")}
          </Button>
        </div>

        {showAvailable && updateStore.lastResult?.kind === "available" && (
          <UpdateAvailableBanner
            remote={updateStore.lastResult.remote}
            releaseUrl={updateStore.lastResult.release.html_url}
            releaseName={updateStore.lastResult.release.name}
            releaseBody={updateStore.lastResult.release.body}
            onDismiss={handleDismiss}
          />
        )}

        {!showAvailable && updateStore.lastResult?.kind === "up-to-date" && (
          <div className="flex items-center gap-2 rounded border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-400">
            <CheckCircle2 className="h-4 w-4 shrink-0" />
            {t("settings.sections.about.upToDate", { version: updateStore.lastResult.local })}
          </div>
        )}

        {/* error state intentionally has no banner — see the timestamp
            line above for the muted "couldn't reach GitHub" hint. GitHub
            is regularly unreachable from certain networks (notably
            mainland China) and a colored warning would misleadingly
            look like a bug in the app. */}

        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={updateStore.enabled}
            onChange={handleToggleAutoCheck}
            className="h-3.5 w-3.5"
          />
          {t("settings.sections.about.autoCheck")}
        </label>
      </div>

      <div className="rounded-md border p-4 text-sm">
        <div className="font-medium">LLM Wiki</div>
        <p className="mt-1 text-xs text-muted-foreground">
          {t("settings.sections.about.appDescription")}
          {" "}
          {/*
           * Tauri 2's webview doesn't honor `target="_blank"` for
           * external URLs by default — clicking would either do
           * nothing or replace the in-app webview with the github
           * page (terrible UX). Route through the opener plugin
           * via onClick + preventDefault so it always lands in the
           * system browser.
           */}
          <a
            className="cursor-pointer underline underline-offset-2 hover:text-primary"
            href="https://github.com/nashsu/llm_wiki"
            onClick={(e) => {
              e.preventDefault()
              void openUrl("https://github.com/nashsu/llm_wiki").catch((err) => {
                console.error("[about] openUrl failed:", err)
              })
            }}
          >
            github.com/nashsu/llm_wiki
          </a>
        </p>
      </div>
    </div>
  )
}

interface UpdateAvailableBannerProps {
  remote: string
  releaseUrl: string
  releaseName: string
  releaseBody: string
  onDismiss: () => void
}

function UpdateAvailableBanner({
  remote,
  releaseUrl,
  releaseName,
  releaseBody,
  onDismiss,
}: UpdateAvailableBannerProps) {
  const { t } = useTranslation()
  // Use `/releases/latest` (canonical GitHub redirect to the newest
  // release) rather than the tag-specific URL from the release
  // payload. Same rationale as in the top banner — see
  // `toLatestReleaseUrl` for details.
  const targetUrl = toLatestReleaseUrl(releaseUrl)
  const handleOpen = async () => {
    // Tauri 2's webview does NOT auto-delegate `window.open()` to the
    // system browser — `tauri-plugin-opener` is the official way to
    // launch the user's default browser. The Rust plugin is
    // registered in `src-tauri/src/lib.rs` and `opener:default`
    // permission is granted in capabilities/default.json.
    //
    // Fail-soft: if the plugin call rejects (e.g. URL blocked by a
    // future capability tightening), fall back to copying the URL
    // to the clipboard so the user can paste it into a browser
    // manually instead of seeing a silently broken button.
    try {
      await openUrl(targetUrl)
    } catch (err) {
      console.error("[update-banner] openUrl failed:", err)
      try {
        await navigator.clipboard.writeText(targetUrl)
        // eslint-disable-next-line no-alert
    alert(`无法打开浏览器。已将 URL 复制到剪贴板：\n${targetUrl}`)
      } catch {
        // eslint-disable-next-line no-alert
    alert(`无法打开浏览器。请访问：\n${targetUrl}`)
      }
    }
  }

  const preview = releaseBody.slice(0, 400)
  const truncated = releaseBody.length > preview.length

  return (
    <div className="rounded border border-primary/40 bg-primary/5 p-3">
      <div className="flex items-center gap-2 text-sm font-medium text-primary">
        <Sparkles className="h-4 w-4 shrink-0" />
        {t("settings.sections.about.updateAvailable", { version: remote.replace(/^v/, "") })}
      </div>
      {releaseName && releaseName !== `v${remote.replace(/^v/, "")}` && (
        <div className="mt-1 text-xs text-muted-foreground">{releaseName}</div>
      )}
      {preview.trim().length > 0 && (
        <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded bg-background/60 px-2 py-1.5 text-[11px] leading-relaxed text-foreground/80">
          {preview}
          {truncated && " …"}
        </pre>
      )}
      <div className="mt-3 flex items-center gap-2">
        <Button size="sm" onClick={handleOpen} className="gap-1.5">
          <Download className="h-3.5 w-3.5" />
          {t("settings.sections.about.openDownload")}
        </Button>
        <Button size="sm" variant="ghost" onClick={onDismiss}>
          {t("settings.sections.about.later")}
        </Button>
      </div>
    </div>
  )
}

/** Translated relative-time formatter. Signature accepts a `t` passed
 *  in from the caller so the function stays pure and unit-testable. */
function formatRelative(timestamp: number, t: (key: string, opts?: Record<string, unknown>) => string): string {
  const delta = Date.now() - timestamp
  if (delta < 0) return t("time.justNow", { defaultValue: "just now" })
  const mins = Math.floor(delta / 60_000)
  if (mins < 1) return t("time.justNow", { defaultValue: "just now" })
  if (mins < 60) return t("time.minutesAgo", { count: mins, defaultValue: `${mins} min ago` })
  const hours = Math.floor(mins / 60)
  if (hours < 24) return t("time.hoursAgo", { count: hours, defaultValue: `${hours} h ago` })
  const days = Math.floor(hours / 24)
  return t("time.daysAgo", { count: days, defaultValue: `${days} d ago` })
}

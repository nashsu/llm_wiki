import { useEffect, useState, useCallback } from "react"
import { Download, RefreshCw, CheckCircle2, Sparkles } from "lucide-react"
import { clipServerStatus } from "@/commands/fs"
import { Button } from "@/components/ui/button"
import { useUpdateStore, shouldShowUpdateBanner } from "@/stores/update-store"
import { checkForUpdates } from "@/lib/update-check"
import { saveUpdateCheckState } from "@/lib/project-store"

export function AboutSection() {
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
    { label: "版本", value: `v${__APP_VERSION__}`, mono: true },
    { label: "Clip Server", value: `${clipStatus}  @  127.0.0.1:19827`, mono: true },
  ]

  const showBanner = shouldShowUpdateBanner(updateStore)
  const lastCheckFailed = updateStore.lastResult?.kind === "error"
  const lastCheckedLabel = updateStore.lastCheckedAt
    ? lastCheckFailed
      // Failed checks are overwhelmingly "GitHub unreachable from the
      // user's network" (common in mainland China). Not actionable,
      // so don't display a colored warning — keep the status in the
      // same muted timestamp line and move on.
      ? `${formatRelative(updateStore.lastCheckedAt)} · 未能连接 GitHub`
      : formatRelative(updateStore.lastCheckedAt)
    : "从未"

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold">关于</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          构建信息和运行时状态。
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
            <div className="text-sm font-medium">更新检查</div>
            <div className="mt-0.5 text-xs text-muted-foreground">
              上次检查:{lastCheckedLabel}
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
            {updateStore.checking ? "检查中…" : "立即检查"}
          </Button>
        </div>

        {showBanner && updateStore.lastResult?.kind === "available" && (
          <UpdateAvailableBanner
            remote={updateStore.lastResult.remote}
            releaseUrl={updateStore.lastResult.release.html_url}
            releaseName={updateStore.lastResult.release.name}
            releaseBody={updateStore.lastResult.release.body}
            onDismiss={handleDismiss}
          />
        )}

        {!showBanner && updateStore.lastResult?.kind === "up-to-date" && (
          <div className="flex items-center gap-2 rounded border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-400">
            <CheckCircle2 className="h-4 w-4 shrink-0" />
            已是最新版本(v{updateStore.lastResult.local})。
          </div>
        )}

        {/* error state intentionally has no banner — see the timestamp
            line above for the muted "未能连接 GitHub" hint. GitHub is
            regularly unreachable from certain networks (notably
            mainland China) and a colored warning would misleadingly
            look like a bug in the app. */}

        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={updateStore.enabled}
            onChange={handleToggleAutoCheck}
            className="h-3.5 w-3.5"
          />
          应用启动时自动检查更新(每 6 小时最多一次)
        </label>
      </div>

      <div className="rounded-md border p-4 text-sm">
        <div className="font-medium">LLM Wiki</div>
        <p className="mt-1 text-xs text-muted-foreground">
          An LLM-driven personal knowledge base. Source:
          {" "}
          <a
            className="underline underline-offset-2 hover:text-primary"
            href="https://github.com/nashsu/llm_wiki"
            target="_blank"
            rel="noreferrer"
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
  const handleOpen = () => {
    // window.open with target=_blank delegates to the system browser
    // in Tauri via the opener plugin registered in src-tauri/src/lib.rs.
    // Works identically in a regular browser during dev mode.
    window.open(releaseUrl, "_blank", "noopener,noreferrer")
  }

  const preview = releaseBody.slice(0, 400)
  const truncated = releaseBody.length > preview.length

  return (
    <div className="rounded border border-primary/40 bg-primary/5 p-3">
      <div className="flex items-center gap-2 text-sm font-medium text-primary">
        <Sparkles className="h-4 w-4 shrink-0" />
        有可用更新:v{remote.replace(/^v/, "")}
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
          打开下载页
        </Button>
        <Button size="sm" variant="ghost" onClick={onDismiss}>
          稍后
        </Button>
      </div>
    </div>
  )
}

function formatRelative(timestamp: number): string {
  const delta = Date.now() - timestamp
  if (delta < 0) return "just now"
  const mins = Math.floor(delta / 60_000)
  if (mins < 1) return "刚刚"
  if (mins < 60) return `${mins} 分钟前`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours} 小时前`
  const days = Math.floor(hours / 24)
  return `${days} 天前`
}

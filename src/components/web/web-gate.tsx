/**
 * Web-mode wrapper around the app: checks the server session and shows a
 * password screen when the server requires one. Renders children directly
 * in the desktop app.
 */

import { useEffect, useState, type FormEvent, type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { isWebRuntime } from "@/lib/backend"
import { onWebAuthRequired, WEB_API_BASE } from "@/lib/backend/web"
import logo from "@/assets/logo.jpg"

interface AuthInfo {
  authenticated: boolean
  authRequired: boolean
  version?: string
  mode?: string
}

type GateState = { status: "checking" } | { status: "login"; error?: string } | { status: "ready" }

export function WebGate({ children }: { children: ReactNode }) {
  const web = isWebRuntime()
  const [state, setState] = useState<GateState>(web ? { status: "checking" } : { status: "ready" })

  useEffect(() => {
    if (!web) return
    let cancelled = false
    const check = async () => {
      try {
        const response = await fetch(`${WEB_API_BASE}/auth/me`, { credentials: "same-origin" })
        const info = (await response.json()) as AuthInfo
        if (cancelled) return
        setState(info.authenticated ? { status: "ready" } : { status: "login" })
      } catch {
        if (!cancelled) setState({ status: "login", error: "Cannot reach the LLM Wiki server." })
      }
    }
    void check()
    const unsubscribe = onWebAuthRequired(() => {
      setState((prev) => (prev.status === "ready" ? { status: "login" } : prev))
    })
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [web])

  if (state.status === "ready") return <>{children}</>
  if (state.status === "checking") {
    return (
      <div className="flex h-screen items-center justify-center text-muted-foreground">
        <Loader2 className="size-5 animate-spin" />
      </div>
    )
  }
  return <LoginScreen error={state.error} onSuccess={() => setState({ status: "ready" })} />
}

function LoginScreen({ error: initialError, onSuccess }: { error?: string; onSuccess: () => void }) {
  const { t } = useTranslation()
  const [password, setPassword] = useState("")
  const [error, setError] = useState<string | null>(initialError ?? null)
  const [busy, setBusy] = useState(false)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const response = await fetch(`${WEB_API_BASE}/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password }),
        credentials: "same-origin",
      })
      const result = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string }
      if (response.ok && result.ok) {
        onSuccess()
      } else {
        setError(result.error ?? t("web.loginFailed", { defaultValue: "Invalid password" }))
      }
    } catch {
      setError(t("web.serverUnreachable", { defaultValue: "Cannot reach the LLM Wiki server." }))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex h-screen items-center justify-center bg-background p-6">
      <form onSubmit={submit} className="w-full max-w-sm space-y-5 rounded-xl border bg-card p-6 shadow-sm">
        <div className="flex items-center gap-3">
          <img src={logo} alt="" className="size-10 rounded-lg" />
          <div>
            <div className="text-base font-semibold">LLM Wiki</div>
            <div className="text-xs text-muted-foreground">
              {t("web.loginSubtitle", { defaultValue: "Sign in to your self-hosted wiki" })}
            </div>
          </div>
        </div>
        <div className="space-y-2">
          <Label htmlFor="web-password">{t("web.password", { defaultValue: "Password" })}</Label>
          <Input
            id="web-password"
            type="password"
            autoFocus
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
        {error && <div className="text-sm text-destructive">{error}</div>}
        <Button type="submit" className="w-full" disabled={busy}>
          {busy && <Loader2 data-icon="inline-start" className="animate-spin" />}
          {t("web.signIn", { defaultValue: "Sign in" })}
        </Button>
      </form>
    </div>
  )
}

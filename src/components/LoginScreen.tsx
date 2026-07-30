// Login screen for the LLM Wiki web client.
//
// Shown before the app shell when the server enforces token auth. When
// auth is not required (authRequired === false) the screen skips itself
// and calls onConnected() immediately, so it is safe to mount
// unconditionally at the top of the web entry point.

import { useCallback, useEffect, useRef, useState } from "react"
import { AlertCircle, ArrowRight, Eye, EyeOff, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { getAuthStatus, login } from "@/api/auth"
import { cn } from "@/lib/utils"

interface LoginScreenProps {
  /** Called once the client is authenticated (or auth is not required). */
  onConnected: () => void
}

type Phase = "checking" | "login"
type ServerStatus = "checking" | "reachable" | "unreachable"

export function LoginScreen({ onConnected }: LoginScreenProps) {
  const [phase, setPhase] = useState<Phase>("checking")
  const [serverStatus, setServerStatus] = useState<ServerStatus>("checking")
  const [token, setTokenValue] = useState("")
  const [showToken, setShowToken] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Guards against state updates after unmount (e.g. onConnected() swaps
  // this screen out while the initial status check is still in flight).
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  // On mount: if the server does not require auth, skip the login form.
  useEffect(() => {
    let cancelled = false
    getAuthStatus()
      .then((status) => {
        if (cancelled || !mounted.current) return
        setServerStatus("reachable")
        if (!status.authRequired) {
          onConnected()
        } else {
          setPhase("login")
        }
      })
      .catch(() => {
        // Server unreachable or status endpoint missing — fall through to
        // the form so the user can still try a token.
        if (cancelled || !mounted.current) return
        setServerStatus("unreachable")
        setPhase("login")
      })
    return () => {
      cancelled = true
    }
  }, [onConnected])

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault()
      const trimmed = token.trim()
      if (!trimmed || submitting) return
      setSubmitting(true)
      setError(null)
      try {
        const res = await login(trimmed)
        if (!mounted.current) return
        if (res.success) {
          // login() already persists the token (src/api/auth.ts); no double-set needed.
          onConnected()
        } else {
          setError(res.message || "Invalid token.")
          setSubmitting(false)
        }
      } catch (err) {
        if (!mounted.current) return
        setError(err instanceof Error ? err.message : "Could not reach the server.")
        setSubmitting(false)
      }
    },
    [token, submitting, onConnected],
  )

  return (
    <div className="relative flex h-full items-center justify-center overflow-hidden bg-background px-4">
      {/* Ambient backdrop: soft primary-tinted glows over a faint grid. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[linear-gradient(to_right,var(--border)_1px,transparent_1px),linear-gradient(to_bottom,var(--border)_1px,transparent_1px)] bg-[size:36px_36px] opacity-[0.18] [mask-image:radial-gradient(ellipse_70%_60%_at_50%_40%,black,transparent)]"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -top-32 left-1/2 h-72 w-[36rem] -translate-x-1/2 rounded-full bg-primary/[0.07] blur-3xl"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -bottom-40 -right-24 h-80 w-80 rounded-full bg-primary/[0.05] blur-3xl"
      />

      <div className="relative w-full max-w-sm animate-in fade-in slide-in-from-bottom-3 duration-500">
        <div className="group/card rounded-xl border border-border bg-card text-card-foreground shadow-lg shadow-black/[0.06] transition-[border-color,box-shadow] duration-300 hover:border-border/80 hover:shadow-xl hover:shadow-black/[0.09] dark:shadow-black/30 dark:hover:shadow-black/40">
          <div className="border-b border-border px-6 pb-5 pt-6">
            <div className="flex items-center gap-3">
              {/* Mark: stacked pages, echoing the wiki's layered notes. */}
              <div className="relative grid size-10 shrink-0 place-items-center rounded-lg bg-primary text-primary-foreground shadow-sm transition-transform duration-300 group-hover/card:-rotate-3 group-hover/card:scale-105">
                <svg
                  viewBox="0 0 20 20"
                  className="size-5"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden
                >
                  <path d="M4 6.5h9l3 3v6H4z" opacity="0.45" />
                  <path d="M4 3.5h9l3 3v6H4z" fill="currentColor" stroke="none" opacity="0.25" />
                  <path d="M4 3.5h9l3 3v6H4z" />
                  <path d="M13 3.5v3h3" />
                </svg>
              </div>
              <div>
                <h1 className="text-xl font-bold leading-tight tracking-tight">LLM Wiki</h1>
                <p className="mt-0.5 text-xs text-muted-foreground">Connect to your wiki server</p>
              </div>
            </div>
          </div>

          {phase === "checking" ? (
            <div className="flex flex-col items-center gap-2 px-6 py-10 text-muted-foreground">
              <Loader2 className="size-5 animate-spin" />
              <p className="text-sm">Checking connection…</p>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="flex flex-col gap-4 px-6 py-6">
              <div className="flex flex-col gap-2">
                <Label htmlFor="api-token">API Token</Label>
                <div className="relative">
                  <Input
                    id="api-token"
                    type={showToken ? "text" : "password"}
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="Paste your server token"
                    className="pr-9 font-mono text-[13px]"
                    value={token}
                    aria-invalid={error ? true : undefined}
                    aria-describedby={error ? "login-error" : undefined}
                    onChange={(e) => {
                      setTokenValue(e.target.value)
                      if (error) setError(null)
                    }}
                    autoFocus
                  />
                  <button
                    type="button"
                    tabIndex={-1}
                    onClick={() => setShowToken((v) => !v)}
                    aria-label={showToken ? "Hide token" : "Show token"}
                    className="absolute inset-y-0 right-0 grid w-9 place-items-center text-muted-foreground transition-colors hover:text-foreground"
                  >
                    {showToken ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                  </button>
                </div>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  The token from Settings → API in the desktop app.
                </p>
              </div>

              {error && (
                <div
                  id="login-error"
                  role="alert"
                  className="flex animate-in fade-in zoom-in-95 items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive duration-200"
                >
                  <AlertCircle className="mt-0.5 size-4 shrink-0" />
                  <span className="min-w-0 break-words">{error}</span>
                </div>
              )}

              <Button type="submit" size="lg" disabled={!token.trim() || submitting} className="w-full">
                {submitting ? (
                  <>
                    <Loader2 className="animate-spin" />
                    Connecting…
                  </>
                ) : (
                  <>
                    Connect
                    <ArrowRight className="transition-transform group-hover/button:translate-x-0.5" />
                  </>
                )}
              </Button>
            </form>
          )}
        </div>

        <div className="mt-4 flex items-center justify-center gap-2 text-xs text-muted-foreground">
          <span
            aria-hidden
            className={cn(
              "size-1.5 rounded-full transition-colors duration-300",
              serverStatus === "checking" && "animate-pulse bg-muted-foreground/50",
              serverStatus === "reachable" && "bg-emerald-500 shadow-[0_0_6px] shadow-emerald-500/60",
              serverStatus === "unreachable" && "bg-destructive shadow-[0_0_6px] shadow-destructive/60",
            )}
          />
          <span>
            {serverStatus === "checking" && "Contacting server…"}
            {serverStatus === "reachable" && "Server reachable — token required"}
            {serverStatus === "unreachable" && "Server not responding — check it is running"}
          </span>
        </div>
      </div>
    </div>
  )
}

export default LoginScreen

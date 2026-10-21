import { useEffect, useId } from "react"
import { Button } from "@/components/ui/button"
import { refreshCopilotSession, signInCopilot, signOutCopilot, useCopilotSession } from "@/lib/copilot-session"

export function CopilotModelSelect({ value, onChange, allowDefault = false }: {
  value: string; onChange: (value: string) => void; allowDefault?: boolean
}) {
  const id = useId()
  const authenticated = useCopilotSession(s => s.authenticated)
  const models = useCopilotSession(s => s.models)
  const available = models.some(model => model.id === value)
  return <div className="space-y-2">
    <label htmlFor={id} className="text-sm font-medium">Copilot chat model</label>
    <select id={id} value={available || (allowDefault && !value) ? value : ""}
      disabled={!authenticated || !models.length}
      onChange={event => onChange(event.target.value)}
      className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm disabled:opacity-60">
      <option value="" disabled={!allowDefault}>{allowDefault ? "Use saved Copilot model" : "Select an available model"}</option>
      {models.map(model => <option key={model.id} value={model.id}>{model.name} ({model.id})</option>)}
    </select>
    {value && !available && <p className="text-xs text-muted-foreground">Saved model: {value}. Sign in and refresh the catalog to confirm availability.</p>}
  </div>
}

export function CopilotAuth({ model, onModelChange }: { model: string; onModelChange: (model: string) => void }) {
  const { authenticated, flow, busy, error } = useCopilotSession()
  // Status discovery is safe on mount. Starting auth is exclusively a button action.
  useEffect(() => { void refreshCopilotSession() }, [])
  return <div className="space-y-3 rounded-md border p-3">
    <p role="status" aria-live="polite" className="text-sm">{authenticated ? "Signed in to GitHub Copilot" : flow ? "Waiting for you to authorize on GitHub" : "Not signed in to GitHub Copilot"}</p>
    <div className="flex flex-wrap gap-2">
      {!authenticated && <Button size="sm" disabled={busy} onClick={() => void signInCopilot()}>Sign in to GitHub Copilot</Button>}
      {authenticated && <Button size="sm" variant="outline" disabled={busy} onClick={() => void signOutCopilot()}>Sign out</Button>}
      {flow && <Button size="sm" variant="outline" onClick={() => void signOutCopilot()}>Cancel sign-in</Button>}
      <Button size="sm" variant="outline" disabled={busy} onClick={() => void refreshCopilotSession()}>Refresh status and models</Button>
    </div>
    {flow && <div className="space-y-2 text-sm">
      <p>Open this URL manually in your browser and enter the code. No browser is opened automatically.</p>
      <p className="break-all font-mono">{flow.verificationUri}</p>
      <p>User code: <strong className="select-all font-mono">{flow.userCode}</strong></p>
      <p className="text-xs text-muted-foreground">Expires in {flow.expiresIn} seconds from sign-in start. Polling follows GitHub's interval.</p>
    </div>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    <CopilotModelSelect value={model} onChange={onModelChange} />
    <p className="text-xs text-muted-foreground">Text only, buffered responses; images are unsupported. Wiki queries use the existing backend Agent. Credentials stay in native memory, not frontend settings. Sign-in is required again after restart. Cancel stops frontend delivery; an already-running bounded native request may finish. Select this preset for both Chat and Ingest above to use the same saved model.</p>
  </div>
}

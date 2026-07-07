import { useCallback, useEffect, useRef, useState } from "react"
import {
  ChevronDown,
  ChevronRight,
  Loader2,
  CheckCircle2,
  XCircle,
  X,
  Plus,
  AlertCircle,
  Wifi,
} from "lucide-react"
import { useTranslation } from "react-i18next"
import { invoke } from "@tauri-apps/api/core"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ModelProvider {
  id: string
  name: string
  protocol: "openai" | "anthropic" | "google"
  api_base: string
  api_key: string
  models: string[]
  default_model: string
  custom_headers: Record<string, string>
  max_context: number
  created_at: string
}

interface ProviderAssignment {
  chat: { provider_id: string; model: string } | null
  ingest: { provider_id: string; model: string } | null
  maintenance: { provider_id: string; model: string } | null
}

type AssignmentKey = keyof ProviderAssignment

type TestStatus =
  | { kind: "idle" }
  | { kind: "running" }
  | { kind: "ok"; message: string }
  | { kind: "error"; message: string }

interface EditableProvider {
  id: string
  name: string
  protocol: ModelProvider["protocol"]
  api_base: string
  api_key: string
  default_model: string
  custom_headers: Record<string, string>
  max_context: number
  temperature: number
}

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

const API_BASE = "http://127.0.0.1:19828"

async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`)
  if (!res.ok) {
    const body = await res.text().catch(() => "")
    throw new Error(`GET ${path} ${res.status}: ${body || res.statusText}`)
  }
  return res.json() as Promise<T>
}

async function apiPost<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new Error(`POST ${path} ${res.status}: ${text || res.statusText}`)
  }
  return res.json() as Promise<T>
}

async function apiPut<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new Error(`PUT ${path} ${res.status}: ${text || res.statusText}`)
  }
  return res.json() as Promise<T>
}

async function apiDelete<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, { method: "DELETE" })
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new Error(`DELETE ${path} ${res.status}: ${text || res.statusText}`)
  }
  return res.json() as Promise<T>
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function headersToText(headers: Record<string, string>): string {
  return Object.entries(headers)
    .filter(([k]) => k !== "x-temperature")
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n")
}

function parseHeadersText(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith("#")) continue
    const idx = line.indexOf(":")
    if (idx <= 0) continue
    const name = line.slice(0, idx).trim()
    const value = line.slice(idx + 1).trim()
    if (!name || !value) continue
    out[name] = value
  }
  return out
}

function parseTemperature(headers: Record<string, string>): number {
  const raw = headers["x-temperature"]
  if (raw === undefined || raw === "") return 0.7
  const n = Number(raw)
  return Number.isFinite(n) ? Math.max(0, Math.min(2, n)) : 0.7
}

function mergeEditable(provider: ModelProvider): EditableProvider {
  return {
    id: provider.id,
    name: provider.name,
    protocol: provider.protocol,
    api_base: provider.api_base,
    api_key: provider.api_key,
    default_model: provider.default_model,
    custom_headers: provider.custom_headers,
    max_context: provider.max_context,
    temperature: parseTemperature(provider.custom_headers),
  }
}

function buildProviderPayload(
  editable: EditableProvider,
): Partial<ModelProvider> {
  const { id: _id, ...rest } = editable
  const headers = { ...rest.custom_headers }
  headers["x-temperature"] = String(rest.temperature)
  return {
    name: rest.name,
    protocol: rest.protocol,
    api_base: rest.api_base,
    api_key: rest.api_key,
    default_model: rest.default_model,
    custom_headers: headers,
    max_context: rest.max_context,
  }
}

// ---------------------------------------------------------------------------
// DetectResult (unchanged from original)
// ---------------------------------------------------------------------------

interface DetectResult {
  installed: boolean
  version: string | null
  path: string | null
  error: string | null
}

// ---------------------------------------------------------------------------
// Claude CLI StatusPill (unchanged from original)
// ---------------------------------------------------------------------------

function ClaudeCliStatusPill() {
  const [state, setState] = useState<"loading" | "ok" | "err">("loading")
  const [result, setResult] = useState<DetectResult | null>(null)

  async function detect() {
    setState("loading")
    try {
      const r = await invoke<DetectResult>("claude_cli_detect")
      setResult(r)
      setState(r.installed ? "ok" : "err")
    } catch (e) {
      setResult({
        installed: false,
        version: null,
        path: null,
        error: e instanceof Error ? e.message : String(e),
      })
      setState("err")
    }
  }

  useEffect(() => {
    void detect()
  }, [])

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <Label className="m-0">CLI status</Label>
        <button
          type="button"
          onClick={() => void detect()}
          className="rounded border border-border px-2 py-0.5 text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground"
          disabled={state === "loading"}
        >
          {state === "loading" ? "Checking\u2026" : "Re-check"}
        </button>
      </div>
      <div
        className={`flex items-start gap-1.5 rounded-md border px-2 py-1.5 text-xs ${
          state === "ok"
            ? "border-emerald-500/40 bg-emerald-500/5 text-emerald-700 dark:text-emerald-400"
            : state === "err"
              ? "border-rose-500/40 bg-rose-500/5 text-rose-700 dark:text-rose-400"
              : "border-border bg-background/50 text-muted-foreground"
        }`}
      >
        {state === "loading" && <Loader2 className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin" />}
        {state === "ok" && <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />}
        {state === "err" && <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />}
        <div className="min-w-0 flex-1 space-y-0.5">
          {state === "loading" && <div>Detecting local claude binary\u2026</div>}
          {state === "ok" && (
            <>
              <div>
                Detected{result?.version ? ` ${result.version}` : ""}. Ready to use your local
                subscription — no API key needed.
              </div>
              {result?.path && (
                <div className="truncate font-mono text-[10px] text-muted-foreground">
                  {result.path}
                </div>
              )}
              <div className="text-muted-foreground">
                If chat fails with an authentication error, run{" "}
                <code className="rounded bg-background/60 px-1 py-0.5 font-mono text-[10px]">
                  claude
                </code>{" "}
                in a terminal to refresh the OAuth login.
              </div>
            </>
          )}
          {state === "err" && (
            <>
              <div>{result?.error ?? "claude CLI not available."}</div>
              <div className="text-muted-foreground">
                Install from{" "}
                <code className="rounded bg-background/60 px-1 py-0.5 font-mono text-[10px]">
                  npm i -g @anthropic-ai/claude-code
                </code>{" "}
                then re-check.
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Codex CLI StatusPill (unchanged from original)
// ---------------------------------------------------------------------------

function CodexCliStatusPill() {
  const [state, setState] = useState<"loading" | "ok" | "err">("loading")
  const [result, setResult] = useState<DetectResult | null>(null)

  async function detect() {
    setState("loading")
    try {
      const r = await invoke<DetectResult>("codex_cli_detect")
      setResult(r)
      setState(r.installed ? "ok" : "err")
    } catch (e) {
      setResult({
        installed: false,
        version: null,
        path: null,
        error: e instanceof Error ? e.message : String(e),
      })
      setState("err")
    }
  }

  useEffect(() => {
    void detect()
  }, [])

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <Label className="m-0">CLI status</Label>
        <button
          type="button"
          onClick={() => void detect()}
          className="rounded border border-border px-2 py-0.5 text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground"
          disabled={state === "loading"}
        >
          {state === "loading" ? "Checking\u2026" : "Re-check"}
        </button>
      </div>
      <div
        className={`flex items-start gap-1.5 rounded-md border px-2 py-1.5 text-xs ${
          state === "ok"
            ? "border-emerald-500/40 bg-emerald-500/5 text-emerald-700 dark:text-emerald-400"
            : state === "err"
              ? "border-rose-500/40 bg-rose-500/5 text-rose-700 dark:text-rose-400"
              : "border-border bg-background/50 text-muted-foreground"
        }`}
      >
        {state === "loading" && <Loader2 className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin" />}
        {state === "ok" && <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />}
        {state === "err" && <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />}
        <div className="min-w-0 flex-1 space-y-0.5">
          {state === "loading" && <div>Detecting local codex binary\u2026</div>}
          {state === "ok" && (
            <>
              <div>
                Detected{result?.version ? ` ${result.version}` : ""}. Ready to use your local
                Codex login — no API key needed.
              </div>
              {result?.path && (
                <div className="truncate font-mono text-[10px] text-muted-foreground">
                  {result.path}
                </div>
              )}
              <div className="text-muted-foreground">
                If chat fails with an authentication error, run{" "}
                <code className="rounded bg-background/60 px-1 py-0.5 font-mono text-[10px]">
                  codex
                </code>{" "}
                in a terminal to refresh the login.
              </div>
            </>
          )}
          {state === "err" && (
            <>
              <div>{result?.error ?? "codex CLI not available."}</div>
              <div className="text-muted-foreground">
                Install from{" "}
                <code className="rounded bg-background/60 px-1 py-0.5 font-mono text-[10px]">
                  npm install -g @openai/codex
                </code>{" "}
                then re-check.
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Protocol selector
// ---------------------------------------------------------------------------

const PROTOCOL_OPTIONS: { value: ModelProvider["protocol"]; label: string }[] = [
  { value: "openai", label: "OpenAI\u5355\u5bb9" },
  { value: "anthropic", label: "Anthropic" },
  { value: "google", label: "Google" },
]

function ProtocolSelect({
  value,
  onChange,
}: {
  value: ModelProvider["protocol"]
  onChange: (v: ModelProvider["protocol"]) => void
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {PROTOCOL_OPTIONS.map((opt) => {
        const active = value === opt.value
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() => onChange(opt.value)}
            className={`rounded-md border px-2.5 py-1 text-xs transition-colors ${
              active
                ? "border-primary bg-primary text-primary-foreground"
                : "border-border hover:bg-accent"
            }`}
          >
            {opt.label}
          </button>
        )
      })}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Add / Edit Provider Dialog
// ---------------------------------------------------------------------------

interface ProviderFormProps {
  initial?: EditableProvider
  onSave: (data: EditableProvider) => void | Promise<void>
  onCancel: () => void
  /** Label for the confirm button */
  confirmLabel: string
  open: boolean
}

function ProviderFormDialog({
  initial,
  onSave,
  onCancel,
  confirmLabel,
  open,
}: ProviderFormProps) {
  const [name, setName] = useState(initial?.name ?? "")
  const [protocol, setProtocol] = useState<ModelProvider["protocol"]>(
    initial?.protocol ?? "openai",
  )
  const [apiBase, setApiBase] = useState(initial?.api_base ?? "")
  const [apiKey, setApiKey] = useState(initial?.api_key ?? "")
  const [defaultModel, setDefaultModel] = useState(initial?.default_model ?? "")
  const [maxContext, setMaxContext] = useState(String(initial?.max_context ?? 128000))
  const [temperature, setTemperature] = useState(String(initial?.temperature ?? 0.7))
  const [headersText, setHeadersText] = useState(
    initial ? headersToText(initial.custom_headers) : "",
  )
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Reset form when dialog opens
  useEffect(() => {
    if (open) {
      setName(initial?.name ?? "")
      setProtocol(initial?.protocol ?? "openai")
      setApiBase(initial?.api_base ?? "")
      setApiKey(initial?.api_key ?? "")
      setDefaultModel(initial?.default_model ?? "")
      setMaxContext(String(initial?.max_context ?? 128000))
      setTemperature(String(initial?.temperature ?? 0.7))
      setHeadersText(initial ? headersToText(initial.custom_headers) : "")
      setShowAdvanced(false)
      setSaving(false)
      setError(null)
    }
  }, [open, initial])

  async function handleSubmit() {
    if (!name.trim()) {
      setError("供应商名称不能为空")
      return
    }
    if (!apiBase.trim()) {
      setError("接口地址不能为空")
      return
    }

    setSaving(true)
    setError(null)
    try {
      const customHeaders = {
        ...parseHeadersText(headersText),
        "x-temperature": String(Math.max(0, Math.min(2, Number(temperature) || 0.7))),
      }
      await onSave({
        id: initial?.id ?? "",
        name: name.trim(),
        protocol,
        api_base: apiBase.trim(),
        api_key: apiKey,
        default_model: defaultModel.trim(),
        custom_headers: customHeaders,
        max_context: Math.max(1024, Number(maxContext) || 128000),
        temperature: Math.max(0, Math.min(2, Number(temperature) || 0.7)),
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onCancel() }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{initial ? "\u7f16\u8f91\u4f9b\u5e94\u5546" : "\u6dfb\u52a0\u4f9b\u5e94\u5546"}</DialogTitle>
          <DialogDescription>
            {initial
              ? "\u4fee\u6539\u4f9b\u5e94\u5546\u914d\u7f6e\u540e\u70b9\u51fb\u4fdd\u5b58"
              : "\u586b\u5199\u4f9b\u5e94\u5546\u4fe1\u606f\u540e\u70b9\u51fb\u6dfb\u52a0"}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Name */}
          <div className="space-y-2">
            <Label>供应商名称</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. My OpenAI Proxy"
            />
          </div>

          {/* Protocol */}
          <div className="space-y-2">
            <Label>协议类型</Label>
            <ProtocolSelect value={protocol} onChange={setProtocol} />
          </div>

          {/* API Base URL */}
          <div className="space-y-2">
            <Label>接口地址</Label>
            <Input
              value={apiBase}
              onChange={(e) => setApiBase(e.target.value)}
              placeholder="https://api.openai.com/v1"
            />
          </div>

          {/* API Key */}
          <div className="space-y-2">
            <Label>API密钥（非必填）</Label>
            <Input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="sk-..."
            />
          </div>

          {/* Default Model */}
          <div className="space-y-2">
            <Label>默认模型</Label>
            <Input
              value={defaultModel}
              onChange={(e) => setDefaultModel(e.target.value)}
              placeholder="gpt-4o"
            />
          </div>

          {/* Temperature */}
          <div className="space-y-2">
            <Label>温度值 (Temperature) — {temperature}</Label>
            <div className="flex items-center gap-3">
              <input
                type="range"
                min={0}
                max={2}
                step={0.1}
                value={temperature}
                onChange={(e) => setTemperature(e.target.value)}
                className="flex-1 h-2 rounded-full appearance-none bg-muted-foreground/20 cursor-pointer accent-primary"
              />
              <Input
                type="number"
                min={0}
                max={2}
                step={0.1}
                className="w-20"
                value={temperature}
                onChange={(e) => setTemperature(e.target.value)}
              />
            </div>
          </div>

          {/* Max Context */}
          <div className="space-y-2">
            <Label>最大 Token 上限 (Max Tokens)</Label>
            <Input
              type="number"
              min={1024}
              step={1024}
              value={maxContext}
              onChange={(e) => setMaxContext(e.target.value)}
              placeholder="128000"
            />
          </div>

          {/* Advanced Settings */}
          <div>
            <button
              type="button"
              onClick={() => setShowAdvanced(!showAdvanced)}
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              {showAdvanced ? (
                <ChevronDown className="h-3.5 w-3.5" />
              ) : (
                <ChevronRight className="h-3.5 w-3.5" />
              )}
              高级设置 (自定义请求头)
            </button>
            {showAdvanced && (
              <div className="mt-2 space-y-2">
                <textarea
                  value={headersText}
                  onChange={(e) => setHeadersText(e.target.value)}
                  placeholder={"X-Custom-Header: value\nX-Another: value2"}
                  rows={3}
                  className="flex w-full rounded-md border border-input bg-transparent px-3 py-2 font-mono text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                />
                <p className="text-xs text-muted-foreground">
                  每行一个请求头，格式为 key: value
                </p>
              </div>
            )}
          </div>

          {error && (
            <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
              {error}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onCancel} disabled={saving}>
            取消
          </Button>
          <Button onClick={() => void handleSubmit()} disabled={saving}>
            {saving ? "保存中..." : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// Provider Card
// ---------------------------------------------------------------------------

interface ProviderCardProps {
  provider: EditableProvider
  assignment: ProviderAssignment
  onAssignmentChange: (key: AssignmentKey, model: string) => void
  onUpdate: (data: EditableProvider) => void
  onDelete: () => void
  onTest: () => void
  testStatus: TestStatus
}

function ProviderCard({
  provider,
  assignment,
  onAssignmentChange,
  onUpdate,
  onDelete,
  onTest,
  testStatus,
}: ProviderCardProps) {
  const [expanded, setExpanded] = useState(false)
  const [editDialogOpen, setEditDialogOpen] = useState(false)

  const assignedTo: AssignmentKey[] = []
  for (const key of ["chat", "ingest", "maintenance"] as AssignmentKey[]) {
    const a = assignment[key]
    if (a && a.provider_id === provider.id) assignedTo.push(key)
  }

  const protocolLabels: Record<string, string> = {
    openai: "OpenAI",
    anthropic: "Anthropic",
    google: "Google",
  }

  return (
    <>
      <div className="rounded-lg border border-border transition-colors">
        {/* Header row */}
        <div className="flex items-center gap-3 px-3 py-2.5">
          <button
            type="button"
            onClick={() => setExpanded(!expanded)}
            className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-accent"
          >
            {expanded ? (
              <ChevronDown className="h-4 w-4" />
            ) : (
              <ChevronRight className="h-4 w-4" />
            )}
          </button>

          <button
            type="button"
            onClick={() => setExpanded(!expanded)}
            className="min-w-0 flex-1 text-left"
          >
            <div className="flex items-center gap-2">
              <span className="truncate text-sm font-medium">{provider.name}</span>
              <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                {protocolLabels[provider.protocol] ?? provider.protocol}
              </span>
              {assignedTo.length > 0 && (
                <span className="shrink-0 rounded-full bg-primary/20 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                  {"\u5df2\u5206\u914d"}
                </span>
              )}
            </div>
            {provider.api_base && (
              <div className="mt-0.5 truncate text-xs text-muted-foreground">
                {provider.api_base}
              </div>
            )}
          </button>

          {/* Delete button */}
          <button
            type="button"
            onClick={onDelete}
            className="shrink-0 rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
            title="删除"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Expanded config */}
        {expanded && (
          <div className="space-y-4 border-t bg-background/50 px-4 py-3">
            {/* Capability assignment */}
            <div className="space-y-2">
              <Label>功能分配</Label>
              <div className="flex flex-wrap gap-3">
                {(["chat", "ingest", "maintenance"] as AssignmentKey[]).map((key) => {
                  const checked = assignment[key]?.provider_id === provider.id
                  const labels: Record<AssignmentKey, string> = {
                    chat: "\u5bf9\u8bdd (chat)",
                    ingest: "\u6444\u5165 (ingest)",
                    maintenance: "Agent\u8f85\u52a9\u7ef4\u62a4 (maintenance)",
                  }
                  return (
                    <label
                      key={key}
                      className="flex items-center gap-2 text-sm cursor-pointer select-none"
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() =>
                          onAssignmentChange(key, checked ? "" : provider.default_model)
                        }
                        className="h-4 w-4 rounded border-border accent-primary"
                      />
                      {labels[key]}
                    </label>
                  )
                })}
              </div>
            </div>

            {/* Edit button */}
            <Button
              variant="outline"
              size="sm"
              onClick={() => setEditDialogOpen(true)}
            >
              编辑配置
            </Button>

            {/* Test connection */}
            <div className="space-y-2">
              <Button
                variant="outline"
                size="sm"
                onClick={onTest}
                disabled={testStatus.kind === "running"}
              >
                {testStatus.kind === "running" ? (
                  <>
                    <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                    测试中...
                  </>
                ) : (
                  <>
                    <Wifi className="mr-1 h-3.5 w-3.5" />
                    测试连接
                  </>
                )}
              </Button>
              {testStatus.kind === "ok" && (
                <div className="rounded-md border border-emerald-500/40 bg-emerald-500/5 px-3 py-2 text-xs text-emerald-700 dark:text-emerald-400">
                  <CheckCircle2 className="mr-1 inline h-3.5 w-3.5" />
                  {testStatus.message}
                </div>
              )}
              {testStatus.kind === "error" && (
                <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
                  <AlertCircle className="mr-1 inline h-3.5 w-3.5" />
                  {testStatus.message}
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Edit dialog */}
      <ProviderFormDialog
        open={editDialogOpen}
        initial={provider}
        onSave={(data) => {
          onUpdate(data)
          setEditDialogOpen(false)
        }}
        onCancel={() => setEditDialogOpen(false)}
        confirmLabel="保存"
      />
    </>
  )
}

// ---------------------------------------------------------------------------
// Main section component
// ---------------------------------------------------------------------------

export function LlmProviderSection() {
  const { t } = useTranslation()
  const [providers, setProviders] = useState<EditableProvider[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [assignment, setAssignment] = useState<ProviderAssignment>({
    chat: null,
    ingest: null,
    maintenance: null,
  })
  const [addDialogOpen, setAddDialogOpen] = useState(false)
  const [testStatuses, setTestStatuses] = useState<Record<string, TestStatus>>({})
  const testRunRef = useRef<Record<string, number>>({})

  // Load providers + assignments on mount
  const loadData = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [providerList, assignData] = await Promise.all([
        apiGet<ModelProvider[]>("/api/providers"),
        apiGet<ProviderAssignment>("/api/providers/assignment").catch(() => ({
          chat: null,
          ingest: null,
          maintenance: null,
        })),
      ])
      setProviders(providerList.map(mergeEditable))
      setAssignment(assignData)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadData()
  }, [loadData])

  // Add provider
  async function handleAdd(data: EditableProvider) {
    const payload = buildProviderPayload(data)
    await apiPost("/api/providers", payload)
    setAddDialogOpen(false)
    await loadData()
  }

  // Update provider
  async function handleUpdate(data: EditableProvider) {
    const payload = buildProviderPayload(data)
    await apiPut(`/api/providers/${data.id}`, payload)
    await loadData()
  }

  // Delete provider
  async function handleDelete(id: string) {
    // Remove from assignment first if assigned
    const updatedAssignment = { ...assignment }
    for (const key of ["chat", "ingest", "maintenance"] as AssignmentKey[]) {
      if (updatedAssignment[key]?.provider_id === id) {
        updatedAssignment[key] = null
      }
    }
    await apiPut("/api/providers/assignment", updatedAssignment)
    await apiDelete(`/api/providers/${id}`)
    await loadData()
  }

  // Toggle assignment from card
  async function handleToggleAssignment(providerId: string, key: AssignmentKey, model: string) {
    const updated = { ...assignment }
    if (updated[key]?.provider_id === providerId) {
      updated[key] = null
    } else {
      updated[key] = { provider_id: providerId, model: model || providers.find(p => p.id === providerId)?.default_model || "" }
    }
    setAssignment(updated)
    try {
      await apiPut("/api/providers/assignment", updated)
    } catch {
      await loadData()
    }
  }

  // Test connection
  async function handleTest(providerId: string) {
    const runId = (testRunRef.current[providerId] ?? 0) + 1
    testRunRef.current[providerId] = runId
    setTestStatuses((prev) => ({
      ...prev,
      [providerId]: { kind: "running" },
    }))
    try {
      const result = await apiPost<{ ok: boolean; message: string }>(
        `/api/providers/${providerId}/test`,
      )
      if (testRunRef.current[providerId] !== runId) return
      setTestStatuses((prev) => ({
        ...prev,
        [providerId]: result.ok
          ? { kind: "ok", message: result.message || "连接成功" }
          : { kind: "error", message: result.message || "连接失败" },
      }))
    } catch (err) {
      if (testRunRef.current[providerId] !== runId) return
      setTestStatuses((prev) => ({
        ...prev,
        [providerId]: {
          kind: "error",
          message: err instanceof Error ? err.message : String(err),
        },
      }))
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold">{t("settings.sections.llm.title")}</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("settings.sections.llm.description")}
          </p>
        </div>
        <Button
          size="icon-sm"
          variant="outline"
          onClick={() => setAddDialogOpen(true)}
          title="添加模型供应商"
        >
          <Plus className="h-4 w-4" />
        </Button>
      </div>

      {/* Built-in CLI providers */}
      <div className="space-y-2">
        <ClaudeCliStatusPill />
        <CodexCliStatusPill />
      </div>

      {/* Provider list */}
      <div className="space-y-2">
        {loading && (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        )}

        {error && (
          <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
            <AlertCircle className="mr-1 inline h-3.5 w-3.5" />
            {error}
          </div>
        )}

        {!loading && !error && providers.length === 0 && (
          <div className="rounded-lg border border-dashed border-muted-foreground/30 px-4 py-8 text-center">
            <p className="text-sm text-muted-foreground">
              还没有添加任何模型供应商，点击右上角的 <Plus className="inline h-3.5 w-3.5" /> 按钮添加
            </p>
          </div>
        )}

        {!loading &&
          providers.map((provider) => (
            <ProviderCard
              key={provider.id}
              provider={provider}
              assignment={assignment}
              onAssignmentChange={(key, model) =>
                void handleToggleAssignment(provider.id, key, model)
              }
              onUpdate={(data) => void handleUpdate(data)}
              onDelete={() => void handleDelete(provider.id)}
              onTest={() => void handleTest(provider.id)}
              testStatus={testStatuses[provider.id] ?? { kind: "idle" }}
            />
          ))}
      </div>

      {/* Assignment section summary */}
      {!loading && !error && providers.length > 0 && (
        <div className="rounded-lg border p-3">
          <div className="text-sm font-medium mb-2">当前功能分配</div>
          <div className="space-y-1 text-xs text-muted-foreground">
            <div className="flex items-center gap-2">
              <span className="w-24 shrink-0">对话 (chat):</span>
              {assignment.chat ? (
                <span className="text-foreground">
                  {providers.find((p) => p.id === assignment.chat?.provider_id)?.name ??
                    assignment.chat.provider_id}
                  {" / "}
                  {assignment.chat.model}
                </span>
              ) : (
                <span className="text-muted-foreground/60">未分配</span>
              )}
            </div>
            <div className="flex items-center gap-2">
              <span className="w-24 shrink-0">摄入 (ingest):</span>
              {assignment.ingest ? (
                <span className="text-foreground">
                  {providers.find((p) => p.id === assignment.ingest?.provider_id)?.name ??
                    assignment.ingest.provider_id}
                  {" / "}
                  {assignment.ingest.model}
                </span>
              ) : (
                <span className="text-muted-foreground/60">未分配</span>
              )}
            </div>
            <div className="flex items-center gap-2">
              <span className="w-24 shrink-0">维护 (maintenance):</span>
              {assignment.maintenance ? (
                <span className="text-foreground">
                  {providers.find((p) => p.id === assignment.maintenance?.provider_id)?.name ??
                    assignment.maintenance.provider_id}
                  {" / "}
                  {assignment.maintenance.model}
                </span>
              ) : (
                <span className="text-muted-foreground/60">未分配</span>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Add dialog */}
      <ProviderFormDialog
        open={addDialogOpen}
        onSave={(data) => void handleAdd(data)}
        onCancel={() => setAddDialogOpen(false)}
        confirmLabel="添加"
      />
    </div>
  )
}

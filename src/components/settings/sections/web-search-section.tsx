import { useState } from "react"
import { ChevronDown, ChevronRight } from "lucide-react"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { startWebAccessProxy } from "@/commands/web-access"
import {
  useWikiStore,
  type SearchApiConfig,
  type SearchProvider,
  type SearchProviderOverride,
  type WebAccessConfig,
} from "@/stores/wiki-store"
import { SERPAPI_ENGINE_OPTIONS, resolveSearchConfig } from "@/lib/web-search"
import { healthCheckWebAccess, normalizeDomainList, normalizeWebAccessConfig } from "@/lib/web-access"

const SEARCH_PROVIDERS = [
  {
    id: "tavily",
    label: "Tavily",
    hint: "用于深度研究的通用网页搜索。",
    keyPlaceholder: "输入 Tavily API Key（tavily.com）",
  },
  {
    id: "serpapi",
    label: "SerpApi",
    hint: "支持 Google、Bing、DuckDuckGo、Scholar、新闻、图片、视频、YouTube 等搜索源。",
    keyPlaceholder: "输入 SerpApi API Key（serpapi.com）",
  },
] as const

const DEFAULT_PROXY_SCRIPT_PLACEHOLDER = "%USERPROFILE%\.agents\skills\web-access\scripts\check-deps.mjs"

export function WebSearchSection() {
  const searchApiConfig = useWikiStore((s) => s.searchApiConfig)
  const setSearchApiConfig = useWikiStore((s) => s.setSearchApiConfig)
  const webAccessConfig = useWikiStore((s) => s.webAccessConfig)
  const setWebAccessConfig = useWikiStore((s) => s.setWebAccessConfig)
  const resolvedConfig = resolveSearchConfig(searchApiConfig)
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [savedId, setSavedId] = useState<string | null>(null)
  const [webAccessSaved, setWebAccessSaved] = useState(false)
  const [healthMessage, setHealthMessage] = useState<string | null>(null)
  const [checkingHealth, setCheckingHealth] = useState(false)
  const [startingProxy, setStartingProxy] = useState(false)

  async function persist(next: SearchApiConfig) {
    const { saveSearchApiConfig } = await import("@/lib/project-store")
    setSearchApiConfig(next)
    await saveSearchApiConfig(next)
  }

  async function persistWebAccess(next: WebAccessConfig) {
    const { saveWebAccessConfig } = await import("@/lib/project-store")
    const normalized = normalizeWebAccessConfig(next)
    setWebAccessConfig(normalized)
    await saveWebAccessConfig(normalized)
    setWebAccessSaved(true)
    setTimeout(() => setWebAccessSaved(false), 1500)
  }

  function updateProvider(id: Exclude<SearchProvider, "none">, patch: SearchProviderOverride) {
    const currentConfigs = resolvedConfig.providerConfigs ?? {}
    const merged = { ...(currentConfigs[id] ?? {}), ...patch }
    const nextConfigs = { ...currentConfigs, [id]: merged }
    const next = resolveSearchConfig({
      ...resolvedConfig,
      providerConfigs: nextConfigs,
    })
    persist(next).catch(() => {})
    setSavedId(id)
    setTimeout(() => setSavedId((cur) => (cur === id ? null : cur)), 1500)
  }

  function toggleActive(id: Exclude<SearchProvider, "none">) {
    const nextProvider = resolvedConfig.provider === id ? "none" : id
    persist(resolveSearchConfig({ ...resolvedConfig, provider: nextProvider })).catch(() => {})
  }

  function updateWebAccess(patch: Partial<WebAccessConfig>) {
    persistWebAccess({ ...webAccessConfig, ...patch }).catch(() => {})
  }

  async function checkWebAccessHealth() {
    setCheckingHealth(true)
    setHealthMessage(null)
    try {
      const result = await healthCheckWebAccess(webAccessConfig)
      setHealthMessage(result.message)
    } finally {
      setCheckingHealth(false)
    }
  }

  async function startLocalWebAccessProxy() {
    setStartingProxy(true)
    setHealthMessage(null)
    try {
      const result = await startWebAccessProxy(webAccessConfig.proxyScriptPath)
      setHealthMessage(result.message)
      window.setTimeout(() => {
        checkWebAccessHealth().catch(() => {})
      }, 2500)
    } catch (err) {
      setHealthMessage(err instanceof Error ? err.message : String(err))
    } finally {
      setStartingProxy(false)
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold">网页搜索（深度研究）</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          搜索提供商负责“发现 URL”；WebAccess 负责在允许时打开搜索结果页面并保存可引用的网页原文。
        </p>
      </div>

      <div className="space-y-2">
        {SEARCH_PROVIDERS.map((provider) => {
          const override = resolvedConfig.providerConfigs?.[provider.id]
          const isActive = resolvedConfig.provider === provider.id
          const hasConfig = !!override?.apiKey
          const isExpanded = !!expanded[provider.id]
          return (
            <div
              key={provider.id}
              className={`rounded-lg border transition-colors ${
                isActive ? "border-primary/60 bg-primary/5" : "border-border"
              }`}
            >
              <div className="flex items-center gap-3 px-3 py-2.5">
                <button
                  type="button"
                  onClick={() => setExpanded((prev) => ({ ...prev, [provider.id]: !prev[provider.id] }))}
                  className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-accent"
                  title={isExpanded ? "收起" : "展开"}
                >
                  {isExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                </button>

                <button
                  type="button"
                  onClick={() => setExpanded((prev) => ({ ...prev, [provider.id]: !prev[provider.id] }))}
                  className="min-w-0 flex-1 text-left"
                >
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium">{provider.label}</span>
                    {hasConfig && !isActive && (
                      <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                        已配置
                      </span>
                    )}
                    {isActive && (
                      <span className="shrink-0 rounded-full bg-primary/20 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                        使用中
                      </span>
                    )}
                    {savedId === provider.id && (
                      <span className="shrink-0 text-[10px] text-emerald-600">已保存</span>
                    )}
                  </div>
                  <div className="mt-0.5 truncate text-xs text-muted-foreground">
                    {provider.hint}
                  </div>
                </button>

                <button
                  type="button"
                  onClick={() => toggleActive(provider.id)}
                  className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors ${
                    isActive
                      ? "border-primary bg-primary"
                      : "border-muted-foreground/30 bg-muted-foreground/20 hover:bg-muted-foreground/30"
                  }`}
                  aria-label={isActive ? "停用" : "启用"}
                >
                  <span
                    className={`inline-block h-3.5 w-3.5 rounded-full bg-white shadow-sm ring-1 ring-black/10 transition-transform ${
                      isActive ? "translate-x-4" : "translate-x-0.5"
                    }`}
                  />
                </button>
              </div>

              {isExpanded && (
                <div className="space-y-4 border-t bg-background/50 px-4 py-3">
                  <div className="space-y-2">
                    <Label>API Key</Label>
                    <Input
                      type="password"
                      value={override?.apiKey ?? ""}
                      onChange={(e) => updateProvider(provider.id, { apiKey: e.target.value })}
                      placeholder={provider.keyPlaceholder}
                    />
                  </div>

                  {provider.id === "serpapi" && (
                    <SerpApiEnginePicker
                      value={override?.serpApiEngine ?? resolvedConfig.serpApiEngine ?? "google"}
                      onChange={(serpApiEngine) => updateProvider("serpapi", { serpApiEngine })}
                    />
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>

      <WebAccessCard
        config={webAccessConfig}
        saved={webAccessSaved}
        healthMessage={healthMessage}
        checkingHealth={checkingHealth}
        startingProxy={startingProxy}
        onPatch={updateWebAccess}
        onHealthCheck={checkWebAccessHealth}
        onStartProxy={startLocalWebAccessProxy}
      />
    </div>
  )
}

function WebAccessCard({
  config,
  saved,
  healthMessage,
  checkingHealth,
  startingProxy,
  onPatch,
  onHealthCheck,
  onStartProxy,
}: {
  config: WebAccessConfig
  saved: boolean
  healthMessage: string | null
  checkingHealth: boolean
  startingProxy: boolean
  onPatch: (patch: Partial<WebAccessConfig>) => void
  onHealthCheck: () => void
  onStartProxy: () => void
}) {
  return (
    <div className={`rounded-lg border p-4 ${config.enabled ? "border-primary/60 bg-primary/5" : "border-border"}`}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold">WebAccess 浏览器抓取增强</h3>
            {config.enabled && <span className="rounded-full bg-primary/20 px-1.5 py-0.5 text-[10px] font-medium text-primary">已启用</span>}
            {saved && <span className="text-[10px] text-emerald-600">已保存</span>}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            深度研究仍先用 Tavily/SerpApi 搜索；开启后，系统会只读打开搜索结果页面，抽取正文并保存到 raw/sources/web。
          </p>
        </div>
        <Toggle checked={config.enabled} onChange={(enabled) => onPatch({ enabled })} label={config.enabled ? "停用" : "启用"} />
      </div>

      <div className="mt-4 grid gap-4 md:grid-cols-2">
        <div className="space-y-2 md:col-span-2">
          <Label>WebAccess 本机代理地址</Label>
          <div className="flex gap-2">
            <Input
              value={config.endpoint}
              onChange={(e) => onPatch({ endpoint: e.target.value })}
              placeholder="http://localhost:3456"
            />
            <button
              type="button"
              onClick={onStartProxy}
              disabled={startingProxy}
              className="shrink-0 rounded-md border px-3 py-2 text-sm hover:bg-accent disabled:opacity-60"
            >
              {startingProxy ? "启动中…" : "启动本机代理"}
            </button>
            <button
              type="button"
              onClick={onHealthCheck}
              disabled={checkingHealth}
              className="shrink-0 rounded-md border px-3 py-2 text-sm hover:bg-accent disabled:opacity-60"
            >
              {checkingHealth ? "检查中…" : "检查连接"}
            </button>
          </div>
          {healthMessage && <p className="text-xs text-muted-foreground">{healthMessage}</p>}
        </div>

        <div className="space-y-2 md:col-span-2">
          <Label>WebAccess 启动脚本路径</Label>
          <Input
            value={config.proxyScriptPath ?? ""}
            onChange={(e) => onPatch({ proxyScriptPath: e.target.value })}
            placeholder={DEFAULT_PROXY_SCRIPT_PLACEHOLDER}
          />
          <p className="text-xs text-muted-foreground">
            留空时使用默认路径；点击“启动本机代理”只会执行 node check-deps.mjs，不会执行任意 shell 命令。
          </p>
        </div>

        <CheckboxRow
          label="允许只读浏览器抓取"
          description="仅打开、滚动、抽取正文并关闭页面；不点击、不登录、不填写表单。"
          checked={config.allowReadOnlyBrowser}
          onChange={(allowReadOnlyBrowser) => onPatch({ allowReadOnlyBrowser })}
        />
        <CheckboxRow
          label="后台自动研究可直接使用"
          description="关闭“每次任务确认”后，深度研究队列会自动抓取搜索结果页面。"
          checked={!config.requirePerTaskConsent}
          onChange={(autoUse) => onPatch({ requirePerTaskConsent: !autoUse })}
        />
        <CheckboxRow
          label="保存 Markdown 来源"
          description="保存到 raw/sources/web，并把引用锚定到本地来源文件。"
          checked={config.saveSourceMarkdown}
          onChange={(saveSourceMarkdown) => onPatch({ saveSourceMarkdown })}
        />
        <CheckboxRow
          label="点击 / 登录态操作"
          description="当前版本按安全策略禁用；后续需要独立风险门控。"
          checked={false}
          disabled
          onChange={() => {}}
        />

        <NumberField label="每次最多抓取页面数" value={config.maxPagesPerRun} min={1} max={20} onChange={(maxPagesPerRun) => onPatch({ maxPagesPerRun })} />
        <NumberField label="每页最大滚动次数" value={config.maxScrollsPerPage} min={0} max={10} onChange={(maxScrollsPerPage) => onPatch({ maxScrollsPerPage })} />
        <NumberField label="单页超时（毫秒）" value={config.timeoutMs} min={5000} max={120000} onChange={(timeoutMs) => onPatch({ timeoutMs })} />

        <DomainListField
          label="允许域名（可选）"
          description="留空表示允许所有公网 http/https 域名；每行一个域名。"
          value={config.allowedDomains}
          onChange={(allowedDomains) => onPatch({ allowedDomains })}
        />
        <DomainListField
          label="阻止域名"
          description="每行一个域名；阻止列表优先级高于允许列表。"
          value={config.blockedDomains}
          onChange={(blockedDomains) => onPatch({ blockedDomains })}
        />
      </div>
    </div>
  )
}

function SerpApiEnginePicker({
  value,
  onChange,
}: {
  value: string
  onChange: (value: string) => void
}) {
  const isCustom = value.length > 0 && !SERPAPI_ENGINE_OPTIONS.some((e) => e.value === value)

  return (
    <div className="space-y-2">
      <Label>搜索引擎 / 分类</Label>
      <div className="flex flex-wrap gap-1.5">
        {SERPAPI_ENGINE_OPTIONS.map((engine) => (
          <button
            key={engine.value}
            type="button"
            onClick={() => onChange(engine.value)}
            className={`rounded-md border px-2.5 py-1 text-xs transition-colors ${
              value === engine.value
                ? "border-primary bg-primary text-primary-foreground"
                : "border-border hover:bg-accent"
            }`}
            title={engine.hint}
          >
            {engine.label}
          </button>
        ))}
      </div>
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="自定义 SerpApi engine，例如 google_finance"
      />
      {isCustom && (
        <p className="text-xs text-muted-foreground">
          自定义引擎会作为 SerpApi 的 <code>engine</code> 参数发送。
        </p>
      )}
    </div>
  )
}

function Toggle({ checked, label, onChange }: { checked: boolean; label: string; onChange: (checked: boolean) => void }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors ${
        checked ? "border-primary bg-primary" : "border-muted-foreground/30 bg-muted-foreground/20 hover:bg-muted-foreground/30"
      }`}
      aria-label={label}
    >
      <span className={`inline-block h-3.5 w-3.5 rounded-full bg-white shadow-sm ring-1 ring-black/10 transition-transform ${checked ? "translate-x-4" : "translate-x-0.5"}`} />
    </button>
  )
}

function CheckboxRow({
  label,
  description,
  checked,
  disabled,
  onChange,
}: {
  label: string
  description: string
  checked: boolean
  disabled?: boolean
  onChange: (checked: boolean) => void
}) {
  return (
    <label className={`flex gap-3 rounded-md border p-3 ${disabled ? "opacity-60" : "cursor-pointer hover:bg-accent/50"}`}>
      <input
        type="checkbox"
        className="mt-1 h-4 w-4"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span>
        <span className="block text-sm font-medium">{label}</span>
        <span className="block text-xs text-muted-foreground">{description}</span>
      </span>
    </label>
  )
}

function NumberField({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string
  value: number
  min: number
  max: number
  onChange: (value: number) => void
}) {
  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      <Input
        type="number"
        min={min}
        max={max}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </div>
  )
}

function DomainListField({
  label,
  description,
  value,
  onChange,
}: {
  label: string
  description: string
  value: string[]
  onChange: (value: string[]) => void
}) {
  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      <textarea
        className="min-h-24 w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none ring-offset-background placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
        value={value.join("\n")}
        onChange={(e) => onChange(normalizeDomainList(e.target.value))}
        placeholder="example.com"
      />
      <p className="text-xs text-muted-foreground">{description}</p>
    </div>
  )
}

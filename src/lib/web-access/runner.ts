import { getHttpFetch } from "@/lib/tauri-fetch"
import { pageTextToMarkdown } from "./extract"
import type { WebAccessConfig, WebAccessExtractedPage, WebAccessPageResult, WebAccessTraceEvent } from "./contracts"
import { decideWebAccessUrl, normalizeWebAccessConfig, redactUrl, validateWebAccessEndpoint } from "./policy"

interface EvalPayload {
  title?: string
  finalUrl?: string
  text?: string
  ready?: string
}

export async function healthCheckWebAccess(config: Partial<WebAccessConfig>) {
  const normalized = normalizeWebAccessConfig(config)
  const endpointDecision = validateWebAccessEndpoint(normalized.endpoint)
  if (!endpointDecision.allowed) {
    return { ok: false, message: endpointDecision.reason ?? "WebAccess 地址不可用" }
  }

  try {
    const response = await requestWithTimeout(`${trimSlash(normalized.endpoint)}/health`, {
      timeoutMs: Math.min(normalized.timeoutMs, 10_000),
    })
    return {
      ok: response.ok,
      status: response.status,
      message: response.ok ? "WebAccess 代理可用" : `WebAccess 健康检查失败：HTTP ${response.status}`,
    }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) }
  }
}

export async function extractUrlWithWebAccess(
  url: string,
  config: Partial<WebAccessConfig>,
): Promise<WebAccessPageResult> {
  const normalized = normalizeWebAccessConfig(config)
  const trace: WebAccessTraceEvent[] = []
  const targetDecision = decideWebAccessUrl(url, normalized)
  trace.push(event("policy", targetDecision.allowed, { url, message: targetDecision.reason }))
  if (!targetDecision.allowed) {
    return { ok: false, trace, error: targetDecision.reason ?? "URL 被安全策略阻止" }
  }

  const endpointDecision = validateWebAccessEndpoint(normalized.endpoint)
  if (!endpointDecision.allowed) {
    trace.push(event("health", false, { message: endpointDecision.reason }))
    return { ok: false, trace, error: endpointDecision.reason ?? "WebAccess 地址不可用" }
  }

  if (!normalized.enabled || !normalized.allowReadOnlyBrowser) {
    const message = "WebAccess 未启用只读浏览器抓取"
    trace.push(event("health", false, { message }))
    return { ok: false, trace, error: message }
  }

  if (normalized.requirePerTaskConsent) {
    const message = "当前配置要求每次任务确认；后台自动研究不会隐式打开浏览器"
    trace.push(event("health", false, { message }))
    return { ok: false, trace, error: message }
  }

  let targetId: string | null = null
  try {
    const base = trimSlash(normalized.endpoint)
    const openUrl = `${base}/new?url=${encodeURIComponent(url)}`
    const opened = await requestJson(openUrl, { timeoutMs: normalized.timeoutMs })
    targetId = pickTargetId(opened)
    trace.push(event("open", !!targetId, { url, targetId: targetId ?? undefined, message: targetId ? undefined : "无法解析 WebAccess targetId" }))
    if (!targetId) return { ok: false, trace, error: "WebAccess 打开页面后没有返回 targetId" }

    for (let i = 0; i < normalized.maxScrollsPerPage; i++) {
      try {
        await requestJson(`${base}/scroll?target=${encodeURIComponent(targetId)}&direction=bottom`, {
          timeoutMs: Math.min(normalized.timeoutMs, 15_000),
        })
        trace.push(event("scroll", true, { targetId }))
      } catch (err) {
        trace.push(event("scroll", false, { targetId, message: errorMessage(err) }))
        break
      }
    }

    const payload = await waitForExtract(base, targetId, Math.min(normalized.timeoutMs, 12_000))
    const finalUrl = payload.finalUrl || url
    const redirectDecision = decideWebAccessUrl(finalUrl, normalized)
    if (!redirectDecision.allowed) {
      trace.push(event("extract", false, { url: finalUrl, targetId, message: redirectDecision.reason }))
      return { ok: false, trace, error: redirectDecision.reason ?? "跳转后的 URL 被安全策略阻止" }
    }

    const title = payload.title?.trim() || finalUrl
    const text = payload.text?.trim() || ""
    const markdown = pageTextToMarkdown(title, finalUrl, text)
    const page: WebAccessExtractedPage = {
      url,
      finalUrl,
      title,
      text,
      markdown,
      fetchedAt: new Date().toISOString(),
    }
    const emptyMessage = payload.ready
      ? `页面正文为空（readyState=${payload.ready}）`
      : "页面正文为空"
    trace.push(event("extract", text.length > 0, { url: finalUrl, targetId, message: text.length > 0 ? undefined : emptyMessage }))
    return { ok: text.length > 0, page, trace, error: text.length > 0 ? undefined : emptyMessage }
  } catch (err) {
    trace.push(event("error", false, { url, targetId: targetId ?? undefined, message: errorMessage(err) }))
    return { ok: false, trace, error: errorMessage(err) }
  } finally {
    if (targetId) {
      try {
        await requestJson(`${trimSlash(normalized.endpoint)}/close?target=${encodeURIComponent(targetId)}`, {
          timeoutMs: Math.min(normalized.timeoutMs, 10_000),
        })
        trace.push(event("close", true, { targetId }))
      } catch (err) {
        trace.push(event("close", false, { targetId, message: errorMessage(err) }))
      }
    }
  }
}

async function waitForExtract(base: string, targetId: string, timeoutMs: number): Promise<EvalPayload> {
  const deadline = Date.now() + timeoutMs
  let last: EvalPayload = { text: "" }

  while (Date.now() <= deadline) {
    last = await evalExtract(base, targetId, Math.min(timeoutMs, 8_000))
    if ((last.text ?? "").trim().length > 0) return last
    await sleep(750)
  }

  return last
}

async function evalExtract(base: string, targetId: string, timeoutMs: number): Promise<EvalPayload> {
  const script = `(() => {
    const text = (document.body && document.body.innerText) || (document.documentElement && document.documentElement.innerText) || "";
    return JSON.stringify({
      title: document.title || "",
      finalUrl: location.href,
      ready: document.readyState || "",
      text
    });
  })()`
  const raw = await requestJson(`${base}/eval?target=${encodeURIComponent(targetId)}`, {
    method: "POST",
    headers: { "content-type": "text/plain;charset=utf-8" },
    body: script,
    timeoutMs,
  })
  const value = unwrapEvalValue(raw)
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as EvalPayload
    } catch {
      return { text: value }
    }
  }
  if (value && typeof value === "object") return value as EvalPayload
  return { text: "" }
}

async function requestJson(url: string, init: RequestInit & { timeoutMs: number }) {
  const response = await requestWithTimeout(url, init)
  const text = await response.text()
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`)
  }
  if (!text.trim()) return null
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

async function requestWithTimeout(url: string, init: RequestInit & { timeoutMs: number }) {
  const httpFetch = await getHttpFetch()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), init.timeoutMs)
  try {
    return await httpFetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

function pickTargetId(value: unknown): string | null {
  if (typeof value === "string") return value
  if (!value || typeof value !== "object") return null
  const record = value as Record<string, unknown>
  const candidates = [
    record.id,
    record.targetId,
    record.target,
    (record.target as Record<string, unknown> | undefined)?.id,
    (record.data as Record<string, unknown> | undefined)?.id,
    (record.result as Record<string, unknown> | undefined)?.id,
  ]
  const found = candidates.find((candidate) => typeof candidate === "string" && candidate.length > 0)
  return typeof found === "string" ? found : null
}

function unwrapEvalValue(value: unknown): unknown {
  if (!value || typeof value !== "object") return value
  const record = value as Record<string, unknown>
  return record.value ?? (record.result as Record<string, unknown> | undefined)?.value ?? record.result ?? record.data ?? value
}

function event(
  type: WebAccessTraceEvent["type"],
  ok: boolean,
  extra: Partial<Omit<WebAccessTraceEvent, "type" | "ok" | "at">> = {},
): WebAccessTraceEvent {
  return {
    at: new Date().toISOString(),
    type,
    ok,
    ...extra,
    url: extra.url ? redactUrl(extra.url) : undefined,
  }
}

function trimSlash(value: string): string {
  return value.replace(/\/+$/, "")
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

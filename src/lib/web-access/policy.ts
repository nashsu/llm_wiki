import { DEFAULT_WEB_ACCESS_CONFIG, type WebAccessConfig, type WebAccessPolicyDecision } from "./contracts"

const BLOCKED_SCHEMES = new Set(["file:", "data:", "javascript:", "chrome:", "edge:", "about:"])

export function normalizeWebAccessConfig(config?: Partial<WebAccessConfig> | null): WebAccessConfig {
  return {
    ...DEFAULT_WEB_ACCESS_CONFIG,
    ...(config ?? {}),
    allowedDomains: normalizeDomainList(config?.allowedDomains ?? DEFAULT_WEB_ACCESS_CONFIG.allowedDomains),
    blockedDomains: normalizeDomainList(config?.blockedDomains ?? DEFAULT_WEB_ACCESS_CONFIG.blockedDomains),
    maxPagesPerRun: clampInt(config?.maxPagesPerRun, 1, 20, DEFAULT_WEB_ACCESS_CONFIG.maxPagesPerRun),
    maxScrollsPerPage: clampInt(config?.maxScrollsPerPage, 0, 10, DEFAULT_WEB_ACCESS_CONFIG.maxScrollsPerPage),
    timeoutMs: clampInt(config?.timeoutMs, 5_000, 120_000, DEFAULT_WEB_ACCESS_CONFIG.timeoutMs),
  }
}

export function validateWebAccessEndpoint(endpoint: string): WebAccessPolicyDecision {
  let parsed: URL
  try {
    parsed = new URL(endpoint)
  } catch {
    return { allowed: false, reason: "WebAccess 地址不是有效 URL" }
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { allowed: false, reason: "WebAccess 地址只允许 http/https" }
  }

  const host = stripBrackets(parsed.hostname).toLowerCase()
  if (!isLocalhost(host)) {
    return { allowed: false, reason: "当前版本只允许连接本机 WebAccess 代理" }
  }

  return { allowed: true }
}

export function decideWebAccessUrl(url: string, config: WebAccessConfig): WebAccessPolicyDecision {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return { allowed: false, reason: "目标地址不是有效 URL" }
  }

  if (BLOCKED_SCHEMES.has(parsed.protocol)) {
    return { allowed: false, reason: `禁止访问 ${parsed.protocol} 协议` }
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { allowed: false, reason: "只允许访问 http/https 网页" }
  }

  const host = stripBrackets(parsed.hostname).toLowerCase()
  if (isPrivateOrLocalHost(host)) {
    return { allowed: false, reason: "禁止访问本机、私网、链路本地或云元数据地址" }
  }

  if (domainMatches(host, config.blockedDomains)) {
    return { allowed: false, reason: "目标域名命中阻止列表" }
  }

  if (config.allowedDomains.length > 0 && !domainMatches(host, config.allowedDomains)) {
    return { allowed: false, reason: "目标域名不在允许列表" }
  }

  return { allowed: true }
}

export function normalizeDomainList(input: string[] | string | undefined | null): string[] {
  const values = Array.isArray(input) ? input : String(input ?? "").split(/[\n,;]/)
  return Array.from(
    new Set(
      values
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean)
        .map((value) => value.replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^\*\./, "")),
    ),
  )
}

export function domainMatches(host: string, domains: string[]): boolean {
  return domains.some((domain) => host === domain || host.endsWith(`.${domain}`))
}

export function redactUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl)
    const sensitive = ["key", "api_key", "token", "access_token", "password", "pwd", "secret", "code"]
    for (const key of Array.from(url.searchParams.keys())) {
      if (sensitive.some((part) => key.toLowerCase().includes(part))) {
        url.searchParams.set(key, "[redacted]")
      }
    }
    return url.toString()
  } catch {
    return rawUrl.replace(/([?&][^=]*(?:key|token|password|secret|code)[^=]*=)[^&\s]+/gi, "$1[redacted]")
  }
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(parsed)))
}

function stripBrackets(host: string): string {
  return host.replace(/^\[/, "").replace(/\]$/, "")
}

function isLocalhost(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "::1"
}

function isPrivateOrLocalHost(host: string): boolean {
  if (isLocalhost(host)) return true
  if (host === "0.0.0.0" || host === "metadata.google.internal") return true

  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    const [a, b] = host.split(".").map(Number)
    if (a === 10) return true
    if (a === 127) return true
    if (a === 169 && b === 254) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
    if (a === 100 && b >= 64 && b <= 127) return true
    if (a === 0) return true
  }

  const lower = host.toLowerCase()
  if (lower === "::1" || lower.startsWith("fe80:") || lower.startsWith("fc") || lower.startsWith("fd")) {
    return true
  }

  return false
}

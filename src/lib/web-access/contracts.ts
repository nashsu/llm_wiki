export interface WebAccessConfig {
  enabled: boolean
  endpoint: string
  proxyScriptPath?: string
  allowReadOnlyBrowser: boolean
  requirePerTaskConsent: boolean
  allowClick: boolean
  allowLoginContext: boolean
  maxPagesPerRun: number
  maxScrollsPerPage: number
  timeoutMs: number
  saveSourceMarkdown: boolean
  allowedDomains: string[]
  blockedDomains: string[]
}

export const DEFAULT_WEB_ACCESS_CONFIG: WebAccessConfig = {
  enabled: false,
  endpoint: "http://localhost:3456",
  proxyScriptPath: "",
  allowReadOnlyBrowser: false,
  requirePerTaskConsent: true,
  allowClick: false,
  allowLoginContext: false,
  maxPagesPerRun: 5,
  maxScrollsPerPage: 2,
  timeoutMs: 30_000,
  saveSourceMarkdown: true,
  allowedDomains: [],
  blockedDomains: [],
}

export interface WebAccessPolicyDecision {
  allowed: boolean
  reason?: string
}

export interface WebAccessExtractedPage {
  url: string
  finalUrl: string
  title: string
  text: string
  markdown: string
  fetchedAt: string
}

export interface WebAccessEvidence {
  id: string
  url: string
  finalUrl: string
  title: string
  quote: string
  fetchedAt: string
  contentHash: string
  artifactPath: string
  method: "webaccess-cdp"
}

export interface WebAccessTraceEvent {
  at: string
  type: "policy" | "open" | "scroll" | "extract" | "save" | "close" | "error" | "health"
  url?: string
  targetId?: string
  ok: boolean
  message?: string
}

export interface WebAccessRunTrace {
  runId: string
  topic: string
  startedAt: string
  finishedAt?: string
  events: WebAccessTraceEvent[]
  evidence: WebAccessEvidence[]
}

export interface WebAccessPageResult {
  ok: boolean
  page?: WebAccessExtractedPage
  trace: WebAccessTraceEvent[]
  error?: string
}

export interface WebAccessArtifactResult {
  evidence: WebAccessEvidence
  absolutePath: string
}

export interface WebAccessCollection {
  runId: string
  evidence: WebAccessEvidence[]
  tracePath?: string
  warnings: string[]
}

import type { WebSearchResult } from "@/lib/web-search"
import type { WebAccessCollection, WebAccessConfig } from "./contracts"
import { buildTrace, createWebAccessRunId, persistWebAccessPage, persistWebAccessTrace } from "./artifacts"
import { extractUrlWithWebAccess } from "./runner"
import { normalizeWebAccessConfig } from "./policy"

export async function collectWebAccessSources(
  projectPath: string,
  taskId: string,
  topic: string,
  results: WebSearchResult[],
  config: Partial<WebAccessConfig>,
): Promise<WebAccessCollection> {
  const normalized = normalizeWebAccessConfig(config)
  const runId = createWebAccessRunId(taskId)
  const trace = buildTrace(runId, topic)
  const warnings: string[] = []
  const urls = results
    .map((result) => result.url)
    .filter((url, index, all) => all.indexOf(url) === index)
    .slice(0, normalized.maxPagesPerRun)

  let ordinal = 1
  for (const url of urls) {
    const extracted = await extractUrlWithWebAccess(url, normalized)
    trace.events.push(...extracted.trace)
    if (!extracted.ok || !extracted.page) {
      if (extracted.error) warnings.push(`${url}: ${extracted.error}`)
      continue
    }

    try {
      const artifact = await persistWebAccessPage(projectPath, runId, extracted.page, ordinal)
      trace.evidence.push(artifact.evidence)
      trace.events.push({
        at: new Date().toISOString(),
        type: "save",
        ok: true,
        url: artifact.evidence.finalUrl,
        message: artifact.evidence.artifactPath,
      })
      ordinal += 1
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      warnings.push(`${url}: 保存 WebAccess 来源失败：${message}`)
      trace.events.push({
        at: new Date().toISOString(),
        type: "save",
        ok: false,
        url,
        message,
      })
    }
  }

  trace.finishedAt = new Date().toISOString()
  let tracePath: string | undefined
  try {
    tracePath = await persistWebAccessTrace(projectPath, trace)
  } catch (err) {
    warnings.push(`保存 WebAccess trace 失败：${err instanceof Error ? err.message : String(err)}`)
  }

  return { runId, evidence: trace.evidence, tracePath, warnings }
}

export * from "./contracts"
export { healthCheckWebAccess } from "./runner"
export { decideWebAccessUrl, normalizeWebAccessConfig, normalizeDomainList, validateWebAccessEndpoint } from "./policy"

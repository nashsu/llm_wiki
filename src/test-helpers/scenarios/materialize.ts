/**
 * Materializes a scenario's TS definition onto disk so the runner can
 * exercise the real FS code path and so humans can inspect/debug the
 * generated fixture files directly. Output dir is gitignored.
 */
import fs from "node:fs/promises"
import path from "node:path"

/**
 * Minimal shape every scenario shares: name, description, initialWiki,
 * optional llmResponse, expected. Scenario-specific fields (reviews for
 * sweep, pageToEnrich for enrich, etc.) are picked up opportunistically.
 */
type AnyScenario = {
  name: string
  description: string
  initialWiki: Record<string, string>
  llmResponse?: string
  expected: unknown
  // optional per-domain fields
  reviews?: unknown
  pageToEnrich?: string
  source?: { path: string; content: string }
  analysisResponse?: string
  generationResponse?: string
  query?: string
}

export async function materializeScenario(
  scenario: AnyScenario,
  rootDir: string,
): Promise<{ scenarioPath: string }> {
  const scenarioPath = path.join(rootDir, scenario.name)

  // Wipe any previous materialization so stale files can't influence the test
  await fs.rm(scenarioPath, { recursive: true, force: true })
  await fs.mkdir(scenarioPath, { recursive: true })

  // initial-wiki/ — the project state before the tested operation runs
  const wikiDir = path.join(scenarioPath, "initial-wiki")
  for (const [relPath, content] of Object.entries(scenario.initialWiki)) {
    const full = path.join(wikiDir, relPath)
    await fs.mkdir(path.dirname(full), { recursive: true })
    await fs.writeFile(full, content, "utf-8")
  }

  // reviews.json — only for sweep scenarios
  if (scenario.reviews !== undefined) {
    await fs.writeFile(
      path.join(scenarioPath, "reviews.json"),
      JSON.stringify(scenario.reviews, null, 2),
      "utf-8",
    )
  }

  // page-to-enrich.txt — only for enrich scenarios; stored as a pointer file
  if (scenario.pageToEnrich !== undefined) {
    await fs.writeFile(
      path.join(scenarioPath, "page-to-enrich.txt"),
      scenario.pageToEnrich,
      "utf-8",
    )
  }

  // llm-response.txt — raw text the mocked streamChat will emit (if any)
  if (scenario.llmResponse !== undefined) {
    await fs.writeFile(
      path.join(scenarioPath, "llm-response.txt"),
      scenario.llmResponse,
      "utf-8",
    )
  }

  // Ingest scenarios emit TWO LLM responses (stage 1 analysis + stage 2 generation).
  if (scenario.analysisResponse !== undefined) {
    await fs.writeFile(
      path.join(scenarioPath, "llm-analysis.txt"),
      scenario.analysisResponse,
      "utf-8",
    )
  }
  if (scenario.generationResponse !== undefined) {
    await fs.writeFile(
      path.join(scenarioPath, "llm-generation.txt"),
      scenario.generationResponse,
      "utf-8",
    )
  }

  // Source doc for ingest scenarios — materialize it under initial-wiki/
  // at the scenario-declared path.
  if (scenario.source !== undefined) {
    const sourceFull = path.join(scenarioPath, "initial-wiki", scenario.source.path)
    await fs.mkdir(path.dirname(sourceFull), { recursive: true })
    await fs.writeFile(sourceFull, scenario.source.content, "utf-8")
    // Also record the path for the runner to read
    await fs.writeFile(
      path.join(scenarioPath, "source-path.txt"),
      scenario.source.path,
      "utf-8",
    )
  }

  // Search scenarios record the query
  if (scenario.query !== undefined) {
    await fs.writeFile(
      path.join(scenarioPath, "query.txt"),
      scenario.query,
      "utf-8",
    )
  }

  // expected.json — what the operation should produce
  await fs.writeFile(
    path.join(scenarioPath, "expected.json"),
    JSON.stringify(scenario.expected, null, 2),
    "utf-8",
  )

  // description.md — human-friendly summary so `find .` results are readable
  await fs.writeFile(
    path.join(scenarioPath, "description.md"),
    `# ${scenario.name}\n\n${scenario.description}\n`,
    "utf-8",
  )

  return { scenarioPath }
}

/** Recursively copy a directory. Used to clone initial-wiki into a tmp project. */
export async function copyDir(src: string, dst: string): Promise<void> {
  await fs.mkdir(dst, { recursive: true })
  const entries = await fs.readdir(src, { withFileTypes: true })
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name)
    const dstPath = path.join(dst, entry.name)
    if (entry.isDirectory()) {
      await copyDir(srcPath, dstPath)
    } else {
      await fs.copyFile(srcPath, dstPath)
    }
  }
}

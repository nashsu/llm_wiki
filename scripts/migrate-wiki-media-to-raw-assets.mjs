#!/usr/bin/env node
import { applyWikiMediaMigration, planWikiMediaMigration } from "./lib/wiki-media-migration.mjs"

function printUsage() {
  console.error("Usage: node scripts/migrate-wiki-media-to-raw-assets.mjs <project-path> [--dry-run|--apply] [--json]")
  console.error("Default mode is dry-run. Use --apply to move files, rewrite links, and remove wiki/media.")
  console.error("Options: --dry-run, --apply, --json, --help")
}

const args = parseArgs(process.argv.slice(2))

if (args.help) {
  printUsage()
  process.exit(0)
}

if (args.error) {
  console.error(`[wiki-media-migration] ${args.error}`)
  printUsage()
  process.exit(1)
}

if (!args.projectPath) {
  console.error("[wiki-media-migration] Missing project path.")
  printUsage()
  process.exit(1)
}

const result = args.apply
  ? await applyWikiMediaMigration(args.projectPath)
  : await planWikiMediaMigration(args.projectPath)

if (args.json) {
  console.log(JSON.stringify(result, null, 2))
} else {
  console.log(`[wiki-media-migration] mode=${result.mode}`)
  console.log(`[wiki-media-migration] project=${result.projectPath}`)
  console.log(`[wiki-media-migration] files=${result.counts.filesFound} move=${result.counts.move} conflict=${result.counts.moveConflict} dedupe=${result.counts.dedupeDeleteSource}`)
  console.log(`[wiki-media-migration] markdown=${result.counts.markdownFilesChanged}/${result.counts.markdownFilesScanned} links=${result.counts.linksRewritten}`)
  if (result.applied) {
    console.log(`[wiki-media-migration] applied moved=${result.applied.moved} deduped=${result.applied.deduped} rewritten=${result.applied.rewrittenFiles} removedMediaRoot=${result.applied.removedMediaRoot}`)
  }
  for (const warning of result.warnings) {
    console.warn(`[wiki-media-migration] warning: ${warning}`)
  }
}

function parseArgs(argv) {
  const out = { apply: false, dryRun: false, json: false, help: false, projectPath: "" }
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") out.help = true
    else if (arg === "--apply") out.apply = true
    else if (arg === "--dry-run") out.dryRun = true
    else if (arg === "--json") out.json = true
    else if (arg.startsWith("--")) out.error = `Unknown option: ${arg}`
    else if (!out.projectPath) out.projectPath = arg
    else out.error = `Unexpected extra argument: ${arg}`
  }
  if (out.apply && out.dryRun) out.error = "Choose either --dry-run or --apply, not both."
  return out
}

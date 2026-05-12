#!/usr/bin/env node

import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const appPath = process.env.LLM_WIKI_APP_PATH || "/Applications/LLM Wiki.app"
const executablePath = path.join(appPath, "Contents", "MacOS", "llm-wiki")
const distAssetsPath = process.env.LLM_WIKI_DIST_ASSETS_PATH || path.join(repoRoot, "dist", "assets")
const localTargetPath = process.env.LLM_WIKI_TARGET_PATH || path.join(repoRoot, "src-tauri", "target")
const codesignBin = process.env.LLM_WIKI_CODESIGN_BIN || process.env.LLM_WIKI_CODESIGN || "/usr/bin/codesign"
const stringsBin = process.env.LLM_WIKI_STRINGS_BIN || "/usr/bin/strings"
const psBin = process.env.LLM_WIKI_PS_BIN || "/bin/ps"
const defaultStaleTargetMarkers = [
  "llm_wiki-codexian",
  "/Users/kevin/codex/projects/llm_wiki-codexian",
]
const staleTargetMarkers = (process.env.LLM_WIKI_STALE_TARGET_MARKERS || defaultStaleTargetMarkers.join(","))
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean)
let signedBundleExecutableMtime = null

function fail(message) {
  console.error(`[verify:macos-app] ${message}`)
  process.exit(1)
}

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  })
}

function commandSucceeds(command, args) {
  try {
    run(command, args)
    return true
  } catch {
    return false
  }
}

function assertExists(target, label) {
  if (!fs.existsSync(target)) fail(`Missing ${label}: ${target}`)
}

function slug(value) {
  return value
    .trim()
    .toLowerCase()
    .replace(/\.md$/i, "")
    .replace(/\s+/g, "-")
}

function walkMarkdownFiles(root) {
  const files = []
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name)
    if (entry.isDirectory()) files.push(...walkMarkdownFiles(target))
    else if (entry.isFile() && entry.name.endsWith(".md")) files.push(target)
  }
  return files
}

function shouldScanTargetFile(name) {
  return (
    name === "output" ||
    name === "root-output" ||
    name.endsWith(".d") ||
    name.endsWith(".json") ||
    name.endsWith(".toml") ||
    name.endsWith(".txt")
  )
}

function readTargetProbe(filePath) {
  const stat = fs.statSync(filePath)
  const maxBytes = 2 * 1024 * 1024
  const fd = fs.openSync(filePath, "r")
  try {
    const firstSize = Math.min(stat.size, maxBytes)
    const first = Buffer.alloc(firstSize)
    fs.readSync(fd, first, 0, firstSize, 0)
    if (stat.size <= maxBytes) return first.toString("utf8")

    const last = Buffer.alloc(maxBytes)
    fs.readSync(fd, last, 0, maxBytes, stat.size - maxBytes)
    return `${first.toString("utf8")}\n${last.toString("utf8")}`
  } finally {
    fs.closeSync(fd)
  }
}

function verifyLocalBuildTarget() {
  if (process.env.LLM_WIKI_SKIP_TARGET_STALE_CHECK === "1") {
    console.log("[verify:macos-app] local target stale-path check skipped by LLM_WIKI_SKIP_TARGET_STALE_CHECK=1")
    return
  }
  if (!fs.existsSync(localTargetPath)) return

  const hits = []
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const target = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        visit(target)
        if (hits.length >= 5) return
        continue
      }
      if (!entry.isFile() || !shouldScanTargetFile(entry.name)) continue
      const content = readTargetProbe(target)
      const marker = staleTargetMarkers.find((value) => content.includes(value))
      if (marker) {
        hits.push({ file: target, marker })
        if (hits.length >= 5) return
      }
    }
  }

  visit(localTargetPath)
  if (hits.length > 0) {
    fail(
      [
        "Local src-tauri/target contains stale pre-rename path markers.",
        `Target: ${localTargetPath}`,
        "Move or rebuild the target directory before trusting this app bundle.",
        `Matches: ${hits.map((hit) => `${path.relative(repoRoot, hit.file)} (${hit.marker})`).join(", ")}`,
      ].join("\n"),
    )
  }

  console.log("[verify:macos-app] local target stale-path check passed")
}

function verifyBundle() {
  assertExists(appPath, "installed app bundle")
  assertExists(executablePath, "installed app executable")
  assertExists(distAssetsPath, "dist assets; run `npm run build` first")

  if (process.env.LLM_WIKI_SKIP_ADHOC_SIGN === "1") {
    console.log("[verify:macos-app] ad-hoc signing skipped by LLM_WIKI_SKIP_ADHOC_SIGN=1")
  } else if (
    process.env.LLM_WIKI_FORCE_ADHOC_SIGN !== "1" &&
    commandSucceeds(codesignBin, ["--verify", "--deep", "--strict", "--verbose=2", appPath])
  ) {
    console.log(`[verify:macos-app] ad-hoc signing skipped; bundle signature already valid: ${appPath}`)
  } else {
    signedBundleExecutableMtime = fs.statSync(executablePath).mtime.getTime()
    run(codesignBin, ["--force", "--deep", "--sign", "-", appPath])
    console.log(`[verify:macos-app] ad-hoc signing completed: ${appPath}`)
  }

  run(codesignBin, ["--verify", "--deep", "--strict", "--verbose=2", appPath])

  const installedStrings = run(stringsBin, [executablePath])
  const requiredAssets = fs
    .readdirSync(distAssetsPath)
    .filter((name) => /^(ingest|sweep-reviews)-[A-Za-z0-9_-]+\.js$/.test(name))

  if (requiredAssets.length === 0) {
    fail("No ingest/sweep review assets found in dist/assets.")
  }

  const missingAssets = requiredAssets.filter((name) => !installedStrings.includes(`/assets/${name}`))
  if (missingAssets.length > 0) {
    fail(`Installed app does not include current dist assets: ${missingAssets.join(", ")}`)
  }

  console.log(`[verify:macos-app] installed bundle verified: ${appPath}`)
  console.log(`[verify:macos-app] matched assets: ${requiredAssets.join(", ")}`)
}

function verifyRunningProcess() {
  if (process.env.LLM_WIKI_ALLOW_NOT_RUNNING === "1") {
    console.log("[verify:macos-app] running-process check skipped by LLM_WIKI_ALLOW_NOT_RUNNING=1")
    return
  }

  const ps = run(psBin, ["-axo", "pid,lstart,args"])
  const lines = ps
    .split("\n")
    .filter((line) => line.includes(executablePath))

  if (lines.length === 0) {
    fail(`LLM Wiki is not running from ${executablePath}`)
  }

  const executableMtime = signedBundleExecutableMtime ?? fs.statSync(executablePath).mtime.getTime()
  const runningAfterInstall = lines.some((line) => {
    const match = line.match(/^\s*(\d+)\s+([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/)
    if (!match) return false
    const startedAt = Date.parse(match[2])
    return Number.isFinite(startedAt) && startedAt >= executableMtime
  })

  if (!runningAfterInstall) {
    fail("LLM Wiki is running, but the process appears to have started before the installed executable was updated.")
  }

  console.log(`[verify:macos-app] running process verified: ${lines.map((line) => line.trim()).join(" | ")}`)
}

function verifyVault() {
  const vaultPath = process.env.LLM_WIKI_VERIFY_VAULT
  if (!vaultPath) return

  const queuePath = path.join(vaultPath, ".llm-wiki", "ingest-queue.json")
  const reviewPath = path.join(vaultPath, ".llm-wiki", "review.json")
  const wikiPath = path.join(vaultPath, "wiki")
  assertExists(queuePath, "vault ingest queue")
  assertExists(reviewPath, "vault review file")
  assertExists(wikiPath, "vault wiki directory")

  const queue = JSON.parse(fs.readFileSync(queuePath, "utf8"))
  if (!Array.isArray(queue) || queue.length !== 0) {
    fail(`Vault ingest queue is not drained: ${queuePath}`)
  }

  const sourceName = process.env.LLM_WIKI_VERIFY_SOURCE
  if (sourceName) {
    const reviewData = JSON.parse(fs.readFileSync(reviewPath, "utf8"))
    const items = Array.isArray(reviewData) ? reviewData : reviewData.items
    const pendingMissing = (items || []).filter((item) => {
      const sourcePath = typeof item.sourcePath === "string" ? item.sourcePath : ""
      return !item.resolved && item.type === "missing-page" && sourcePath.includes(sourceName)
    })
    if (pendingMissing.length > 0) {
      fail(`Pending missing-page reviews remain for ${sourceName}: ${pendingMissing.map((item) => item.title).join(", ")}`)
    }
  }

  const verifyPages = (process.env.LLM_WIKI_VERIFY_PAGES || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)

  if (verifyPages.length > 0) {
    const markdownFiles = walkMarkdownFiles(wikiPath)
    const known = new Set()
    for (const file of markdownFiles) {
      known.add(path.basename(file, ".md").toLowerCase())
      known.add(slug(path.basename(file, ".md")))
      const content = fs.readFileSync(file, "utf8")
      const title = content.match(/^title:\s*["']?(.+?)["']?\s*$/m)
      if (title) {
        known.add(title[1].trim().toLowerCase())
        known.add(slug(title[1]))
      }
    }

    for (const relPath of verifyPages) {
      const pagePath = path.join(vaultPath, relPath)
      assertExists(pagePath, `verification page ${relPath}`)
      const content = fs.readFileSync(pagePath, "utf8")
      const links = Array.from(content.matchAll(/\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]/g)).map((match) => match[1].trim())
      const missing = Array.from(new Set(links.filter((link) => !known.has(link.toLowerCase()) && !known.has(slug(link)))))
      if (missing.length > 0) {
        fail(`${relPath} has unresolved wikilinks: ${missing.join(", ")}`)
      }
    }
  }

  console.log(`[verify:macos-app] vault proof verified: ${vaultPath}`)
}

verifyLocalBuildTarget()
verifyBundle()
verifyRunningProcess()
verifyVault()
console.log("[verify:macos-app] ok")

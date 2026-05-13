import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"

import {
  applyWikiMediaMigration,
  mapLegacyMediaUrl,
  planWikiMediaMigration,
  rewriteMediaLinks,
} from "./lib/wiki-media-migration.mjs"

const cliPath = path.join(import.meta.dirname, "migrate-wiki-media-to-raw-assets.mjs")

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "llm-wiki-media-migration-"))
  await fs.mkdir(path.join(root, "wiki", "media", "paper"), { recursive: true })
  await fs.mkdir(path.join(root, "wiki", "sources"), { recursive: true })
  await fs.mkdir(path.join(root, "raw", "assets"), { recursive: true })
  return root
}

test("plans wiki/media to raw/assets moves and markdown rewrites without applying", async () => {
  const root = await fixture()
  await fs.writeFile(path.join(root, "wiki", "media", "paper", "img-1.png"), "image-one")
  await fs.writeFile(
    path.join(root, "wiki", "sources", "paper.md"),
    [
      "# Paper",
      "![](media/paper/img-1.png)",
      "<img src=\"wiki/media/paper/img-1.png\">",
    ].join("\n"),
  )

  const plan = await planWikiMediaMigration(root)

  assert.equal(plan.counts.filesFound, 1)
  assert.equal(plan.counts.move, 1)
  assert.equal(plan.counts.linksRewritten, 2)
  assert.equal(await fs.readFile(path.join(root, "wiki", "sources", "paper.md"), "utf8"), [
    "# Paper",
    "![](media/paper/img-1.png)",
    "<img src=\"wiki/media/paper/img-1.png\">",
  ].join("\n"))
})

test("applies move, rewrites links, and removes wiki/media", async () => {
  const root = await fixture()
  await fs.writeFile(path.join(root, "wiki", "media", "paper", "img-1.png"), "image-one")
  await fs.writeFile(
    path.join(root, "wiki", "sources", "paper.md"),
    "# Paper\n![](media/paper/img-1.png)\n",
  )

  const result = await applyWikiMediaMigration(root)

  assert.equal(result.applied.moved, 1)
  assert.equal(result.applied.rewrittenFiles, 1)
  assert.equal(result.applied.removedMediaRoot, true)
  assert.equal(await fs.readFile(path.join(root, "raw", "assets", "paper", "img-1.png"), "utf8"), "image-one")
  assert.equal(await fs.readFile(path.join(root, "wiki", "sources", "paper.md"), "utf8"), "# Paper\n![](raw/assets/paper/img-1.png)\n")
  await assert.rejects(fs.stat(path.join(root, "wiki", "media")))
})

test("dedupes identical existing raw/assets files", async () => {
  const root = await fixture()
  await fs.mkdir(path.join(root, "raw", "assets", "paper"), { recursive: true })
  await fs.writeFile(path.join(root, "wiki", "media", "paper", "img-1.png"), "same")
  await fs.writeFile(path.join(root, "raw", "assets", "paper", "img-1.png"), "same")
  await fs.writeFile(path.join(root, "wiki", "sources", "paper.md"), "![](media/paper/img-1.png)")

  const result = await applyWikiMediaMigration(root)

  assert.equal(result.applied.deduped, 1)
  assert.equal(await fs.readFile(path.join(root, "raw", "assets", "paper", "img-1.png"), "utf8"), "same")
  assert.equal(await fs.readFile(path.join(root, "wiki", "sources", "paper.md"), "utf8"), "![](raw/assets/paper/img-1.png)")
})

test("renames conflicting existing raw/assets files without overwriting", async () => {
  const root = await fixture()
  await fs.mkdir(path.join(root, "raw", "assets", "paper"), { recursive: true })
  await fs.writeFile(path.join(root, "wiki", "media", "paper", "img-1.png"), "old-media")
  await fs.writeFile(path.join(root, "raw", "assets", "paper", "img-1.png"), "new-asset")
  await fs.writeFile(path.join(root, "wiki", "sources", "paper.md"), "![](media/paper/img-1.png)")

  const result = await applyWikiMediaMigration(root)

  assert.equal(result.applied.moved, 1)
  assert.equal(await fs.readFile(path.join(root, "raw", "assets", "paper", "img-1.png"), "utf8"), "new-asset")
  assert.equal(await fs.readFile(path.join(root, "raw", "assets", "paper", "img-1.legacy-1.png"), "utf8"), "old-media")
  assert.equal(await fs.readFile(path.join(root, "wiki", "sources", "paper.md"), "utf8"), "![](raw/assets/paper/img-1.legacy-1.png)")
})

test("maps legacy URLs only inside image references", () => {
  const root = "/Users/me/Wiki"
  const map = new Map([["media/paper/img.png", "raw/assets/paper/img.png"]])

  assert.equal(mapLegacyMediaUrl("media/paper/img.png", root, map), "raw/assets/paper/img.png")
  assert.equal(mapLegacyMediaUrl("wiki/media/paper/img.png", root, map), "raw/assets/paper/img.png")
  assert.equal(mapLegacyMediaUrl("/Users/me/Wiki/wiki/media/paper/img.png", root, map), "raw/assets/paper/img.png")
  assert.equal(mapLegacyMediaUrl("raw/assets/paper/img.png", root, map), null)

  const rewritten = rewriteMediaLinks(
    "Plain media/paper/img.png stays. ![](media/paper/img.png)",
    root,
    map,
  )
  assert.equal(rewritten.content, "Plain media/paper/img.png stays. ![](raw/assets/paper/img.png)")
  assert.equal(rewritten.replacements, 1)
})

test("migration CLI defaults to dry-run JSON output", async () => {
  const root = await fixture()
  await fs.writeFile(path.join(root, "wiki", "media", "paper", "img-1.png"), "image-one")

  const result = spawnSync(process.execPath, [cliPath, root, "--json"], {
    encoding: "utf8",
  })

  assert.equal(result.status, 0, result.stderr)
  const report = JSON.parse(result.stdout)
  assert.equal(report.mode, "dry-run")
  assert.equal(report.counts.filesFound, 1)
  assert.equal(await fs.readFile(path.join(root, "wiki", "media", "paper", "img-1.png"), "utf8"), "image-one")
})

test("migration CLI rejects ambiguous or unknown options", async () => {
  const root = await fixture()

  const ambiguous = spawnSync(process.execPath, [cliPath, root, "--dry-run", "--apply"], {
    encoding: "utf8",
  })
  assert.equal(ambiguous.status, 1)
  assert.match(ambiguous.stderr, /Choose either --dry-run or --apply/)

  const unknown = spawnSync(process.execPath, [cliPath, root, "--force"], {
    encoding: "utf8",
  })
  assert.equal(unknown.status, 1)
  assert.match(unknown.stderr, /Unknown option: --force/)
})

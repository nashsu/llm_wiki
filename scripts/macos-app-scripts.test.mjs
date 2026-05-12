import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

const repoRoot = path.resolve(import.meta.dirname, "..")
const verifyScript = path.join(repoRoot, "scripts", "verify-macos-app.mjs")
const installScript = path.join(repoRoot, "scripts", "install-macos-app.sh")

test("verify-macos-app skips ad-hoc signing when the bundle signature is already valid", async () => {
  const fixture = await makeVerifyFixture()
  try {
    const result = runVerify(fixture)
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /ad-hoc signing skipped; bundle signature already valid/)
    assert.doesNotMatch(readFileSync(fixture.codesignLog, "utf8"), /--force/)
  } finally {
    rmSync(fixture.root, { recursive: true, force: true })
  }
})

test("verify-macos-app ad-hoc signs a target bundle when strict verification is missing", async () => {
  const fixture = await makeVerifyFixture({ validSignature: false })
  try {
    const result = runVerify(fixture)
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /ad-hoc signing completed/)
    assert.match(readFileSync(fixture.codesignLog, "utf8"), /--force --deep --sign -/)
  } finally {
    rmSync(fixture.root, { recursive: true, force: true })
  }
})

test("verify-macos-app fails when a configured target fixture contains stale pre-rename paths", async () => {
  const fixture = await makeVerifyFixture()
  try {
    const target = path.join(fixture.root, "target")
    await fs.mkdir(target, { recursive: true })
    await fs.writeFile(path.join(target, "output"), "old path: /Users/kevin/codex/projects/llm_wiki-codexian\n")
    const result = runVerify(fixture, { skipTargetCheck: false, target })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /Local src-tauri\/target contains stale pre-rename path markers/)
  } finally {
    rmSync(fixture.root, { recursive: true, force: true })
  }
})

test("install-macos-app migrates legacy app support and clears legacy runtime caches in a temp fixture", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "llm-wiki-install-"))
  try {
    const fakeBin = path.join(root, "bin")
    const home = path.join(root, "home")
    const sourceApp = path.join(root, "source", "LLM Wiki.app")
    const destApp = path.join(root, "Applications", "LLM Wiki.app")
    const backupRoot = path.join(root, "backups")
    const legacySupport = path.join(home, "Library", "Application Support", "com.llmwiki.app")
    const legacyCache = path.join(home, "Library", "Caches", "com.llmwiki.app")

    assert.equal(destApp.startsWith("/Applications/"), false)
    await fs.mkdir(path.join(sourceApp, "Contents", "MacOS"), { recursive: true })
    await fs.writeFile(path.join(sourceApp, "Contents", "MacOS", "llm-wiki"), "fixture /assets/logo-test.jpg\n")
    await fs.mkdir(legacySupport, { recursive: true })
    await fs.writeFile(path.join(legacySupport, "app-state.json"), "{\"ok\":true}\n")
    await fs.mkdir(legacyCache, { recursive: true })
    await fs.writeFile(path.join(legacyCache, "cache.txt"), "cached\n")
    await installFakeCommands(fakeBin)

    const result = spawnSync("bash", [installScript], {
      cwd: repoRoot,
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH}`,
        HOME: home,
        SOURCE_APP: sourceApp,
        DEST_APP: destApp,
        BACKUP_ROOT: backupRoot,
        LSREGISTER: path.join(fakeBin, "lsregister"),
      },
      encoding: "utf8",
    })

    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /Migrated app support: com\.llmwiki\.app -> com\.llmwiki\.desktop/)
    assert.match(result.stdout, /Installed .*LLM Wiki\.app/)
    assert.equal(
      await fs.readFile(path.join(home, "Library", "Application Support", "com.llmwiki.desktop", "app-state.json"), "utf8"),
      "{\"ok\":true}\n",
    )
    await assert.rejects(fs.access(legacyCache))
    const backupDir = path.join(backupRoot, readdirSync(backupRoot)[0])
    assert.equal(await fs.readFile(path.join(backupDir, "com.llmwiki.app.cache", "cache.txt"), "utf8"), "cached\n")
    assert.match(await fs.readFile(path.join(destApp, "Contents", "MacOS", "llm-wiki"), "utf8"), /\/assets\/logo-test\.jpg/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

async function makeVerifyFixture({ validSignature = true } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "llm-wiki-verify-"))
  const app = path.join(root, "LLM Wiki.app")
  const executable = path.join(app, "Contents", "MacOS", "llm-wiki")
  const distAssets = path.join(root, "dist", "assets")
  const fakeBin = path.join(root, "bin")
  const codesignLog = path.join(root, "codesign.log")
  const signedMarker = path.join(root, "signed")

  await fs.mkdir(path.dirname(executable), { recursive: true })
  await fs.mkdir(distAssets, { recursive: true })
  await fs.mkdir(fakeBin, { recursive: true })
  await fs.writeFile(path.join(distAssets, "ingest-test.js"), "")
  await fs.writeFile(path.join(distAssets, "sweep-reviews-test.js"), "")
  await fs.writeFile(executable, "/assets/ingest-test.js\n/assets/sweep-reviews-test.js\n")
  if (validSignature) await fs.writeFile(signedMarker, "signed\n")

  await fs.writeFile(
    path.join(fakeBin, "codesign"),
    [
      "#!/usr/bin/env bash",
      `echo "$*" >> "${codesignLog}"`,
      `SIGNED_MARKER="${signedMarker}"`,
      "if [[ \"$*\" == *\"--force\"* ]]; then",
      "  touch \"${SIGNED_MARKER}\"",
      "  exit 0",
      "fi",
      "if [[ -f \"${SIGNED_MARKER}\" ]]; then",
      "  exit 0",
      "fi",
      "exit 1",
      "",
    ].join("\n"),
    { mode: 0o755 },
  )

  return {
    root,
    app,
    distAssets,
    codesignLog,
    codesignBin: path.join(fakeBin, "codesign"),
  }
}

function runVerify(fixture, options = {}) {
  return spawnSync(process.execPath, [verifyScript], {
    cwd: repoRoot,
    env: {
      ...process.env,
      LLM_WIKI_APP_PATH: fixture.app,
      LLM_WIKI_DIST_ASSETS_PATH: fixture.distAssets,
      LLM_WIKI_CODESIGN_BIN: fixture.codesignBin,
      LLM_WIKI_ALLOW_NOT_RUNNING: "1",
      LLM_WIKI_SKIP_TARGET_STALE_CHECK: options.skipTargetCheck === false ? "0" : "1",
      LLM_WIKI_TARGET_PATH: options.target || path.join(fixture.root, "empty-target"),
    },
    encoding: "utf8",
  })
}

async function installFakeCommands(fakeBin) {
  await fs.mkdir(fakeBin, { recursive: true })
  const commands = {
    codesign: "#!/usr/bin/env bash\nexit 0\n",
    chflags: "#!/usr/bin/env bash\nexit 0\n",
    osascript: "#!/usr/bin/env bash\nexit 0\n",
    pgrep: "#!/usr/bin/env bash\nexit 1\n",
    pkill: "#!/usr/bin/env bash\nexit 0\n",
    lsregister: "#!/usr/bin/env bash\nexit 0\n",
    ditto: "#!/usr/bin/env bash\nmkdir -p \"$(dirname \"$2\")\"\ncp -R \"$1\" \"$2\"\n",
  }

  for (const [name, content] of Object.entries(commands)) {
    await fs.writeFile(path.join(fakeBin, name), content, { mode: 0o755 })
  }
}

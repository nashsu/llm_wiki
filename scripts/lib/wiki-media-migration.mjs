import crypto from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"

function toPosix(value) {
  return value.replace(/\\/g, "/")
}

async function exists(filePath) {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

async function sha256(filePath) {
  const bytes = await fs.readFile(filePath)
  return crypto.createHash("sha256").update(bytes).digest("hex")
}

async function listFiles(root, warnings, base = root) {
  let entries
  try {
    entries = await fs.readdir(root, { withFileTypes: true })
  } catch (err) {
    if (err && err.code === "ENOENT") return []
    throw err
  }

  const out = []
  for (const entry of entries) {
    const abs = path.join(root, entry.name)
    if (entry.isSymbolicLink()) {
      warnings.push(`Skipped symlink under wiki/media: ${toPosix(path.relative(base, abs))}`)
      continue
    }
    if (entry.isDirectory()) {
      out.push(...(await listFiles(abs, warnings, base)))
      continue
    }
    if (entry.isFile()) out.push(abs)
  }
  return out
}

async function findConflictTarget(target, sourceHash) {
  const parsed = path.parse(target)
  for (let i = 1; i <= 999; i++) {
    const candidate = path.join(parsed.dir, `${parsed.name}.legacy-${i}${parsed.ext}`)
    if (!(await exists(candidate))) {
      return { action: "move-conflict", dest: candidate }
    }
    if ((await sha256(candidate)) === sourceHash) {
      return { action: "dedupe-delete-source", dest: candidate }
    }
  }
  throw new Error(`Could not find a conflict-safe filename for ${target}`)
}

function buildRelMap(operations) {
  const relMap = new Map()
  for (const op of operations) {
    relMap.set(op.legacyRel, op.newRel)
    relMap.set(`wiki/${op.legacyRel}`, op.newRel)
  }
  return relMap
}

export function mapLegacyMediaUrl(url, projectPath, relMap) {
  const normalizedProject = toPosix(path.resolve(projectPath)).replace(/\/+$/, "")
  const cleaned = toPosix(url).replace(/^\.\//, "")
  const absolutePrefix = `${normalizedProject}/wiki/media/`
  const fileAbsolutePrefix = `file://${absolutePrefix}`

  let key = ""
  if (cleaned.startsWith("media/")) {
    key = cleaned
  } else if (cleaned.startsWith("wiki/media/")) {
    key = cleaned.slice("wiki/".length)
  } else if (cleaned.startsWith(absolutePrefix)) {
    key = `media/${cleaned.slice(absolutePrefix.length)}`
  } else if (cleaned.startsWith(fileAbsolutePrefix)) {
    key = `media/${cleaned.slice(fileAbsolutePrefix.length)}`
  }

  return key ? relMap.get(key) ?? null : null
}

export function rewriteMediaLinks(content, projectPath, relMap) {
  let replacements = 0
  const rewriteUrl = (url) => {
    const mapped = mapLegacyMediaUrl(url, projectPath, relMap)
    if (!mapped) return url
    replacements++
    return mapped
  }

  const markdown = content.replace(
    /(!\[[^\]]*]\()([^)\s]+)((?:\s+["'][^)]*["'])?\))/g,
    (whole, open, url, close) => {
      const nextUrl = rewriteUrl(url)
      return nextUrl === url ? whole : `${open}${nextUrl}${close}`
    },
  )

  const html = markdown.replace(
    /(<img\b[^>]*?\bsrc\s*=\s*["'])([^"']+)(["'][^>]*>)/gi,
    (whole, open, url, close) => {
      const nextUrl = rewriteUrl(url)
      return nextUrl === url ? whole : `${open}${nextUrl}${close}`
    },
  )

  return { content: html, replacements }
}

async function collectMarkdownRewrites(projectRoot, relMap) {
  const wikiRoot = path.join(projectRoot, "wiki")
  const warnings = []
  const files = (await listFiles(wikiRoot, warnings)).filter((file) => file.endsWith(".md"))
  const rewrites = []
  let scanned = 0
  let linksRewritten = 0
  for (const file of files) {
    scanned++
    const before = await fs.readFile(file, "utf8")
    const result = rewriteMediaLinks(before, projectRoot, relMap)
    if (result.replacements > 0) {
      rewrites.push({
        path: file,
        replacements: result.replacements,
        content: result.content,
      })
      linksRewritten += result.replacements
    }
  }
  return { scanned, rewrites, linksRewritten, warnings }
}

export async function planWikiMediaMigration(projectPath) {
  const projectRoot = path.resolve(projectPath)
  const mediaRoot = path.join(projectRoot, "wiki", "media")
  const assetsRoot = path.join(projectRoot, "raw", "assets")
  const warnings = []
  const operations = []

  if (!(await exists(mediaRoot))) {
    return {
      mode: "dry-run",
      projectPath: projectRoot,
      mediaRoot,
      assetsRoot,
      operations,
      rewrites: [],
      counts: {
        filesFound: 0,
        move: 0,
        moveConflict: 0,
        dedupeDeleteSource: 0,
        markdownFilesScanned: 0,
        markdownFilesChanged: 0,
        linksRewritten: 0,
      },
      warnings,
      canRemoveMediaRoot: true,
    }
  }

  const files = await listFiles(mediaRoot, warnings)
  for (const src of files) {
    const rel = toPosix(path.relative(mediaRoot, src))
    const target = path.join(assetsRoot, rel)
    const sourceHash = await sha256(src)
    let action = "move"
    let dest = target
    if (await exists(target)) {
      const targetHash = await sha256(target)
      if (targetHash === sourceHash) {
        action = "dedupe-delete-source"
      } else {
        const conflict = await findConflictTarget(target, sourceHash)
        action = conflict.action
        dest = conflict.dest
      }
    }
    const newRel = toPosix(path.relative(projectRoot, dest))
    operations.push({
      action,
      src,
      dest,
      legacyRel: `media/${rel}`,
      newRel,
      sha256: sourceHash,
    })
  }

  const relMap = buildRelMap(operations)
  const rewritePlan = await collectMarkdownRewrites(projectRoot, relMap)
  warnings.push(...rewritePlan.warnings)

  return {
    mode: "dry-run",
    projectPath: projectRoot,
    mediaRoot,
    assetsRoot,
    operations,
    rewrites: rewritePlan.rewrites,
    counts: {
      filesFound: files.length,
      move: operations.filter((op) => op.action === "move").length,
      moveConflict: operations.filter((op) => op.action === "move-conflict").length,
      dedupeDeleteSource: operations.filter((op) => op.action === "dedupe-delete-source").length,
      markdownFilesScanned: rewritePlan.scanned,
      markdownFilesChanged: rewritePlan.rewrites.length,
      linksRewritten: rewritePlan.linksRewritten,
    },
    warnings,
    canRemoveMediaRoot: warnings.every((warning) => !warning.startsWith("Skipped symlink")),
  }
}

async function moveFile(src, dest) {
  await fs.mkdir(path.dirname(dest), { recursive: true })
  try {
    await fs.rename(src, dest)
  } catch (err) {
    if (!err || err.code !== "EXDEV") throw err
    await fs.copyFile(src, dest)
    await fs.unlink(src)
  }
}

export async function applyWikiMediaMigration(projectPath) {
  const plan = await planWikiMediaMigration(projectPath)
  const applied = {
    moved: 0,
    deduped: 0,
    rewrittenFiles: 0,
    linksRewritten: 0,
    removedMediaRoot: false,
  }

  for (const op of plan.operations) {
    if (op.action === "dedupe-delete-source") {
      await fs.unlink(op.src)
      applied.deduped++
      continue
    }
    await moveFile(op.src, op.dest)
    applied.moved++
  }

  const relMap = buildRelMap(plan.operations)
  const rewritePlan = await collectMarkdownRewrites(plan.projectPath, relMap)
  for (const rewrite of rewritePlan.rewrites) {
    await fs.writeFile(rewrite.path, rewrite.content)
    applied.rewrittenFiles++
    applied.linksRewritten += rewrite.replacements
  }

  if (plan.canRemoveMediaRoot) {
    await fs.rm(plan.mediaRoot, { recursive: true, force: true })
    applied.removedMediaRoot = true
  }

  return {
    ...plan,
    mode: "apply",
    applied,
  }
}

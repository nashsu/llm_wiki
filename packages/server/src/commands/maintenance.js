import fs from "node:fs"
import fsp from "node:fs/promises"
import path from "node:path"
import { countWikilinks } from "../graph.js"

// Node port of src-tauri/src/commands/project_maintenance.rs: project archive
// export/import (zip) and wiki index rebuild. Uses jszip (already a project
// dependency) so the web client's "Export / Import project" and "Rebuild
// index" buttons work exactly as on the desktop.

const fwd = (p) => p.split(path.sep).join("/")
const MAX_ARCHIVE_ENTRIES = 200000
const MAX_ARCHIVE_BYTES = 4 * 1024 * 1024 * 1024

function isSafeRel(name) {
  if (!name || name.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(name)) return false
  const parts = name.split(/[\\/]/)
  return !parts.some((p) => p === "..")
}

async function exportProjectArchive({ projectPath, destination }) {
  if (!path.isAbsolute(projectPath) || !path.isAbsolute(destination)) {
    throw new Error("Project and archive paths must be absolute")
  }
  const root = fs.realpathSync(projectPath)
  const output = path.resolve(destination)
  if (output.startsWith(root + path.sep) || output === root) {
    throw new Error("Export destination must be outside the project directory")
  }
  const JSZip = (await import("jszip")).default
  const zip = new JSZip()
  const walk = async (dir, rel) => {
    const entries = await fsp.readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      const name = rel ? `${rel}/${entry.name}` : entry.name
      let st
      try { st = await fsp.lstat(full) } catch { continue }
      if (st.isSymbolicLink()) continue
      if (st.isDirectory()) {
        zip.folder(name)
        await walk(full, name)
      } else if (st.isFile()) {
        zip.file(name, await fsp.readFile(full))
      }
    }
  }
  await walk(root, "")
  const buf = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" })
  await fsp.mkdir(path.dirname(output), { recursive: true })
  await fsp.writeFile(output, buf)
}

async function importProjectArchive({ archivePath, destination }) {
  if (!path.isAbsolute(archivePath) || !path.isAbsolute(destination)) {
    throw new Error("Archive and destination paths must be absolute")
  }
  const JSZip = (await import("jszip")).default
  const buf = await fsp.readFile(archivePath)
  const zip = await JSZip.loadAsync(buf)
  const entries = Object.values(zip.files)
  if (entries.length > MAX_ARCHIVE_ENTRIES) throw new Error("Project archive contains too many entries")
  let expanded = 0
  let hasIndex = false
  for (const e of entries) {
    if (!isSafeRel(e.name)) throw new Error(`Unsafe archive path: ${e.name}`)
    if ((e.unixPermissions & 0o170000) === 0o120000) {
      throw new Error(`Archive contains an unsupported symbolic link: ${e.name}`)
    }
    hasIndex = hasIndex || (!e.dir && e.name.replace(/^\/+/, "") === "wiki/index.md")
    if (!e.dir) expanded += e._data?.uncompressedSize ?? 0
    if (expanded > MAX_ARCHIVE_BYTES) throw new Error("Project archive exceeds 4 GB expanded limit")
  }
  if (!hasIndex) throw new Error("Archive is not an LLM Wiki project (wiki/index.md is missing)")
  const root = path.resolve(destination)
  if (fs.existsSync(root) && (await fsp.readdir(root)).length > 0) {
    throw new Error("Import destination must be empty")
  }
  await fsp.mkdir(root, { recursive: true })
  for (const e of entries) {
    const target = path.join(root, e.name)
    if (e.dir) { await fsp.mkdir(target, { recursive: true }); continue }
    await fsp.mkdir(path.dirname(target), { recursive: true })
    await fsp.writeFile(target, await e.async("nodebuffer"))
  }
  return fwd(root)
}

function frontmatterValue(content, key) {
  const normalized = content.replace(/\r\n/g, "\n")
  if (!normalized.startsWith("---\n")) return null
  const body = normalized.slice(4).split("\n---")[0]
  for (const line of body.split("\n")) {
    const idx = line.indexOf(":")
    if (idx < 0) continue
    const name = line.slice(0, idx).trim()
    if (name !== key) continue
    const value = line.slice(idx + 1).trim().replace(/^["']|["']$/g, "")
    if (value) return value
  }
  return null
}

async function rebuildWikiIndex({ projectPath }) {
  const wiki = path.join(projectPath, "wiki")
  const groups = new Map()
  // Best-effort graph edge tally across the pages the rebuild reads, so the
  // route can report edgesChanged in its graph:updated frame (stage 4).
  let links = 0
  const walk = async (dir) => {
    let entries
    try { entries = await fsp.readdir(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) { await walk(full); continue }
      if (!entry.name.endsWith(".md")) continue
      const stem = entry.name.replace(/\.md$/i, "")
      if (["index", "overview", "log"].includes(stem.toLowerCase())) continue
      const content = await fsp.readFile(full, "utf-8")
      links += countWikilinks(content)
      const kind = frontmatterValue(content, "type") || "other"
      const title = frontmatterValue(content, "title") || stem
      const target = fwd(path.relative(wiki, full)).replace(/\.md$/i, "")
      if (!groups.has(kind)) groups.set(kind, [])
      groups.get(kind).push([target, title])
    }
  }
  await walk(wiki)
  for (const pages of groups.values()) pages.sort((a, b) => a[1].toLowerCase().localeCompare(b[1].toLowerCase()))
  const sortedKinds = [...groups.keys()].sort()
  let count = 0
  let output = "# Wiki Index\n\n"
  for (const kind of sortedKinds) {
    const pages = groups.get(kind)
    count += pages.length
    output += `## ${kind}\n\n`
    for (const [slug, title] of pages) output += `- [[${slug}|${title}]]\n`
    output += "\n"
  }
  const indexPath = path.join(wiki, "index.md")
  const tmp = path.join(wiki, ".index.md.rebuild.tmp")
  await fsp.writeFile(tmp, output, "utf-8")
  await fsp.rename(tmp, indexPath)
  return { pages: count, groups: groups.size, links }
}

export const maintenanceCommands = {
  export_project_archive: exportProjectArchive,
  import_project_archive: importProjectArchive,
  rebuild_wiki_index: rebuildWikiIndex,
}

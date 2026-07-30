import fs from "node:fs"
import fsp from "node:fs/promises"
import path from "node:path"
import crypto from "node:crypto"
import { recordFileVersion, listFileHistory, restoreFileHistory } from "./fileHistory.js"
import { preprocessFile as preprocessBinary } from "./preprocess.js"
import { markAppWrite } from "../appwrite.js"

// Node port of the filesystem Tauri commands (src-tauri/src/commands/fs.rs).
// Paths are normalized to forward slashes on the way out so the TS layer
// can compare/compose them consistently, matching the Rust behavior.

const fwd = (p) => p.split(path.sep).join("/")

function assertAbsoluteFsPath(op, p) {
  if (!path.isAbsolute(p)) throw new Error(`${op} requires an absolute path, got: ${p}`)
}

const MIME_BY_EXT = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
  webp: "image/webp", bmp: "image/bmp", tiff: "image/tiff", tif: "image/tiff",
  svg: "image/svg+xml", pdf: "application/pdf",
}

// Extensions we can extract text from directly in the browser-server (no
// native parsers). Binary formats (pdf/docx/xlsx/epub/mobi/images) need the
// desktop Rust backend and report a clear, actionable error instead.
const TEXT_EXTS = new Set([
  "md", "markdown", "txt", "text", "org", "rst", "adoc", "csv", "tsv",
  "json", "jsonl", "yaml", "yml", "toml", "ini", "conf", "cfg", "log",
  "html", "htm", "xml", "css", "js", "mjs", "ts", "tsx", "jsx", "py",
  "rb", "go", "rs", "java", "c", "h", "cpp", "hpp", "sh", "sql", "tex",
  "bib", "srt", "vtt",
])

function entryIsVisible(name, includeHidden) {
  return includeHidden || !name.startsWith(".")
}

function buildTree(dir, depth, maxDepth, includeHidden) {
  if (depth >= maxDepth) return []
  let entries
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) }
  catch (e) { throw new Error(`Failed to read directory '${dir}': ${e.message}`) }
  const visible = entries.filter((e) => entryIsVisible(e.name, includeHidden))
  visible.sort((a, b) => {
    const ad = a.isDirectory(), bd = b.isDirectory()
    if (ad && !bd) return -1
    if (!ad && bd) return 1
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
  })
  const nodes = []
  for (const entry of visible) {
    const full = path.join(dir, entry.name)
    const isDir = entry.isDirectory()
    const node = { name: entry.name, path: fwd(full), is_dir: isDir }
    if (isDir) {
      const kids = buildTree(full, depth + 1, maxDepth, includeHidden)
      if (kids.length) node.children = kids
    }
    nodes.push(node)
  }
  return nodes
}

async function readFile({ path: p, extractImages }) {
  const buf = await fsp.readFile(p)
  // extractImages only matters for native PDF rendering; in web mode we
  // return the textual content best-effort.
  return buf.toString("utf-8")
}

async function writeFile({ path: p, contents }) {
  assertAbsoluteFsPath("writeFile", p)
  await fsp.mkdir(path.dirname(p), { recursive: true })
  await fsp.writeFile(p, contents ?? "", "utf-8")
  markAppWrite(p)
}

async function writeFileBase64({ path: p, base64 }) {
  assertAbsoluteFsPath("writeFileBase64", p)
  await fsp.mkdir(path.dirname(p), { recursive: true })
  await fsp.writeFile(p, Buffer.from(base64, "base64"))
  markAppWrite(p)
}

async function writeFileAtomic({ path: p, contents }) {
  assertAbsoluteFsPath("writeFileAtomic", p)
  await fsp.mkdir(path.dirname(p), { recursive: true })
  const tmp = `${p}.${process.pid}.${Date.now()}.tmp`
  await fsp.writeFile(tmp, contents ?? "", "utf-8")
  await fsp.rename(tmp, p)
  markAppWrite(p)
}

async function listDirectory({ path: p, includeHidden, maxDepth }) {
  const inc = includeHidden ?? false
  let md = maxDepth ?? 30
  md = Math.max(1, Math.min(30, md))
  if (!fs.existsSync(p)) throw new Error(`Path does not exist: '${p}'`)
  if (!fs.statSync(p).isDirectory()) throw new Error(`Path is not a directory: '${p}'`)
  return buildTree(p, 0, md, inc)
}

async function copyFile({ source, destination }) {
  await fsp.mkdir(path.dirname(destination), { recursive: true })
  await fsp.copyFile(source, destination)
}

async function copyDirectory({ source, destination }) {
  const created = []
  await fsp.mkdir(destination, { recursive: true })
  created.push(fwd(destination))
  const walk = async (src, dest) => {
    const entries = await fsp.readdir(src, { withFileTypes: true })
    for (const entry of entries) {
      const s = path.join(src, entry.name)
      const d = path.join(dest, entry.name)
      if (entry.isDirectory()) {
        await fsp.mkdir(d, { recursive: true })
        created.push(fwd(d))
        await walk(s, d)
      } else {
        await fsp.copyFile(s, d)
        created.push(fwd(d))
      }
    }
  }
  await walk(source, destination)
  return created
}

async function preprocessFile(args) {
  // Full multi-format extraction (PDF/Office/ODF/EPUB/MOBI/Org/text) lives in
  // preprocess.js so the browser ingest pipeline gets the same text the
  // desktop app produces from binary documents.
  return preprocessBinary(args)
}

async function deleteFile({ path: p }) {
  const stat = await fsp.lstat(p).catch(() => null)
  if (!stat) return
  if (stat.isDirectory()) await fsp.rm(p, { recursive: true, force: true })
  else await fsp.rm(p, { force: true })
}

async function createDirectory({ path: p }) {
  assertAbsoluteFsPath("createDirectory", p)
  await fsp.mkdir(p, { recursive: true })
}

async function fileExists({ path: p }) {
  return fs.existsSync(p)
}

async function getFileModifiedTime({ path: p }) {
  const stat = await fsp.stat(p)
  return Math.floor(stat.mtimeMs)
}

async function getFileSize({ path: p }) {
  const stat = await fsp.stat(p)
  return stat.size
}

async function getFileMd5({ path: p }) {
  const buf = await fsp.readFile(p)
  return crypto.createHash("md5").update(buf).digest("hex")
}

async function readFileAsBase64({ path: p }) {
  const buf = await fsp.readFile(p)
  const ext = (path.extname(p).slice(1) || "").toLowerCase()
  return { base64: buf.toString("base64"), mimeType: MIME_BY_EXT[ext] || "application/octet-stream" }
}

async function applyTextSelectionEdit({ projectPath, filePath, prefix, selectedText, suffix, replacement }) {
  const project = fs.realpathSync(projectPath)
  const file = fs.realpathSync(filePath)
  if (!file.startsWith(project) || !fs.statSync(file).isFile()) {
    throw new Error("Selection edit target must be an existing file inside the project")
  }
  const current = await fsp.readFile(file, "utf-8")
  const expected = `${prefix}${selectedText}${suffix}`
  if (current !== expected) {
    throw new Error("The file changed after the selection was captured. Re-select the text before applying the Agent suggestion.")
  }
  const updated = `${prefix}${replacement}${suffix}`
  recordFileVersion(file, "baseline", "before.agent.selection_edit")
  await fsp.writeFile(file, updated, "utf-8")
  recordFileVersion(file, "agent", "agent.selection_edit")
  markAppWrite(file)
  return updated
}

function safeMissingPageStem(title) {
  let stem = ""
  for (const ch of title) {
    if (/[\x00-\x1f]/.test(ch) || "<>:\"/\\|?*".includes(ch)) stem += "-"
    else if (/\s/.test(ch)) stem += " "
    else stem += ch
  }
  while (stem.includes("--")) stem = stem.replace(/--/g, "-")
  stem = stem.replace(/^[ .-]+|[ .-]+$/g, "")
  if (!stem) stem = "untitled"
  const device = (stem.split(".")[0] || "").toUpperCase()
  const reserved = device === "CON" || device === "PRN" || device === "AUX" || device === "NUL" ||
    (device.length === 4 && (device.startsWith("COM") || device.startsWith("LPT")) &&
      /[1-9]/.test(device[3]))
  if (reserved) stem = `page-${stem}`
  return [...stem].slice(0, 120).join("")
}

async function createMissingWikiPage({ projectPath, title, content }) {
  const project = fs.realpathSync(projectPath)
  let t = (title || "").trim()
  if (!t || [...t].length > 200) throw new Error("Missing-link page title must contain 1 to 200 characters")
  t = [...t].map((c) => (/[\x00-\x1f]/.test(c) ? " " : c)).join("").trim()
  if (content && content.length > 2 * 1024 * 1024) throw new Error("Missing-link page content exceeds the 2 MB limit")
  const wikiRoot = path.join(project, "wiki")
  const directory = path.join(wikiRoot, "concepts")
  await fsp.mkdir(directory, { recursive: true })
  const base = safeMissingPageStem(t)
  let target = path.join(directory, `${base}.md`)
  for (let suffix = 2; suffix <= 9999; suffix++) {
    if (!fs.existsSync(target)) break
    target = path.join(directory, `${base}-${suffix}.md`)
  }
  if (fs.existsSync(target)) throw new Error("Could not allocate a unique wiki page filename")
  const today = new Date().toISOString().slice(0, 10)
  const escaped = t.replace(/"/g, '\\"')
  const defaultContent = `---\ntype: concept\ntitle: "${escaped}"\ncreated: ${today}\nupdated: ${today}\ntags: []\nrelated: []\n---\n\n# ${t}\n`
  const body = content && content.trim() ? content : defaultContent
  await fsp.writeFile(target, body, { encoding: "utf-8", flag: "wx" })
  recordFileVersion(target, "agent", "wiki.missing_link.create")
  markAppWrite(target)
  return fwd(path.relative(project, target))
}

function collectRelatedPages(dir, sourceName, results) {
  let entries
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
  const fileName = path.basename(sourceName)
  const fileNameLower = fileName.toLowerCase()
  const dotIdx = fileName.lastIndexOf(".")
  const fileStem = dotIdx > 0 ? fileName.slice(0, dotIdx) : fileName
  const fileStemLower = fileStem ? fileStem.toLowerCase() : fileNameLower
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      collectRelatedPages(full, sourceName, results)
    } else if (entry.name.endsWith(".md")) {
      const fname = entry.name
      if (fname === "index.md" || fname === "log.md" || fname === "overview.md") continue
      let content
      try { content = fs.readFileSync(full, "utf-8") } catch { continue }
      const contentLower = content.toLowerCase()
      const sourcesMatch = contentLower.includes(`"${fileNameLower}"`) || contentLower.includes(`'${fileNameLower}'`)
      const inSourcesDir = full.split(path.sep).includes("sources")
      const isSourceSummary = inSourcesDir && fname.toLowerCase().startsWith(fileStemLower)
      let frontmatterMatch = false
      if (content.startsWith("---\n")) {
        const endRel = content.slice(4).indexOf("\n---")
        if (endRel >= 0) {
          const fm = content.slice(4, 4 + endRel).toLowerCase()
          let inSourcesBlock = false
          for (const line of fm.split("\n")) {
            if (line.startsWith("sources:")) {
              if (line.includes(fileNameLower)) { frontmatterMatch = true; break }
              inSourcesBlock = true
              continue
            }
            if (inSourcesBlock) {
              if (line === "" || line.startsWith(" ") || line.startsWith("\t")) {
                if (line.includes(fileNameLower)) { frontmatterMatch = true; break }
              } else inSourcesBlock = false
            }
          }
        }
      }
      if (sourcesMatch || isSourceSummary || frontmatterMatch) results.push(fwd(full))
    }
  }
}

async function findRelatedWikiPages({ projectPath, sourceName }) {
  const wikiDir = path.join(projectPath, "wiki")
  if (!fs.existsSync(wikiDir) || !fs.statSync(wikiDir).isDirectory()) return []
  const results = []
  collectRelatedPages(wikiDir, sourceName, results)
  return results
}

export const fsCommands = {
  read_file: readFile,
  write_file: writeFile,
  write_file_base64: writeFileBase64,
  write_file_atomic: writeFileAtomic,
  list_directory: listDirectory,
  copy_file: copyFile,
  copy_directory: copyDirectory,
  preprocess_file: preprocessFile,
  delete_file: deleteFile,
  create_directory: createDirectory,
  file_exists: fileExists,
  get_file_modified_time: getFileModifiedTime,
  get_file_size: getFileSize,
  get_file_md5: getFileMd5,
  read_file_as_base64: readFileAsBase64,
  apply_text_selection_edit: applyTextSelectionEdit,
  create_missing_wiki_page: createMissingWikiPage,
  find_related_wiki_pages: findRelatedWikiPages,
  list_file_history: (a) => listFileHistory(a),
  restore_file_history: (a) => restoreFileHistory(a),
}

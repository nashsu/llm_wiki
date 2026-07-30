import fs from "node:fs/promises"
import path from "node:path"

// Node port of the desktop `preprocess_file` command's binary-document
// handling (src-tauri/src/commands/fs.rs + ebook.rs). The browser cannot
// parse PDF/Office/EPUB, so the server extracts text here and returns it to
// the unchanged frontend ingest pipeline. Text-only formats are read as-is.

const TEXT_EXTS = new Set([
  "md","markdown","txt","text","rst","adoc","csv","tsv","json","jsonl","yaml",
  "yml","toml","ini","conf","cfg","log","html","htm","xml","css","js","mjs",
  "ts","tsx","jsx","py","rb","go","rs","java","c","h","cpp","hpp","sh","sql",
  "tex","bib","srt","vtt",
])
const OFFICE_EXTS = new Set(["doc","docx","pptx","xls","xlsx","odt","ods","odp"])
const EBOOK_EXTS = new Set(["epub","mobi"])

// ── XML helpers ───────────────────────────────────────────────────────────
function decodeEntities(s) {
  return s
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, "&")
}
function stripTags(html) {
  return decodeEntities(
    html.replace(/<\s*(br|p|div|tr|li|h[1-6])[^>]*>/gi, "\n")
        .replace(/<[^>]+>/g, "")
  ).replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim()
}
function tagTexts(xml, tag) {
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "gi")
  const out = []
  let m
  while ((m = re.exec(xml))) out.push(decodeEntities(m[1].replace(/<[^>]+>/g, "")))
  return out
}

// ── PDF (pdfjs-dist legacy build, no worker) ──────────────────────────────
let pdfjsPromise = null
function loadPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import("pdfjs-dist/legacy/build/pdf.mjs").catch((e) => {
      pdfjsPromise = null
      throw new Error(`pdfjs-dist unavailable: ${e.message}`)
    })
  }
  return pdfjsPromise
}
async function extractPdf(buf) {
  const pdfjs = await loadPdfjs()
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(buf), useSystemFonts: true, isEvalSupported: false, verbosity: 0,
  }).promise
  const pages = []
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i)
    const tc = await page.getTextContent()
    pages.push(tc.items.map((it) => it.str).join(" ").replace(/\s+/g, " ").trim())
  }
  return pages.filter(Boolean).join("\n\n")
}

// ── Org mode → Markdown (mirrors the Rust converter's intent) ─────────────
function orgToMarkdown(content) {
  const out = []
  let inCode = false
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine
    if (/^\s*#\+BEGIN_SRC/i.test(line)) {
      const lang = line.trim().slice(11).trim().split(/\s+/)[0] || ""
      out.push("```" + lang); inCode = true; continue
    }
    if (/^\s*#\+END_SRC/i.test(line)) { out.push("```"); inCode = false; continue }
    if (inCode) { out.push(line); continue }
    const head = /^\s*(\*+)\s+(.*)$/.exec(line)
    if (head && !/\S.*\S/.test(head[1].replace(/\*/g, ""))) {
      const level = Math.min(head[1].length, 6)
      out.push(`${"#".repeat(level)} ${head[2].trim()}`); continue
    }
    const kw = /^\s*#\[?([A-Za-z_]+)\]?:\s*(.*)$/.exec(line)
    if (kw && !["OPTIONS","PROPERTY","SETUPFILE"].includes(kw[1].toUpperCase())) {
      out.push(`**${kw[1]}:** ${kw[2]}`); continue
    }
    out.push(line.replace(/\[\[(?:[^\]|]+)\|([^\]]+)\]\]/g, "$1").replace(/\[\[([^\]]+)\]\]/g, "$1"))
  }
  return out.join("\n").trim()
}

// ── DOCX ──────────────────────────────────────────────────────────────────
async function extractDocx(zip) {
  const xml = await zip.file("word/document.xml")?.async("string")
  if (!xml) throw new Error("DOCX missing word/document.xml")
  // Paragraph breaks on </w:p>; tab/line breaks inside runs.
  const paras = xml.split(/<\/w:p>/i).map((p) => {
    let t = p.replace(/<w:tab\b[^>]*\/?>/gi, "\t").replace(/<w:br\b[^>]*\/?>/gi, "\n")
    const texts = [...t.matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/gi)].map((m) => decodeEntities(m[1]))
    return texts.join("")
  })
  return paras.map((p) => p.trim()).filter(Boolean).join("\n\n")
}

// ── PPTX ──────────────────────────────────────────────────────────────────
async function extractPptx(zip) {
  const names = Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/i.test(n))
    .sort((a, b) => Number(a.match(/slide(\d+)/i)[1]) - Number(b.match(/slide(\d+)/i)[1]))
  const slides = []
  for (const n of names) {
    const xml = await zip.files[n].async("string")
    const texts = tagTexts(xml, "a:t")
    if (texts.length) slides.push(texts.join(" "))
  }
  return slides.join("\n\n")
}

// ── XLSX ──────────────────────────────────────────────────────────────────
async function extractXlsx(zip) {
  const shared = []
  const ss = await zip.file("xl/sharedStrings.xml")?.async("string")
  if (ss) {
    const siRe = /<si\b[^>]*>([\s\S]*?)<\/si>/gi
    let m
    while ((m = siRe.exec(ss))) {
      shared.push([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/gi)].map((x) => decodeEntities(x[1])).join(""))
    }
  }
  const sheetNames = Object.keys(zip.files).filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(n))
    .sort((a, b) => Number(a.match(/sheet(\d+)/i)[1]) - Number(b.match(/sheet(\d+)/i)[1]))
  const sheets = []
  for (const n of sheetNames) {
    const xml = await zip.files[n].async("string")
    const rows = []
    const rowRe = /<row\b[^>]*>([\s\S]*?)<\/row>/gi
    let rm
    while ((rm = rowRe.exec(xml))) {
      const cells = []
      const cRe = /<c\b([^>]*)>([\s\S]*?)<\/c>|<c\b([^>]*)\/>/gi
      let cm
      while ((cm = cRe.exec(rm[1]))) {
        const attrs = cm[1] || cm[3] || ""
        const inner = cm[2] || ""
        const isShared = /\bt="s"/.test(attrs)
        const isInline = /\bt="inlineStr"/.test(attrs)
        let val = ""
        if (isInline) {
          const t = /<t[^>]*>([\s\S]*?)<\/t>/i.exec(inner)
          val = t ? decodeEntities(t[1]) : ""
        } else {
          const v = /<v>([\s\S]*?)<\/v>/i.exec(inner)
          if (v) val = isShared ? (shared[Number(v[1])] ?? "") : decodeEntities(v[1])
        }
        if (val !== "") cells.push(val)
      }
      if (cells.length) rows.push(cells.join("\t"))
    }
    if (rows.length) sheets.push(rows.join("\n"))
  }
  return sheets.join("\n\n")
}

// ── ODF (odt/ods/odp) ─────────────────────────────────────────────────────
async function extractOdf(zip) {
  const xml = await zip.file("content.xml")?.async("string")
  if (!xml) throw new Error("ODF missing content.xml")
  let t = xml
    .replace(/<text:line-break\b[^>]*\/?>/gi, "\n")
    .replace(/<text:tab\b[^>]*\/?>/gi, "\t")
    .replace(/<text:s\b[^>]*\/?>/gi, " ")
    .replace(/<\/text:p>/gi, "\n").replace(/<\/text:h>/gi, "\n")
    .replace(/<\/table:table-row>/gi, "\n").replace(/<\/table:table-cell>/gi, "\t")
  return stripTags(t)
}

// ── EPUB ──────────────────────────────────────────────────────────────────
async function extractEpub(zip) {
  const container = await zip.file("META-INF/container.xml")?.async("string")
  let opfPath = null
  if (container) {
    const m = /full-path="([^"]+)"/i.exec(container)
    if (m) opfPath = m[1]
  }
  const order = []
  if (opfPath) {
    const opf = await zip.files[opfPath]?.async("string")
    if (opf) {
      const base = opfPath.includes("/") ? opfPath.slice(0, opfPath.lastIndexOf("/") + 1) : ""
      const idHref = {}
      const itemRe = /<item\b[^>]*\bid="([^"]+)"[^>]*\bhref="([^"]+)"/gi
      let im
      while ((im = itemRe.exec(opf))) idHref[im[1]] = base + im[2]
      const spineRe = /<itemref\b[^>]*\bidref="([^"]+)"/gi
      let sm
      while ((sm = spineRe.exec(opf))) if (idHref[sm[1]]) order.push(idHref[sm[1]])
    }
  }
  if (order.length === 0) {
    order.push(...Object.keys(zip.files).filter((n) => /\.(x?html|htm)$/i.test(n)).sort())
  }
  const parts = []
  for (const href of order) {
    const decoded = decodeURIComponent(href)
    const entry = zip.files[decoded] || zip.files[href]
    if (!entry || entry.dir) continue
    const html = await entry.async("string")
    const text = stripTags(html)
    if (text) parts.push(text)
  }
  return parts.join("\n\n")
}

// ── MOBI (PalmDOC / uncompressed; HUFF/CDIC not supported in web mode) ────
function decompressPalmDoc(buf) {
  const out = []
  let i = 0
  while (i < buf.length) {
    const c = buf[i++]
    if (c === 0) out.push(0)
    else if (c >= 1 && c <= 8) { for (let j = 0; j < c && i < buf.length; j++) out.push(buf[i++]) }
    else if (c <= 0x7f) out.push(c)
    else if (c >= 0xc0) out.push(0x20, c ^ 0x80)
    else { // 0x80..0xbf distance/length
      if (i >= buf.length) break
      const next = buf[i++]
      const dist = (((c & 0x3f) << 8) | next) >> 3
      const len = (next & 0x07) + 3
      if (dist === 0 || dist > out.length) continue
      for (let j = 0; j < len; j++) out.push(out[out.length - dist])
    }
  }
  return Buffer.from(out)
}
function extractMobi(buf) {
  if (buf.length < 78 || buf.toString("ascii", 60, 68) !== "BOOKMOBI" && buf.toString("ascii", 60, 64) !== "TEXtREAd") {
    // tolerate; try anyway
  }
  const name = buf.toString("ascii", 0, 32).replace(/\0+$/, "")
  const numRecords = buf.readUInt16BE(76)
  if (numRecords < 2) throw new Error("Not a MOBI/PDB file")
  const rec0 = buf.readUInt32BE(78)
  const rec1 = buf.readUInt32BE(78 + 8)
  const rec0buf = buf.subarray(rec0, rec1)
  // PalmDOC header inside record 0: compression(2) unused(2) textLength(4) recordCount(2) recordSize(2) encryption(2)
  const compression = rec0buf.readUInt16BE(0)
  const textLength = rec0buf.readUInt32BE(4)
  // text records start at record 1
  const dataStart = buf.readUInt32BE(78 + 8) // record 1 offset
  const dataEnd = numRecords > 2 ? buf.readUInt32BE(78 + 8 * 2) : buf.length
  let raw = buf.subarray(dataStart, Math.min(dataEnd, dataStart + textLength * 4 + 65536))
  let text
  if (compression === 1) text = raw
  else if (compression === 2) text = decompressPalmDoc(raw)
  else throw new Error("MOBI uses HUFF/CDIC compression which the web server cannot decode. Convert the book to EPUB to ingest it.")
  // Trim to declared text length and strip HTML tags.
  text = text.subarray(0, Math.min(text.length, textLength))
  const str = text.toString("utf-8")
  const cleaned = stripTags(str)
  return cleaned || name
}

async function extractOffice(buf, ext) {
  const JSZip = (await import("jszip")).default
  const zip = await JSZip.loadAsync(buf)
  switch (ext) {
    case "docx": return extractDocx(zip)
    case "pptx": return extractPptx(zip)
    case "xlsx": return extractXlsx(zip)
    case "odt": case "ods": case "odp": return extractOdf(zip)
    default: throw new Error(`Unsupported office format in web mode: ${ext}`)
  }
}

async function extractXlsLegacy(buf) {
  let XLSX
  try { XLSX = (await import("xlsx")).default } catch (e) {
    throw new Error("Spreadsheet library unavailable: " + (e.message || e))
  }
  try {
    const wb = XLSX.read(buf, { type: "buffer", cellNF: false, cellStyles: false, cellDates: false })
    const parts = []
    for (const name of wb.SheetNames) {
      const csv = XLSX.utils.sheet_to_csv(wb.Sheets[name], { blankrows: false })
      if (csv && csv.trim()) parts.push(csv)
    }
    const text = parts.join("\n\n").trim()
    if (!text) throw new Error("no text")
    return text
  } catch (e) {
    throw new Error(`Legacy .xls extraction failed: ${e.message || e}. Re-save as .xlsx (or export to CSV/Markdown) to ingest it.`)
  }
}

async function extractDocLegacy(filePath) {
  let WE
  try { WE = (await import("word-extractor")).default } catch (e) {
    throw new Error("Word-document library unavailable: " + (e.message || e))
  }
  try {
    const extractor = new WE()
    const doc = await extractor.extract(filePath)
    const body = typeof doc?.getBody === "function" ? doc.getBody() : ""
    const text = String(body || "").trim()
    if (!text) throw new Error("empty body")
    return text
  } catch (e) {
    throw new Error(`Legacy .doc extraction failed: ${e.message || e}. Re-save as .docx (or export to PDF/Markdown) to ingest it.`)
  }
}

export async function preprocessFile({ path: p }) {
  const ext = (path.extname(p).slice(1) || "").toLowerCase()
  const buf = await fs.readFile(p)
  if (TEXT_EXTS.has(ext) || ext === "") return buf.toString("utf-8")
  if (ext === "org") return orgToMarkdown(buf.toString("utf-8"))
  if (ext === "pdf") return await extractPdf(buf)
  if (OFFICE_EXTS.has(ext)) {
    // Legacy OLE2 .xls -> SheetJS (BIFF). Legacy OLE2 .doc -> word-extractor
    // (best-effort; success not unit-verifiable on hosts lacking a .doc sample or
    // LibreOffice, but failures degrade to a clean convert-first error and never
    // crash the ingest pipeline). Modern OOXML/ODF still go through extractOffice.
    if (ext === "xls") return await extractXlsLegacy(buf)
    if (ext === "doc") return await extractDocLegacy(p)
    const text = await extractOffice(buf, ext)
    if (!text) throw new Error(`Could not extract text from .${ext} file`)
    return text
  }
  if (EBOOK_EXTS.has(ext)) {
    if (ext === "epub") {
      const JSZip = (await import("jszip")).default
      const zip = await JSZip.loadAsync(buf)
      const text = await extractEpub(zip)
      if (!text) throw new Error("Could not extract text from EPUB")
      return text
    }
    return extractMobi(buf)
  }
  // Unknown binary: return the same sentinel the desktop uses for "nothing to do"
  // only for known-text-like cases; otherwise report clearly.
  throw new Error(`Web server cannot parse '.${ext}' files. Convert to Markdown/text/PDF/Office/EPUB first.`)
}

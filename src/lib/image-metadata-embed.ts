/**
 * Image metadata embedder — writes VLM-generated alt/title into image
 * file metadata (XMP, EXIF, IPTC, PNG text chunks).
 *
 * Supported formats: JPEG, PNG, WebP, SVG.
 * Skipped: RAW, BMP, GIF, AVIF, HEIC, TIFF, ICO (documented non-goals).
 *
 * Multi-vendor field coverage (same content, different field names):
 *
 *   XMP:   dc:description, dc:title, Iptc4xmpExt:AltTextAccessibility
 *   EXIF:  ImageDescription (0x010E), UserComment (0x9286, UTF-8)
 *   IPTC:  Caption-Abstract (2:120), Headline (2:105)
 *   PNG:   iTXt "Description", "Title", "AltTextAccessibility"
 *
 * The module is pure byte-manipulation — no external deps (exiftool etc).
 * Called from the markdown-image-localizer pipeline Phase 3, AFTER VLM
 * captioning completes and files are already on disk.
 */
import { readFileAsBase64, writeFileBase64 } from "@/commands/fs"

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface EmbedMetadataOptions {
  /** Absolute path of the image file on disk. */
  absPath: string
  /** VLM-generated alt text (short, ≤ 250 chars). */
  alt: string
  /** VLM-generated title / extended description. May be empty. */
  title: string
  /** MIME type of the image (drives format dispatch). */
  mimeType: string
}

export interface EmbedResult {
  /** Whether metadata was actually written. */
  written: boolean
  /** Reason when skipped. */
  skipReason?: string
}

/**
 * Embed alt/title metadata into an image file on disk.
 * Reads the file, patches bytes in memory, writes back.
 * Non-fatal: any error is caught and returned as `{ written: false }`.
 */
export async function embedImageMetadata(
  opts: EmbedMetadataOptions,
): Promise<EmbedResult> {
  const { absPath, alt, title, mimeType } = opts
  if (!alt && !title) return { written: false, skipReason: "empty-alt-and-title" }

  try {
    const { base64 } = await readFileAsBase64(absPath)
    const bytes = base64ToBytes(base64)
    let out: Uint8Array | null = null

    const norm = mimeType.toLowerCase().split(";")[0].trim()
    if (norm === "image/jpeg" || norm === "image/jpg") {
      out = embedJpeg(bytes, alt, title)
    } else if (norm === "image/png") {
      out = embedPng(bytes, alt, title)
    } else if (norm === "image/webp") {
      out = embedWebp(bytes, alt, title)
    } else if (norm === "image/svg+xml") {
      out = embedSvg(bytes, alt, title)
    } else {
      return { written: false, skipReason: `unsupported-mime:${norm}` }
    }

    if (!out) return { written: false, skipReason: "format-parse-failed" }

    await writeFileBase64(absPath, bytesToBase64(out))
    return { written: true }
  } catch (err) {
    console.warn(
      `[image-metadata] embed failed for ${absPath}:`,
      err instanceof Error ? err.message : err,
    )
    return { written: false, skipReason: "io-error" }
  }
}

// ---------------------------------------------------------------------------
// XMP builder (shared across JPEG, WebP, SVG)
// ---------------------------------------------------------------------------

/**
 * Build a complete XMP packet with dc:description, dc:title, and
 * Iptc4xmpExt:AltTextAccessibility. All fields carry the same alt text
 * for maximum reader compatibility. Title goes into dc:title only when
 * non-empty.
 */
function buildXmpPacket(alt: string, title: string): string {
  const altEsc = escapeXml(alt)
  const titleEsc = escapeXml(title)

  const titleBlock = title
    ? `\n      <dc:title>\n        <rdf:Alt>\n          <rdf:li xml:lang="x-default">${titleEsc}</rdf:li>\n        </rdf:Alt>\n      </dc:title>`
    : ""

  return `<?xpacket begin="\uFEFF" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description rdf:about=""
        xmlns:dc="http://purl.org/dc/elements/1.1/"
        xmlns:Iptc4xmpExt="http://iptc.org/std/Iptc4xmpExt/2008-02-29/">
      <dc:description>
        <rdf:Alt>
          <rdf:li xml:lang="x-default">${altEsc}</rdf:li>
        </rdf:Alt>
      </dc:description>${titleBlock}
      <Iptc4xmpExt:AltTextAccessibility>
        <rdf:Alt>
          <rdf:li xml:lang="x-default">${altEsc}</rdf:li>
        </rdf:Alt>
      </Iptc4xmpExt:AltTextAccessibility>
    </rdf:Description>
  </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`
}

// ---------------------------------------------------------------------------
// JPEG — insert APP1 (XMP) + APP13 (IPTC IIM) after SOI
// ---------------------------------------------------------------------------

const XMP_NS_HEADER = "http://ns.adobe.com/xap/1.0/\0"

function embedJpeg(
  bytes: Uint8Array,
  alt: string,
  title: string,
): Uint8Array | null {
  // Validate SOI marker.
  if (bytes.length < 2 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null

  const xmpPacket = buildXmpPacket(alt, title)
  const xmpPayload = strToBytes(XMP_NS_HEADER + xmpPacket)

  // APP1 segment: FF E1 [len:2] [payload]
  const app1 = buildJpegSegment(0xe1, xmpPayload)

  // IPTC IIM (APP13): FF ED [len:2] [Photoshop IRB wrapper] [IIM records]
  const iim = buildIptcIim(alt, title)
  const app13 = iim.length > 0 ? buildJpegSegment(0xed, iim) : new Uint8Array(0)

  // Insert after SOI (offset 2), before any existing segments.
  // If there's already an APP1 XMP or APP13 IPTC, we still insert ours
  // first — readers pick the first they find, and ours is authoritative.
  const out = new Uint8Array(2 + app1.length + app13.length + (bytes.length - 2))
  out.set(bytes.subarray(0, 2), 0) // SOI
  out.set(app1, 2)
  out.set(app13, 2 + app1.length)
  out.set(bytes.subarray(2), 2 + app1.length + app13.length)
  return out
}

function buildJpegSegment(marker: number, payload: Uint8Array): Uint8Array {
  const len = payload.length + 2 // +2 for the length field itself
  if (len > 0xffff) {
    // JPEG segment max is 65535 bytes. XMP can theoretically exceed this
    // with extended XMP, but our alt/title payloads are tiny.
    throw new Error(`JPEG segment too large: ${len}`)
  }
  const seg = new Uint8Array(2 + 2 + payload.length)
  seg[0] = 0xff
  seg[1] = marker
  seg[2] = (len >> 8) & 0xff
  seg[3] = len & 0xff
  seg.set(payload, 4)
  return seg
}

/**
 * Build IPTC IIM records wrapped in a Photoshop IRB (8BIM) block.
 * This is what APP13 carries.
 *
 * Records:
 *   2:120 Caption-Abstract → alt
 *   2:105 Headline → title (or alt if title empty)
 */
function buildIptcIim(alt: string, title: string): Uint8Array {
  const records: Uint8Array[] = []

  // IIM record: 0x1C [record:1] [dataset:1] [len:2] [data]
  const makeRecord = (dataset: number, text: string): Uint8Array => {
    const data = strToBytes(text)
    const rec = new Uint8Array(5 + data.length)
    rec[0] = 0x1c // IIM tag marker
    rec[1] = 0x02 // Record 2 (Application Record)
    rec[2] = dataset
    rec[3] = (data.length >> 8) & 0xff
    rec[4] = data.length & 0xff
    rec.set(data, 5)
    return rec
  }

  if (alt) records.push(makeRecord(120, alt)) // Caption-Abstract
  const headline = title || alt
  if (headline) records.push(makeRecord(105, headline)) // Headline

  if (records.length === 0) return new Uint8Array(0)

  const iimTotal = records.reduce((s, r) => s + r.length, 0)

  // Photoshop IRB wrapper: "8BIM" [id:2=0x0404] [name:2] [len:4] [IIM data] [pad]
  // Pascal string name: 1-byte count (0) + pad byte → 2 bytes total.
  const nameLen = 2
  // Fixed header = 4 ("8BIM") + 2 (id) + 2 (name) + 4 (len) = 12 bytes,
  // always even — so wrapperLen's parity is exactly iimTotal's parity.
  const wrapperLen = 4 + 2 + nameLen + 4 + iimTotal
  // IRB spec: each resource block must end on an even byte offset. Since
  // the 12-byte header is even, a single pad byte is needed iff the IIM
  // payload is odd-length.
  const padded = wrapperLen + (wrapperLen % 2)

  const out = new Uint8Array(padded)
  let off = 0
  // "8BIM"
  out[off++] = 0x38 // '8'
  out[off++] = 0x42 // 'B'
  out[off++] = 0x49 // 'I'
  out[off++] = 0x4d // 'M'
  // Resource ID 0x0404 (IPTC-NAA)
  out[off++] = 0x04
  out[off++] = 0x04
  // Pascal string name: length 0, padded to even → 2 bytes (0x00, 0x00)
  // Actually the standard says: 1-byte count + string, padded to even total.
  // Empty name → count=0, then pad byte → 2 bytes.
  out[off++] = 0x00
  out[off++] = 0x00
  // Data length (4 bytes big-endian) — length of IIM data only
  out[off++] = (iimTotal >> 24) & 0xff
  out[off++] = (iimTotal >> 16) & 0xff
  out[off++] = (iimTotal >> 8) & 0xff
  out[off++] = iimTotal & 0xff
  // IIM records
  for (const rec of records) {
    out.set(rec, off)
    off += rec.length
  }
  return out
}

// ---------------------------------------------------------------------------
// PNG — insert iTXt chunks before IEND
// ---------------------------------------------------------------------------

function embedPng(
  bytes: Uint8Array,
  alt: string,
  title: string,
): Uint8Array | null {
  // Validate PNG signature: 89 50 4E 47 0D 0A 1A 0A
  const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  if (bytes.length < 8) return null
  for (let i = 0; i < 8; i++) {
    if (bytes[i] !== SIG[i]) return null
  }

  // Find IEND chunk position (last 12 bytes: len(4) + "IEND"(4) + crc(4)).
  const iendPos = findPngChunk(bytes, "IEND")
  if (iendPos < 0) return null

  const chunks: Uint8Array[] = []

  // Standard text chunks for maximum compatibility.
  if (alt) {
    chunks.push(buildPngITXt("Description", alt))
    chunks.push(buildPngITXt("AltTextAccessibility", alt))
  }
  if (title) {
    chunks.push(buildPngITXt("Title", title))
  }
  // XMP packet in the standard PNG XMP chunk.
  const xmpPacket = buildXmpPacket(alt, title)
  chunks.push(buildPngITXt("XML:com.adobe.xmp", xmpPacket))

  const totalInsert = chunks.reduce((s, c) => s + c.length, 0)
  const out = new Uint8Array(bytes.length + totalInsert)
  out.set(bytes.subarray(0, iendPos), 0)
  let off = iendPos
  for (const chunk of chunks) {
    out.set(chunk, off)
    off += chunk.length
  }
  out.set(bytes.subarray(iendPos), off) // IEND + anything after
  return out
}

function findPngChunk(bytes: Uint8Array, type: string): number {
  const typeBytes = strToBytes(type)
  let pos = 8 // skip signature
  while (pos + 8 <= bytes.length) {
    const len =
      ((bytes[pos] << 24) | (bytes[pos + 1] << 16) | (bytes[pos + 2] << 8) | bytes[pos + 3]) >>> 0
    // Check type match
    let match = true
    for (let i = 0; i < 4; i++) {
      if (bytes[pos + 4 + i] !== typeBytes[i]) {
        match = false
        break
      }
    }
    if (match) return pos
    pos += 12 + len // 4(len) + 4(type) + data + 4(crc)
  }
  return -1
}

/**
 * Build a PNG iTXt chunk. iTXt supports full UTF-8 (unlike tEXt which
 * is Latin-1 only). Structure:
 *
 *   [len:4] "iTXt" [keyword\0] [compressionFlag:1=0] [compressionMethod:1=0]
 *   [languageTag\0] [translatedKeyword\0] [text] [crc:4]
 */
function buildPngITXt(keyword: string, text: string): Uint8Array {
  const kw = strToBytes(keyword)
  const txt = strToBytes(text)
  // data = keyword + \0 + flag(0) + method(0) + lang\0 + translated\0 + text
  const dataLen = kw.length + 1 + 1 + 1 + 1 + 1 + txt.length
  const chunk = new Uint8Array(4 + 4 + dataLen + 4)
  let off = 0

  // Length (of data only, not type+crc)
  writeU32BE(chunk, off, dataLen)
  off += 4
  // Type "iTXt"
  chunk[off++] = 0x69 // i
  chunk[off++] = 0x54 // T
  chunk[off++] = 0x58 // X
  chunk[off++] = 0x74 // t
  // Keyword + null
  chunk.set(kw, off)
  off += kw.length
  chunk[off++] = 0x00
  // Compression flag = 0 (uncompressed), method = 0
  chunk[off++] = 0x00
  chunk[off++] = 0x00
  // Language tag (empty) + null
  chunk[off++] = 0x00
  // Translated keyword (empty) + null
  chunk[off++] = 0x00
  // Text
  chunk.set(txt, off)
  off += txt.length
  // CRC32 over type + data
  const crc = crc32(chunk.subarray(4, 4 + 4 + dataLen))
  writeU32BE(chunk, off, crc)
  return chunk
}

// ---------------------------------------------------------------------------
// WebP — insert EXIF + XMP chunks, update VP8X flags
// ---------------------------------------------------------------------------

function embedWebp(
  bytes: Uint8Array,
  alt: string,
  title: string,
): Uint8Array | null {
  // RIFF header: "RIFF" [size:4] "WEBP"
  if (bytes.length < 12) return null
  const riff = bytesToString(bytes.subarray(0, 4))
  const webp = bytesToString(bytes.subarray(8, 12))
  if (riff !== "RIFF" || webp !== "WEBP") return null

  // Parse chunks starting at offset 12.
  const chunks: Array<{ fourcc: string; data: Uint8Array }> = []
  let pos = 12
  while (pos + 8 <= bytes.length) {
    const fourcc = bytesToString(bytes.subarray(pos, pos + 4))
    const size =
      bytes[pos + 4] | (bytes[pos + 5] << 8) | (bytes[pos + 6] << 16) | (bytes[pos + 7] << 24)
    const data = bytes.subarray(pos + 8, pos + 8 + size)
    chunks.push({ fourcc, data })
    pos += 8 + size + (size % 2) // chunks are 2-byte aligned
  }

  // Build EXIF chunk (TIFF with ImageDescription + UserComment).
  const exifTiff = buildExifTiff(alt, title)
  // Build XMP chunk.
  const xmpPacket = strToBytes(buildXmpPacket(alt, title))

  // Filter out existing EXIF/XMP chunks (we replace them).
  const kept = chunks.filter((c) => c.fourcc !== "EXIF" && c.fourcc !== "XMP ")

  // Determine if we need VP8X. If the file has a simple VP8/VP8L chunk
  // and no VP8X yet, we need to create one to signal EXIF/XMP presence.
  const hasVp8x = kept.some((c) => c.fourcc === "VP8X")
  const hasVp8 = kept.some((c) => c.fourcc === "VP8 " || c.fourcc === "VP8L")

  const outChunks: Array<{ fourcc: string; data: Uint8Array }> = []

  if (hasVp8x) {
    // Update existing VP8X flags to set EXIF (bit 3) and XMP (bit 2).
    for (const c of kept) {
      if (c.fourcc === "VP8X") {
        const updated = new Uint8Array(c.data)
        updated[0] |= 0x0c // set bits 2 (XMP) and 3 (EXIF)
        outChunks.push({ fourcc: "VP8X", data: updated })
      } else {
        outChunks.push(c)
      }
    }
  } else if (hasVp8) {
    // Need to synthesize a VP8X header. Extract dimensions from VP8/VP8L.
    const vp8Chunk = kept.find((c) => c.fourcc === "VP8 " || c.fourcc === "VP8L")!
    const dims = getWebpDimensions(vp8Chunk)
    if (dims) {
      const vp8x = new Uint8Array(10)
      vp8x[0] = 0x0c // flags: EXIF + XMP
      // bytes 1-3: reserved (0)
      // bytes 4-6: canvas width - 1 (24-bit LE)
      vp8x[4] = (dims.width - 1) & 0xff
      vp8x[5] = ((dims.width - 1) >> 8) & 0xff
      vp8x[6] = ((dims.width - 1) >> 16) & 0xff
      // bytes 7-9: canvas height - 1 (24-bit LE)
      vp8x[7] = (dims.height - 1) & 0xff
      vp8x[8] = ((dims.height - 1) >> 8) & 0xff
      vp8x[9] = ((dims.height - 1) >> 16) & 0xff
      outChunks.push({ fourcc: "VP8X", data: vp8x })
    }
    // Then all kept chunks (VP8X omitted when dims unknown — better
    // a missing VP8X than one with bogus 1×1 canvas dimensions).
    for (const c of kept) outChunks.push(c)
  } else {
    // Animated or unknown layout — just append.
    for (const c of kept) outChunks.push(c)
  }

  // Append EXIF and XMP chunks at the end (per WebP spec order:
  // VP8X > VP8/VP8L > ALPH > ANMF > EXIF > XMP).
  outChunks.push({ fourcc: "EXIF", data: exifTiff })
  outChunks.push({ fourcc: "XMP ", data: xmpPacket })

  // Serialize RIFF.
  let totalData = 4 // "WEBP"
  for (const c of outChunks) {
    totalData += 8 + c.data.length + (c.data.length % 2)
  }
  const out = new Uint8Array(8 + totalData)
  let off = 0
  // "RIFF"
  out[off++] = 0x52; out[off++] = 0x49; out[off++] = 0x46; out[off++] = 0x46
  // File size - 8 (LE)
  const fileSize = totalData
  out[off++] = fileSize & 0xff
  out[off++] = (fileSize >> 8) & 0xff
  out[off++] = (fileSize >> 16) & 0xff
  out[off++] = (fileSize >> 24) & 0xff
  // "WEBP"
  out[off++] = 0x57; out[off++] = 0x45; out[off++] = 0x42; out[off++] = 0x50
  // Chunks
  for (const c of outChunks) {
    // FourCC
    for (let i = 0; i < 4; i++) out[off++] = c.fourcc.charCodeAt(i)
    // Size (LE)
    const sz = c.data.length
    out[off++] = sz & 0xff
    out[off++] = (sz >> 8) & 0xff
    out[off++] = (sz >> 16) & 0xff
    out[off++] = (sz >> 24) & 0xff
    // Data
    out.set(c.data, off)
    off += c.data.length
    // Pad byte
    if (sz % 2 === 1) out[off++] = 0x00
  }
  return out
}

function getWebpDimensions(chunk: { fourcc: string; data: Uint8Array }): { width: number; height: number } | null {
  if (chunk.fourcc === "VP8 ") {
    // Lossy: frame tag at bytes 6-9 (after 3-byte frame tag + 3-byte start code)
    // Actually: data[0..2] = frame tag, data[3..5] = start code 0x9D 0x01 0x2A
    // data[6..7] = width (14-bit LE), data[8..9] = height (14-bit LE)
    if (chunk.data.length >= 10) {
      const w = (chunk.data[6] | (chunk.data[7] << 8)) & 0x3fff
      const h = (chunk.data[8] | (chunk.data[9] << 8)) & 0x3fff
      if (w > 0 && h > 0) return { width: w, height: h }
    }
  } else if (chunk.fourcc === "VP8L") {
    // Lossless: signature byte 0x2F, then 4 bytes with packed width/height.
    if (chunk.data.length >= 5 && chunk.data[0] === 0x2f) {
      const bits =
        chunk.data[1] | (chunk.data[2] << 8) | (chunk.data[3] << 16) | (chunk.data[4] << 24)
      const w = (bits & 0x3fff) + 1
      const h = ((bits >> 14) & 0x3fff) + 1
      return { width: w, height: h }
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// SVG — inject <metadata> with XMP
// ---------------------------------------------------------------------------

function embedSvg(
  bytes: Uint8Array,
  alt: string,
  title: string,
): Uint8Array | null {
  const text = new TextDecoder("utf-8").decode(bytes)
  // Find the <svg ...> opening tag. A bare indexOf(">") would hit the
  // closing `?>` of a leading `<?xml ...?>` declaration, so anchor on
  // the `<svg` tag start first.
  const svgTagStart = text.search(/<svg[\s>]/i)
  if (svgTagStart < 0) return null
  const svgOpenEnd = text.indexOf(">", svgTagStart)
  if (svgOpenEnd < 0) return null

  // If there's already a <metadata> block, replace it.
  const metaStart = text.indexOf("<metadata")
  const metaEnd = text.indexOf("</metadata>")
  const xmpPacket = buildXmpPacket(alt, title)
  const metadataBlock = `\n  <metadata>\n    ${xmpPacket}\n  </metadata>`

  let out: string
  if (metaStart >= 0 && metaEnd >= 0) {
    // Replace existing metadata block.
    out =
      text.slice(0, metaStart) +
      metadataBlock.trimStart() +
      text.slice(metaEnd + "</metadata>".length)
  } else {
    // Insert right after the <svg ...> opening tag.
    out =
      text.slice(0, svgOpenEnd + 1) +
      metadataBlock +
      text.slice(svgOpenEnd + 1)
  }

  // Also add <title> and <desc> as direct SVG children for renderers
  // that read those (browsers, Inkscape).
  const titleEl = title ? `\n  <title>${escapeXml(title)}</title>` : ""
  const descEl = alt ? `\n  <desc>${escapeXml(alt)}</desc>` : ""
  if (titleEl || descEl) {
    // Insert after <svg...> (and after metadata if we just added it).
    // Fallback anchors on the <svg> tag, not the document start —
    // a leading <?xml ...?> declaration's ">" would be wrong.
    const insertPos = out.indexOf("<metadata") >= 0
      ? out.indexOf("</metadata>") + "</metadata>".length
      : out.indexOf(">", out.search(/<svg[\s>]/i)) + 1
    out = out.slice(0, insertPos) + titleEl + descEl + out.slice(insertPos)
  }

  return strToBytes(out)
}

// ---------------------------------------------------------------------------
// EXIF TIFF builder (for WebP EXIF chunk; could also be used for JPEG
// APP1 but we use XMP for JPEG since it's simpler and more compatible)
// ---------------------------------------------------------------------------

/**
 * Build a minimal TIFF (little-endian) with:
 *   - IFD0: ImageDescription (0x010E) = alt
 *   - ExifIFD: UserComment (0x9286) = UTF-8 alt
 */
function buildExifTiff(alt: string, title: string): Uint8Array {
  // We build a minimal TIFF. Layout:
  //   [TIFF header: 8 bytes]
  //   [IFD0: entry count(2) + entries(12 each) + next-IFD(4)]
  //   [ExifIFD pointer target]
  //   [String data area]

  const descBytes = strToBytes(alt)
  const commentBytes = strToBytes(alt) // UserComment = alt (accessibility)
  // UserComment has 8-byte charset prefix "UNICODE\0" but we use UTF-8
  // convention: "ASCII\0\0\0" prefix is also common. For maximum compat
  // we'll use the UNICODE prefix with UTF-8 bytes (exiftool does this).
  const commentPrefix = strToBytes("UNICODE\0")
  const commentFull = new Uint8Array(commentPrefix.length + commentBytes.length)
  commentFull.set(commentPrefix, 0)
  commentFull.set(commentBytes, commentPrefix.length)

  // Title → ImageDescription if alt is empty (shouldn't happen, but safe).
  const desc = descBytes.length > 0 ? descBytes : strToBytes(title)

  // Calculate offsets.
  // TIFF header: 8 bytes
  // IFD0: 2 (count) + 2*12 (2 entries: ImageDescription + ExifIFD pointer) + 4 (next) = 30
  // ExifIFD: 2 (count) + 1*12 (UserComment) + 4 (next) = 18
  const ifd0Offset = 8
  const ifd0Size = 2 + 2 * 12 + 4
  const exifIfdOffset = ifd0Offset + ifd0Size
  const exifIfdSize = 2 + 1 * 12 + 4
  const dataOffset = exifIfdOffset + exifIfdSize

  // Data area: desc (with null terminator) + commentFull
  const descDataLen = desc.length + 1 // +1 for null terminator
  const descDataOffset = dataOffset
  const commentDataOffset = descDataOffset + descDataLen

  const totalSize = commentDataOffset + commentFull.length
  const buf = new Uint8Array(totalSize)
  const view = new DataView(buf.buffer)

  // TIFF header (little-endian)
  buf[0] = 0x49 // 'I'
  buf[1] = 0x49 // 'I'
  view.setUint16(2, 42, true) // magic
  view.setUint32(4, ifd0Offset, true) // offset to IFD0

  // IFD0
  let off = ifd0Offset
  view.setUint16(off, 2, true) // 2 entries
  off += 2

  // Entry 1: ImageDescription (0x010E), type ASCII (2), count = descDataLen
  view.setUint16(off, 0x010e, true); off += 2
  view.setUint16(off, 2, true); off += 2 // ASCII
  view.setUint32(off, descDataLen, true); off += 4
  view.setUint32(off, descDataOffset, true); off += 4

  // Entry 2: ExifIFD pointer (0x8769), type LONG (4), count 1
  view.setUint16(off, 0x8769, true); off += 2
  view.setUint16(off, 4, true); off += 2 // LONG
  view.setUint32(off, 1, true); off += 4
  view.setUint32(off, exifIfdOffset, true); off += 4

  // Next IFD = 0
  view.setUint32(off, 0, true); off += 4

  // ExifIFD
  view.setUint16(off, 1, true) // 1 entry
  off += 2
  // UserComment (0x9286), type UNDEFINED (7), count = commentFull.length
  view.setUint16(off, 0x9286, true); off += 2
  view.setUint16(off, 7, true); off += 2 // UNDEFINED
  view.setUint32(off, commentFull.length, true); off += 4
  view.setUint32(off, commentDataOffset, true); off += 4
  // Next IFD = 0
  view.setUint32(off, 0, true); off += 4

  // Data area
  buf.set(desc, descDataOffset)
  buf[descDataOffset + desc.length] = 0x00 // null terminator
  buf.set(commentFull, commentDataOffset)

  return buf
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function strToBytes(s: string): Uint8Array {
  return new TextEncoder().encode(s)
}

function bytesToString(b: Uint8Array): string {
  return new TextDecoder("ascii").decode(b)
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ""
  const chunkSize = 0x8000
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize)
    binary += String.fromCharCode(...chunk)
  }
  return btoa(binary)
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

function writeU32BE(buf: Uint8Array, offset: number, value: number): void {
  buf[offset] = (value >>> 24) & 0xff
  buf[offset + 1] = (value >>> 16) & 0xff
  buf[offset + 2] = (value >>> 8) & 0xff
  buf[offset + 3] = value & 0xff
}

/**
 * CRC-32 (PNG polynomial). Table-driven for speed.
 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[n] = c
  }
  return table
})()

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff
  for (let i = 0; i < data.length; i++) {
    crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

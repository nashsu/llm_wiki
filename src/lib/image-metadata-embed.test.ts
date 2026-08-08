import { describe, it, expect, vi, beforeEach } from "vitest"

// Mock fs — same pattern as markdown-image-localizer.test.ts.
vi.mock("@/commands/fs", () => ({
  readFileAsBase64: vi.fn(),
  writeFileBase64: vi.fn(),
}))

import { embedImageMetadata } from "./image-metadata-embed"
import { readFileAsBase64, writeFileBase64 } from "@/commands/fs"

const mockRead = vi.mocked(readFileAsBase64)
const mockWrite = vi.mocked(writeFileBase64)

// ---------------------------------------------------------------------------
// Helpers: build minimal valid binary fixtures
// ---------------------------------------------------------------------------

function bytesToB64(bytes: Uint8Array): string {
  let bin = ""
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin)
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/** Minimal valid JPEG: SOI + APP0 (JFIF) + EOI. */
function minimalJpeg(): Uint8Array {
  const soi = [0xff, 0xd8]
  // APP0 JFIF segment (minimal)
  const app0Payload = [
    0x4a, 0x46, 0x49, 0x46, 0x00, // "JFIF\0"
    0x01, 0x01, // version 1.1
    0x00, // aspect ratio units
    0x00, 0x01, // X density
    0x00, 0x01, // Y density
    0x00, 0x00, // thumbnail
  ]
  const app0Len = app0Payload.length + 2
  const app0 = [0xff, 0xe0, (app0Len >> 8) & 0xff, app0Len & 0xff, ...app0Payload]
  const eoi = [0xff, 0xd9]
  return new Uint8Array([...soi, ...app0, ...eoi])
}

/** Minimal valid PNG: signature + IHDR + IEND. */
function minimalPng(): Uint8Array {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

  // IHDR chunk: 13 bytes data
  const ihdrData = new Uint8Array(13)
  const ihdrView = new DataView(ihdrData.buffer)
  ihdrView.setUint32(0, 1) // width
  ihdrView.setUint32(4, 1) // height
  ihdrData[8] = 8 // bit depth
  ihdrData[9] = 2 // color type (RGB)
  const ihdr = buildPngChunk("IHDR", ihdrData)

  const iend = buildPngChunk("IEND", new Uint8Array(0))
  return new Uint8Array([...sig, ...ihdr, ...iend])
}

function buildPngChunk(type: string, data: Uint8Array): Uint8Array {
  const chunk = new Uint8Array(4 + 4 + data.length + 4)
  const view = new DataView(chunk.buffer)
  view.setUint32(0, data.length)
  for (let i = 0; i < 4; i++) chunk[4 + i] = type.charCodeAt(i)
  chunk.set(data, 8)
  // CRC (simplified — we compute real CRC for correctness)
  const crc = crc32(chunk.subarray(4, 8 + data.length))
  view.setUint32(8 + data.length, crc)
  return chunk
}

// CRC-32 (same polynomial as the module under test)
const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()
function crc32(data: Uint8Array): number {
  let crc = 0xffffffff
  for (let i = 0; i < data.length; i++) crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

/** Minimal valid WebP: RIFF + WEBP + VP8L (1×1 lossless). */
function minimalWebp(): Uint8Array {
  // VP8L chunk: signature 0x2F + 4 bytes packed (width-1=0, height-1=0)
  const vp8lData = new Uint8Array([0x2f, 0x00, 0x00, 0x00, 0x00])
  const vp8lSize = vp8lData.length
  // RIFF size = 4 ("WEBP") + 8 (chunk header) + vp8lSize + pad
  const riffSize = 4 + 8 + vp8lSize + (vp8lSize % 2)
  const buf = new Uint8Array(8 + riffSize)
  let off = 0
  // "RIFF"
  buf[off++] = 0x52; buf[off++] = 0x49; buf[off++] = 0x46; buf[off++] = 0x46
  buf[off++] = riffSize & 0xff; buf[off++] = (riffSize >> 8) & 0xff
  buf[off++] = (riffSize >> 16) & 0xff; buf[off++] = (riffSize >> 24) & 0xff
  // "WEBP"
  buf[off++] = 0x57; buf[off++] = 0x45; buf[off++] = 0x42; buf[off++] = 0x50
  // "VP8L"
  buf[off++] = 0x56; buf[off++] = 0x50; buf[off++] = 0x38; buf[off++] = 0x4c
  buf[off++] = vp8lSize & 0xff; buf[off++] = (vp8lSize >> 8) & 0xff
  buf[off++] = (vp8lSize >> 16) & 0xff; buf[off++] = (vp8lSize >> 24) & 0xff
  buf.set(vp8lData, off)
  return buf
}

/** Minimal valid SVG. */
function minimalSvg(): Uint8Array {
  return new TextEncoder().encode(
    '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>',
  )
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks()
})

function setupRead(bytes: Uint8Array) {
  mockRead.mockResolvedValue({ base64: bytesToB64(bytes), mimeType: "image/png" })
}

function getWrittenBytes(): Uint8Array {
  expect(mockWrite).toHaveBeenCalledTimes(1)
  const b64 = mockWrite.mock.calls[0][1]
  return b64ToBytes(b64)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("embedImageMetadata", () => {
  it("returns skip for empty alt and title", async () => {
    const result = await embedImageMetadata({
      absPath: "/fake/img.jpg",
      alt: "",
      title: "",
      mimeType: "image/jpeg",
    })
    expect(result.written).toBe(false)
    expect(result.skipReason).toBe("empty-alt-and-title")
    expect(mockRead).not.toHaveBeenCalled()
  })

  it("returns skip for unsupported MIME (gif)", async () => {
    setupRead(new Uint8Array([0x47, 0x49, 0x46]))
    const result = await embedImageMetadata({
      absPath: "/fake/img.gif",
      alt: "a cat",
      title: "",
      mimeType: "image/gif",
    })
    expect(result.written).toBe(false)
    expect(result.skipReason).toContain("unsupported-mime")
  })

  it("returns skip for unsupported MIME (bmp)", async () => {
    setupRead(new Uint8Array([0x42, 0x4d]))
    const result = await embedImageMetadata({
      absPath: "/fake/img.bmp",
      alt: "a cat",
      title: "",
      mimeType: "image/bmp",
    })
    expect(result.written).toBe(false)
    expect(result.skipReason).toContain("unsupported-mime")
  })

  it("handles I/O errors gracefully", async () => {
    mockRead.mockRejectedValue(new Error("disk failure"))
    const result = await embedImageMetadata({
      absPath: "/fake/img.jpg",
      alt: "a cat",
      title: "",
      mimeType: "image/jpeg",
    })
    expect(result.written).toBe(false)
    expect(result.skipReason).toBe("io-error")
  })

  // ----- JPEG -----

  describe("JPEG", () => {
    it("inserts APP1 XMP + APP13 IPTC after SOI", async () => {
      setupRead(minimalJpeg())
      const result = await embedImageMetadata({
        absPath: "/fake/img.jpg",
        alt: "橘猫晒太阳",
        title: "窗台上的猫",
        mimeType: "image/jpeg",
      })
      expect(result.written).toBe(true)
      const out = getWrittenBytes()

      // SOI preserved
      expect(out[0]).toBe(0xff)
      expect(out[1]).toBe(0xd8)

      // Next segment should be APP1 (FF E1) with XMP
      expect(out[2]).toBe(0xff)
      expect(out[3]).toBe(0xe1)
      const app1Len = (out[4] << 8) | out[5]
      const app1Payload = out.subarray(6, 4 + app1Len)
      const app1Str = new TextDecoder().decode(app1Payload)
      expect(app1Str).toContain("http://ns.adobe.com/xap/1.0/")
      expect(app1Str).toContain("橘猫晒太阳")
      expect(app1Str).toContain("窗台上的猫")
      expect(app1Str).toContain("AltTextAccessibility")

      // After APP1: APP13 (FF ED) with IPTC IIM
      const afterApp1 = 4 + app1Len
      expect(out[afterApp1]).toBe(0xff)
      expect(out[afterApp1 + 1]).toBe(0xed)
      const app13Len = (out[afterApp1 + 2] << 8) | out[afterApp1 + 3]
      const app13Payload = out.subarray(afterApp1 + 4, afterApp1 + 2 + app13Len)
      // Should contain "8BIM" wrapper
      expect(app13Payload[0]).toBe(0x38) // '8'
      expect(app13Payload[1]).toBe(0x42) // 'B'
      expect(app13Payload[2]).toBe(0x49) // 'I'
      expect(app13Payload[3]).toBe(0x4d) // 'M'
      // IIM records should contain the alt text (UTF-8)
      const iimStr = new TextDecoder().decode(app13Payload)
      expect(iimStr).toContain("橘猫晒太阳")

      // EOI preserved at end
      expect(out[out.length - 2]).toBe(0xff)
      expect(out[out.length - 1]).toBe(0xd9)
    })

    it("rejects non-JPEG bytes", async () => {
      setupRead(new Uint8Array([0x00, 0x01, 0x02]))
      const result = await embedImageMetadata({
        absPath: "/fake/img.jpg",
        alt: "test",
        title: "",
        mimeType: "image/jpeg",
      })
      expect(result.written).toBe(false)
      expect(result.skipReason).toBe("format-parse-failed")
    })
  })

  // ----- PNG -----

  describe("PNG", () => {
    it("inserts iTXt chunks before IEND", async () => {
      setupRead(minimalPng())
      const result = await embedImageMetadata({
        absPath: "/fake/img.png",
        alt: "橘猫晒太阳",
        title: "窗台上的猫",
        mimeType: "image/png",
      })
      expect(result.written).toBe(true)
      const out = getWrittenBytes()

      // PNG signature preserved
      expect(out[0]).toBe(0x89)
      expect(out[1]).toBe(0x50)

      // Should contain iTXt chunks with our keywords
      const text = new TextDecoder().decode(out)
      expect(text).toContain("iTXt")
      expect(text).toContain("Description")
      expect(text).toContain("橘猫晒太阳")
      expect(text).toContain("Title")
      expect(text).toContain("窗台上的猫")
      expect(text).toContain("AltTextAccessibility")
      expect(text).toContain("XML:com.adobe.xmp")

      // IEND still present at end
      expect(text).toContain("IEND")
    })

    it("rejects non-PNG bytes", async () => {
      setupRead(new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07]))
      const result = await embedImageMetadata({
        absPath: "/fake/img.png",
        alt: "test",
        title: "",
        mimeType: "image/png",
      })
      expect(result.written).toBe(false)
      expect(result.skipReason).toBe("format-parse-failed")
    })
  })

  // ----- WebP -----

  describe("WebP", () => {
    it("adds VP8X + EXIF + XMP chunks to lossless WebP", async () => {
      setupRead(minimalWebp())
      const result = await embedImageMetadata({
        absPath: "/fake/img.webp",
        alt: "橘猫晒太阳",
        title: "窗台上的猫",
        mimeType: "image/webp",
      })
      expect(result.written).toBe(true)
      const out = getWrittenBytes()

      // RIFF header preserved
      expect(new TextDecoder().decode(out.subarray(0, 4))).toBe("RIFF")
      expect(new TextDecoder().decode(out.subarray(8, 12))).toBe("WEBP")

      // Should now contain VP8X, EXIF, XMP chunks
      const text = new TextDecoder().decode(out)
      expect(text).toContain("VP8X")
      expect(text).toContain("EXIF")
      expect(text).toContain("XMP ")
      expect(text).toContain("橘猫晒太阳")

      // VP8X flags should have EXIF (bit 3) and XMP (bit 2) set
      // Find VP8X chunk
      const vp8xIdx = text.indexOf("VP8X")
      expect(vp8xIdx).toBeGreaterThan(0)
      // VP8X data starts 8 bytes after the fourcc (4 fourcc + 4 size)
      const flags = out[vp8xIdx + 8]
      expect(flags & 0x0c).toBe(0x0c) // bits 2+3 set
    })

    it("rejects non-WebP bytes", async () => {
      setupRead(new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b]))
      const result = await embedImageMetadata({
        absPath: "/fake/img.webp",
        alt: "test",
        title: "",
        mimeType: "image/webp",
      })
      expect(result.written).toBe(false)
      expect(result.skipReason).toBe("format-parse-failed")
    })
  })

  // ----- SVG -----

  describe("SVG", () => {
    it("injects metadata + title + desc elements", async () => {
      setupRead(minimalSvg())
      const result = await embedImageMetadata({
        absPath: "/fake/img.svg",
        alt: "橘猫晒太阳",
        title: "窗台上的猫",
        mimeType: "image/svg+xml",
      })
      expect(result.written).toBe(true)
      const out = getWrittenBytes()
      const text = new TextDecoder().decode(out)

      expect(text).toContain("<metadata>")
      expect(text).toContain("橘猫晒太阳")
      expect(text).toContain("窗台上的猫")
      expect(text).toContain("AltTextAccessibility")
      expect(text).toContain("<title>窗台上的猫</title>")
      expect(text).toContain("<desc>橘猫晒太阳</desc>")
      // Original content preserved
      expect(text).toContain("<rect")
    })

    it("replaces existing metadata block", async () => {
      const svg = new TextEncoder().encode(
        '<svg xmlns="http://www.w3.org/2000/svg"><metadata>OLD</metadata><rect/></svg>',
      )
      setupRead(svg)
      const result = await embedImageMetadata({
        absPath: "/fake/img.svg",
        alt: "new alt",
        title: "",
        mimeType: "image/svg+xml",
      })
      expect(result.written).toBe(true)
      const text = new TextDecoder().decode(getWrittenBytes())
      expect(text).not.toContain("OLD")
      expect(text).toContain("new alt")
    })

    it("rejects non-SVG content", async () => {
      setupRead(new TextEncoder().encode("<html><body>not svg</body></html>"))
      const result = await embedImageMetadata({
        absPath: "/fake/img.svg",
        alt: "test",
        title: "",
        mimeType: "image/svg+xml",
      })
      expect(result.written).toBe(false)
      expect(result.skipReason).toBe("format-parse-failed")
    })
  })

  // ----- XML escaping -----

  it("escapes XML special characters in alt/title", async () => {
    setupRead(minimalSvg())
    await embedImageMetadata({
      absPath: "/fake/img.svg",
      alt: 'a <b> & "c"',
      title: "",
      mimeType: "image/svg+xml",
    })
    const text = new TextDecoder().decode(getWrittenBytes())
    expect(text).toContain("&lt;b&gt;")
    expect(text).toContain("&amp;")
    expect(text).toContain("&quot;c&quot;")
    // Should NOT contain raw unescaped < in the alt value
    expect(text).not.toContain("a <b>")
  })

  // ----- MIME with charset suffix -----

  it("handles MIME with charset suffix", async () => {
    setupRead(minimalJpeg())
    const result = await embedImageMetadata({
      absPath: "/fake/img.jpg",
      alt: "test",
      title: "",
      mimeType: "image/jpeg; charset=binary",
    })
    expect(result.written).toBe(true)
  })
})

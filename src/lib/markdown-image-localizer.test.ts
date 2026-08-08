import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"

// Mock fs so the tests don't touch real disk. Follows the same pattern
// as `ingest-cache.test.ts` — the plan's §6 keeps DI narrow to
// `probeImageDimensions`; filesystem probes use module-level vi.mock.
vi.mock("@/commands/fs", () => ({
  fileExists: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
  createDirectory: vi.fn(),
  writeFileBase64: vi.fn(),
  copyFile: vi.fn(),
  readFileAsBase64: vi.fn(),
}))

// Mock captionImage so Phase-2 VLM tests can stub responses without
// hitting a real provider. Individual tests re-configure `mockImplementation`.
vi.mock("@/lib/vision-caption", () => ({
  captionImage: vi.fn(),
}))

import {
  MD_IMAGE_RE_WITH_TITLE,
  findImageReferencesWithTitle,
  classifyImageUrl,
  resolveLocalRelative,
  ALREADY_LOCALIZED_SUFFIX_RE,
  URL_CACHE_REL_PATH,
  readUrlCache,
  upsertUrlCacheEntry,
  isUrlCacheEntryFresh,
  sha8OfBytes,
  fetchRemoteImage,
  resolveDataUri,
  truncateDataUriForFrontmatter,
  localizeMarkdownImages,
  pathFormFor,
  formatImageAlt,
  formatImageTitle,
  rewriteBySlot,
  MAX_IMAGE_BYTES,
  mergeImageSourcesFrontmatter,
  type UrlCacheEntry,
  type LocalizeOptions,
  type RewriteSlot,
  type FrontmatterImageEntry,
} from "./markdown-image-localizer"
import {
  fileExists,
  readFile,
  writeFile,
  createDirectory,
  writeFileBase64,
  copyFile,
  readFileAsBase64,
} from "@/commands/fs"
import { captionImage } from "@/lib/vision-caption"

const mockFileExists = vi.mocked(fileExists)
const mockReadFile = vi.mocked(readFile)
const mockWriteFile = vi.mocked(writeFile)
const mockCreateDirectory = vi.mocked(createDirectory)
const mockWriteFileBase64 = vi.mocked(writeFileBase64)
const mockCopyFile = vi.mocked(copyFile)
const mockReadFileAsBase64 = vi.mocked(readFileAsBase64)
const mockCaptionImage = vi.mocked(captionImage)

beforeEach(() => {
  mockFileExists.mockReset()
  mockReadFile.mockReset()
  mockWriteFile.mockReset()
  mockCreateDirectory.mockReset()
  mockWriteFileBase64.mockReset()
  mockCopyFile.mockReset()
  mockReadFileAsBase64.mockReset()
  mockCaptionImage.mockReset()
  mockWriteFile.mockResolvedValue(undefined as unknown as void)
  mockCreateDirectory.mockResolvedValue(undefined as unknown as void)
  mockWriteFileBase64.mockResolvedValue(undefined as unknown as void)
  mockCopyFile.mockResolvedValue(undefined as unknown as void)
  // Default readFileAsBase64: return a minimal valid 1×1 PNG so that
  // Phase 3 metadata embedding (which reads the file back to patch
  // bytes) actually runs in VLM tests instead of silently failing with
  // "Cannot destructure property 'base64' of undefined".
  mockReadFileAsBase64.mockResolvedValue({
    base64: RED_1x1_PNG_B64,
    mimeType: "image/png",
  })
  // Default: reject VLM calls with a distinct sentinel so tests that
  // accidentally invoke it fail loudly. Individual VLM tests override.
  mockCaptionImage.mockRejectedValue(new Error("captionImage not mocked"))
})

// ---------------------------------------------------------------------------
// Group A / Test 1 — MD_IMAGE_RE_WITH_TITLE
// ---------------------------------------------------------------------------

describe("MD_IMAGE_RE_WITH_TITLE — regex shapes (§7, Group A test 1)", () => {
  const runOnce = (input: string) => {
    const re = new RegExp(MD_IMAGE_RE_WITH_TITLE.source, "g")
    return re.exec(input)
  }

  it("matches ![](url) — no alt, no title", () => {
    const m = runOnce("prose ![](https://example.com/foo.png) prose")
    expect(m).not.toBeNull()
    expect(m![2]).toBe("") // alt
    expect(m![4]).toBe("https://example.com/foo.png") // url
    expect(m![6]).toBeUndefined() // title inner
  })

  it("matches ![alt](url) — alt, no title", () => {
    const m = runOnce("![diagram](../assets/x.png)")
    expect(m).not.toBeNull()
    expect(m![2]).toBe("diagram")
    expect(m![4]).toBe("../assets/x.png")
    expect(m![6]).toBeUndefined()
  })

  it("matches ![alt](url \"title\") — full form with double quotes", () => {
    const m = runOnce('![alt](https://x/y.png "the title")')
    expect(m).not.toBeNull()
    expect(m![2]).toBe("alt")
    expect(m![4]).toBe("https://x/y.png")
    expect(m![5]).toBe('"') // delimiter
    expect(m![6]).toBe("the title")
  })

  it("matches ![alt](url 'title') — single-quoted title", () => {
    const m = runOnce("![alt](https://x/y.png 'single quotes')")
    expect(m).not.toBeNull()
    expect(m![4]).toBe("https://x/y.png")
    expect(m![5]).toBe("'")
    expect(m![6]).toBe("single quotes")
  })

  it("matches ![alt with \\] fun](url) — escaped bracket in alt", () => {
    // Backslash-escaped `]` is a valid CommonMark alt character. Our
    // regex uses `(?:\\\]|[^\]])*` to admit it in the alt group.
    const m = runOnce("![alt with \\] fun](https://x/y.png)")
    expect(m).not.toBeNull()
    expect(m![2]).toBe("alt with \\] fun")
    expect(m![4]).toBe("https://x/y.png")
  })

  it("does NOT match <img> HTML tags (documented Phase 1 non-goal)", () => {
    const m = runOnce('<img src="https://x/y.png" alt="foo">')
    expect(m).toBeNull()
  })

  it("scanner returns all references in source order (integration of test 1)", () => {
    const md = [
      "Intro",
      "![](https://a.example/1.png)",
      "Middle text.",
      '![second](../two.png "two title")',
      "Tail with ![third](./three.png 'triple').",
    ].join("\n")
    const refs = findImageReferencesWithTitle(md)
    expect(refs).toHaveLength(3)
    expect(refs[0].url).toBe("https://a.example/1.png")
    expect(refs[0].alt).toBe("")
    expect(refs[0].title).toBeUndefined()
    expect(refs[1].url).toBe("../two.png")
    expect(refs[1].alt).toBe("second")
    expect(refs[1].title).toBe("two title")
    expect(refs[1].titleDelim).toBe('"')
    expect(refs[2].url).toBe("./three.png")
    expect(refs[2].title).toBe("triple")
    expect(refs[2].titleDelim).toBe("'")
    // Offsets are monotonic and valid slice anchors.
    for (const ref of refs) {
      expect(md.slice(ref.offset, ref.offset + ref.length)).toMatch(
        /^!\[[^\]]*\]\(/,
      )
    }
  })
})

// ---------------------------------------------------------------------------
// Group A / Test 2 — classifyImageUrl (§5)
// ---------------------------------------------------------------------------

describe("classifyImageUrl — 8 branches (§5, Group A test 2)", () => {
  const projectPath = "/project"
  const sourceDir = "/project/raw/sources"

  it("https:// → remote-http", async () => {
    const cls = await classifyImageUrl(
      "https://example.com/foo.png",
      sourceDir,
      projectPath,
    )
    expect(cls).toBe("remote-http")
  })

  it("http:// → remote-http", async () => {
    const cls = await classifyImageUrl(
      "http://example.com/foo.png",
      sourceDir,
      projectPath,
    )
    expect(cls).toBe("remote-http")
  })

  it("data:image/... → data-uri", async () => {
    const cls = await classifyImageUrl(
      "data:image/png;base64,iVBORw0KGgo=",
      sourceDir,
      projectPath,
    )
    expect(cls).toBe("data-uri")
  })

  it("../assets/x.png (file exists) → local-relative", async () => {
    // Relative path resolves inside project, file exists, NOT under
    // wiki/media/<slug>/<name>-<sha8> → local-relative.
    mockFileExists.mockResolvedValue(true)
    const cls = await classifyImageUrl(
      "../assets/x.png",
      sourceDir,
      projectPath,
    )
    expect(cls).toBe("local-relative")
    // Verify what path we probed — should have resolved
    // /project/raw/sources + ../assets/x.png → /project/raw/assets/x.png
    expect(mockFileExists).toHaveBeenCalledWith("/project/raw/assets/x.png")
  })

  it("../assets/missing.png (file doesn't exist) → failed", async () => {
    // Distinct from unsupported: relative path shape is well-formed
    // and stays inside project, but the target file isn't on disk.
    mockFileExists.mockResolvedValue(false)
    const cls = await classifyImageUrl(
      "../assets/missing.png",
      sourceDir,
      projectPath,
    )
    expect(cls).toBe("failed")
  })

  it("../../wiki/media/notes/foo-abc12345.png (file exists) → already-localized", async () => {
    mockFileExists.mockResolvedValue(true)
    const cls = await classifyImageUrl(
      "../../wiki/media/notes/foo-abc12345.png",
      sourceDir,
      projectPath,
    )
    expect(cls).toBe("already-localized")
    expect(mockFileExists).toHaveBeenCalledWith(
      "/project/wiki/media/notes/foo-abc12345.png",
    )
  })

  it("../../wiki/media/notes/foo-abc12345.png (file missing) → failed (§5 fall-through)", async () => {
    // Shape matches already-localized regex but file is missing. Per
    // §5 the classifier falls through to local-relative; local-relative
    // then requires the file to exist to avoid `failed`. Since the
    // file is missing on both branches, the final answer is `failed`.
    mockFileExists.mockResolvedValue(false)
    const cls = await classifyImageUrl(
      "../../wiki/media/notes/foo-abc12345.png",
      sourceDir,
      projectPath,
    )
    expect(cls).toBe("failed")
  })

  it("../../../../etc/passwd (path traversal) → failed (isInsideProject rejects)", async () => {
    // fileExists must NOT be called — we bail on the boundary check.
    const cls = await classifyImageUrl(
      "../../../../etc/passwd",
      sourceDir,
      projectPath,
    )
    expect(cls).toBe("failed")
    expect(mockFileExists).not.toHaveBeenCalled()
  })

  it("ftp://x/y → unsupported (documented Phase 1 non-goal)", async () => {
    const cls = await classifyImageUrl("ftp://x/y", sourceDir, projectPath)
    expect(cls).toBe("unsupported")
    expect(mockFileExists).not.toHaveBeenCalled()
  })

  it("mailto:foo@bar → unsupported OR failed (any non-http/data scheme)", async () => {
    // `mailto:` has no `//` so it doesn't match the generic scheme
    // regex; it falls through to local-relative resolution. Either
    // outcome (unsupported due to strict scheme sniff, or failed
    // because the resolved path doesn't exist) is acceptable — this
    // test locks in "not classified as remote-http/data-uri/etc".
    mockFileExists.mockResolvedValue(false)
    const cls = await classifyImageUrl(
      "mailto:foo@bar",
      sourceDir,
      projectPath,
    )
    expect(cls === "failed" || cls === "unsupported").toBe(true)
  })

  it("data:text/plain;... → unsupported (non-image data URI)", async () => {
    const cls = await classifyImageUrl(
      "data:text/plain;base64,SGVsbG8=",
      sourceDir,
      projectPath,
    )
    expect(cls).toBe("unsupported")
  })
})

// ---------------------------------------------------------------------------
// Supporting: resolveLocalRelative + ALREADY_LOCALIZED_SUFFIX_RE
// ---------------------------------------------------------------------------

describe("resolveLocalRelative — path resolution + boundary check (§5, §4)", () => {
  it("resolves ../assets/x.png against /project/raw/sources → /project/raw/assets/x.png (inside)", () => {
    const r = resolveLocalRelative(
      "../assets/x.png",
      "/project/raw/sources",
      "/project",
    )
    expect(r.absPath).toBe("/project/raw/assets/x.png")
    expect(r.insideProject).toBe(true)
  })

  it("resolves ./same-dir.png against /project/raw/sources → /project/raw/sources/same-dir.png", () => {
    const r = resolveLocalRelative(
      "./same-dir.png",
      "/project/raw/sources",
      "/project",
    )
    expect(r.absPath).toBe("/project/raw/sources/same-dir.png")
    expect(r.insideProject).toBe(true)
  })

  it("resolves ../../wiki/media/slug/foo-abcdef01.png → /project/wiki/media/slug/foo-abcdef01.png", () => {
    const r = resolveLocalRelative(
      "../../wiki/media/slug/foo-abcdef01.png",
      "/project/raw/sources",
      "/project",
    )
    expect(r.absPath).toBe("/project/wiki/media/slug/foo-abcdef01.png")
    expect(r.insideProject).toBe(true)
  })

  it("flags escape-attempts as outside project", () => {
    const r = resolveLocalRelative(
      "../../../../etc/passwd",
      "/project/raw/sources",
      "/project",
    )
    expect(r.insideProject).toBe(false)
  })
})

describe("ALREADY_LOCALIZED_SUFFIX_RE — matches only the localized shape", () => {
  it("matches wiki/media/<slug>/<name>-<sha8>.<ext>", () => {
    expect(
      ALREADY_LOCALIZED_SUFFIX_RE.test(
        "/project/wiki/media/notes/foo-abc12345.png",
      ),
    ).toBe(true)
    expect(
      ALREADY_LOCALIZED_SUFFIX_RE.test(
        "/project/wiki/media/deep-slug/some-name-01234567.webp",
      ),
    ).toBe(true)
  })

  it("rejects paths without the -<sha8> suffix", () => {
    expect(
      ALREADY_LOCALIZED_SUFFIX_RE.test("/project/wiki/media/notes/foo.png"),
    ).toBe(false)
  })

  it("rejects paths outside wiki/media/", () => {
    expect(
      ALREADY_LOCALIZED_SUFFIX_RE.test(
        "/project/raw/assets/foo-abc12345.png",
      ),
    ).toBe(false)
  })

  it("rejects a wrong sha8 length", () => {
    expect(
      ALREADY_LOCALIZED_SUFFIX_RE.test(
        "/project/wiki/media/notes/foo-abc123.png", // 6 chars, not 8
      ),
    ).toBe(false)
    expect(
      ALREADY_LOCALIZED_SUFFIX_RE.test(
        "/project/wiki/media/notes/foo-abc1234567.png", // 10 chars, not 8
      ),
    ).toBe(false)
  })

  it("rejects uppercase hex in sha8 (we always write lowercase)", () => {
    expect(
      ALREADY_LOCALIZED_SUFFIX_RE.test(
        "/project/wiki/media/notes/foo-ABC12345.png",
      ),
    ).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// URL cache — data layer (Commit 3b; §3.2)
// ---------------------------------------------------------------------------

/** Sample entry used across the URL cache tests. */
const sampleEntry: UrlCacheEntry = {
  sha256: "0123456789abcdef".repeat(4),
  mimeType: "image/png",
  width: 640,
  height: 480,
  bytesLen: 12345,
  fetchedAt: "2026-07-23T00:00:00.000Z",
  canonicalRelPath: "wiki/media/slug/logo-01234567.png",
}

describe("readUrlCache — corrupt-tolerant loader (§Risk #5)", () => {
  it("returns empty map when the cache file does not exist", async () => {
    mockFileExists.mockResolvedValue(false)
    const out = await readUrlCache("/project")
    expect(out).toEqual({})
    expect(mockReadFile).not.toHaveBeenCalled()
  })

  it("probes the exact cache path at .llm-wiki/image-url-cache.json", async () => {
    mockFileExists.mockResolvedValue(false)
    await readUrlCache("/project")
    expect(mockFileExists).toHaveBeenCalledWith(`/project/${URL_CACHE_REL_PATH}`)
  })

  it("returns the parsed cache on a well-formed JSON object", async () => {
    mockFileExists.mockResolvedValue(true)
    mockReadFile.mockResolvedValue(
      JSON.stringify({ "https://x/y.png": sampleEntry }),
    )
    const out = await readUrlCache("/project")
    expect(out).toEqual({ "https://x/y.png": sampleEntry })
  })

  it("warns and returns empty when JSON is malformed (recover, don't wedge)", async () => {
    mockFileExists.mockResolvedValue(true)
    mockReadFile.mockResolvedValue("{ not really json")
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {})
    const out = await readUrlCache("/project")
    expect(out).toEqual({})
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })

  it("returns empty when the parsed value isn't a plain object (e.g. an array)", async () => {
    mockFileExists.mockResolvedValue(true)
    mockReadFile.mockResolvedValue(JSON.stringify(["not", "a", "map"]))
    const out = await readUrlCache("/project")
    expect(out).toEqual({})
  })

  it("returns empty when the parsed value is null", async () => {
    mockFileExists.mockResolvedValue(true)
    mockReadFile.mockResolvedValue("null")
    const out = await readUrlCache("/project")
    expect(out).toEqual({})
  })
})

describe("upsertUrlCacheEntry — per-key merge write (§3.2 concurrency note)", () => {
  it("writes the new entry when the cache didn't exist", async () => {
    mockFileExists.mockResolvedValue(false)
    await upsertUrlCacheEntry("/project", "https://a/1.png", sampleEntry)
    expect(mockCreateDirectory).toHaveBeenCalledWith("/project/.llm-wiki")
    expect(mockWriteFile).toHaveBeenCalledTimes(1)
    const [path, body] = mockWriteFile.mock.calls[0]
    expect(path).toBe(`/project/${URL_CACHE_REL_PATH}`)
    expect(JSON.parse(body)).toEqual({ "https://a/1.png": sampleEntry })
  })

  it("preserves other keys when merging a new key into an existing cache", async () => {
    const existing = { "https://a/1.png": sampleEntry }
    mockFileExists.mockResolvedValue(true)
    mockReadFile.mockResolvedValue(JSON.stringify(existing))
    const secondEntry: UrlCacheEntry = {
      ...sampleEntry,
      sha256: "ffff".repeat(16),
      canonicalRelPath: "wiki/media/slug/other-abcd1234.png",
    }
    await upsertUrlCacheEntry("/project", "https://b/2.png", secondEntry)
    const written = JSON.parse(mockWriteFile.mock.calls[0][1])
    expect(written).toEqual({
      "https://a/1.png": sampleEntry,
      "https://b/2.png": secondEntry,
    })
  })

  it("overwrites the same key with the new entry (TTL bump path)", async () => {
    const stale: UrlCacheEntry = {
      ...sampleEntry,
      fetchedAt: "2025-01-01T00:00:00.000Z",
    }
    mockFileExists.mockResolvedValue(true)
    mockReadFile.mockResolvedValue(
      JSON.stringify({ "https://x/y.png": stale }),
    )
    await upsertUrlCacheEntry("/project", "https://x/y.png", sampleEntry)
    const written = JSON.parse(mockWriteFile.mock.calls[0][1])
    expect(written).toEqual({ "https://x/y.png": sampleEntry })
  })

  it("recovers from a corrupt cache — treats it as empty and writes just the new entry", async () => {
    mockFileExists.mockResolvedValue(true)
    mockReadFile.mockResolvedValue("<< not json >>")
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {})
    await upsertUrlCacheEntry("/project", "https://x/y.png", sampleEntry)
    spy.mockRestore()
    const written = JSON.parse(mockWriteFile.mock.calls[0][1])
    expect(written).toEqual({ "https://x/y.png": sampleEntry })
  })
})

// ---------------------------------------------------------------------------
// isUrlCacheEntryFresh — TTL helper (§3.2)
// ---------------------------------------------------------------------------

describe("isUrlCacheEntryFresh — 45-day default TTL semantics", () => {
  const day = 24 * 60 * 60 * 1000
  const now = Date.parse("2026-07-23T00:00:00.000Z")

  it("returns true when fetched an hour ago", () => {
    const entry = { fetchedAt: new Date(now - 60 * 60 * 1000).toISOString() }
    expect(isUrlCacheEntryFresh(entry, 45, now)).toBe(true)
  })

  it("returns true right up to the TTL boundary (inclusive)", () => {
    const entry = { fetchedAt: new Date(now - 45 * day).toISOString() }
    expect(isUrlCacheEntryFresh(entry, 45, now)).toBe(true)
  })

  it("returns false one millisecond past the TTL boundary", () => {
    const entry = { fetchedAt: new Date(now - 45 * day - 1).toISOString() }
    expect(isUrlCacheEntryFresh(entry, 45, now)).toBe(false)
  })

  it("returns false for a fetch older than 45 days when ttlDays=45", () => {
    const entry = { fetchedAt: new Date(now - 100 * day).toISOString() }
    expect(isUrlCacheEntryFresh(entry, 45, now)).toBe(false)
  })

  it("returns true when fetchedAt is in the future (clock-skew tolerance)", () => {
    const entry = { fetchedAt: new Date(now + 5 * day).toISOString() }
    expect(isUrlCacheEntryFresh(entry, 45, now)).toBe(true)
  })

  it("returns false when fetchedAt is malformed (safer: force re-fetch)", () => {
    expect(isUrlCacheEntryFresh({ fetchedAt: "not a date" }, 45, now)).toBe(false)
    expect(isUrlCacheEntryFresh({ fetchedAt: "" }, 45, now)).toBe(false)
  })

  it("respects a caller-supplied TTL of 0 (no freshness — every entry stale except right now)", () => {
    // Exactly `now` still counts as fresh (0ms age ≤ 0ms TTL).
    const entry = { fetchedAt: new Date(now).toISOString() }
    expect(isUrlCacheEntryFresh(entry, 0, now)).toBe(true)
    // 1ms older → stale.
    const older = { fetchedAt: new Date(now - 1).toISOString() }
    expect(isUrlCacheEntryFresh(older, 0, now)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// sha8OfBytes — filename disambiguator
// ---------------------------------------------------------------------------

describe("sha8OfBytes — 8-char lowercase hex prefix", () => {
  it("returns exactly 8 hex chars", async () => {
    const hex = await sha8OfBytes(new Uint8Array([1, 2, 3, 4]))
    expect(hex).toMatch(/^[0-9a-f]{8}$/)
  })

  it("is deterministic for the same input bytes", async () => {
    const a = await sha8OfBytes(new Uint8Array([9, 9, 9]))
    const b = await sha8OfBytes(new Uint8Array([9, 9, 9]))
    expect(a).toBe(b)
  })

  it("matches the SHA-256 prefix of the input (known vector)", async () => {
    // SHA-256 of the ASCII bytes for "abc" is
    //   ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad
    // → prefix "ba7816bf".
    const bytes = new TextEncoder().encode("abc")
    const hex = await sha8OfBytes(bytes)
    expect(hex).toBe("ba7816bf")
  })

  it("distinguishes distinct inputs (near-input collision would be a red flag)", async () => {
    const a = await sha8OfBytes(new Uint8Array([0]))
    const b = await sha8OfBytes(new Uint8Array([1]))
    expect(a).not.toBe(b)
  })
})

// ---------------------------------------------------------------------------
// resolveDataUri + truncateDataUriForFrontmatter (Commit 3c)
// ---------------------------------------------------------------------------

/** Base64 for a 1×1 red PNG — used as a valid image payload across tests. */
const RED_1x1_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="

describe("resolveDataUri — image data URI decoder (§10 rule 7)", () => {
  it("decodes a valid base64 image/png data URI", () => {
    const { bytes, mimeType } = resolveDataUri(
      `data:image/png;base64,${RED_1x1_PNG_B64}`,
    )
    expect(mimeType).toBe("image/png")
    expect(bytes.byteLength).toBeGreaterThan(0)
    // PNG magic bytes: 89 50 4E 47
    expect(bytes[0]).toBe(0x89)
    expect(bytes[1]).toBe(0x50)
  })

  it("accepts charset= parameter alongside base64", () => {
    const { mimeType } = resolveDataUri(
      `data:image/png;charset=utf-8;base64,${RED_1x1_PNG_B64}`,
    )
    expect(mimeType).toBe("image/png")
  })

  it("rejects non-image MIME types", () => {
    expect(() =>
      resolveDataUri("data:text/plain;base64,SGVsbG8="),
    ).toThrow(/Non-image/)
  })

  it("rejects non-base64 data URIs (Phase 1 non-goal)", () => {
    expect(() =>
      resolveDataUri("data:image/svg+xml,<svg></svg>"),
    ).toThrow(/not base64/i)
  })

  it("rejects malformed data URIs entirely", () => {
    expect(() => resolveDataUri("not a data uri")).toThrow(/Malformed/)
  })

  it("rejects decoded payloads that exceed 20 MB", () => {
    // Build 21 MB of zero bytes → base64 (~28 MB string).
    const bigBytes = new Uint8Array(21 * 1024 * 1024)
    let binary = ""
    const chunkSize = 0x8000
    for (let i = 0; i < bigBytes.length; i += chunkSize) {
      binary += String.fromCharCode(
        ...bigBytes.subarray(i, i + chunkSize),
      )
    }
    const b64 = btoa(binary)
    expect(() => resolveDataUri(`data:image/png;base64,${b64}`)).toThrow(
      /decoded size exceeds/,
    )
  })
})

describe("truncateDataUriForFrontmatter — 64-char cap (§11 table)", () => {
  it("returns short data URIs unchanged", () => {
    const short = "data:image/png;base64,iVBORw0KGgo="
    expect(truncateDataUriForFrontmatter(short)).toBe(short)
  })

  it("truncates a long data URI to 64 chars + '…'", () => {
    const long = "data:image/png;base64," + "A".repeat(200)
    const out = truncateDataUriForFrontmatter(long)
    expect(out.length).toBe(65) // 64 + one ellipsis char
    expect(out.endsWith("…")).toBe(true)
    expect(out.startsWith("data:image/png;base64,")).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Group E — network defense (Commit 3c; §10)
// ---------------------------------------------------------------------------

/** Build a minimal `Response`-like object for a raw byte body. */
function makeResponse(
  bytes: Uint8Array,
  init: {
    status?: number
    contentType?: string
    contentLength?: string | null
    url?: string
  } = {},
): Response {
  const headers = new Headers()
  if (init.contentType !== null) {
    headers.set("content-type", init.contentType ?? "image/png")
  }
  if (init.contentLength !== null) {
    if (init.contentLength !== undefined) {
      headers.set("content-length", init.contentLength)
    }
  }
  const r = new Response(bytes as unknown as BodyInit, {
    status: init.status ?? 200,
    headers,
  })
  return r
}

describe("fetchRemoteImage — §10 defenses (Group E, tests 18-23)", () => {
  it("test 18 — SSRF: private-network host rejected before any fetch", async () => {
    const spy = vi.fn()
    await expect(
      fetchRemoteImage("http://192.168.1.1/x.png", 5_000, spy as unknown as typeof fetch),
    ).rejects.toThrow(/private|local/i)
    expect(spy).not.toHaveBeenCalled()
  })

  it("test 19 — redirect from public to private host rejected", async () => {
    // First call: 302 with Location pointing to a private host.
    // fetchImportUrl catches the cross-boundary redirect and throws.
    const spy = vi.fn(async (url: string) => {
      if (url.startsWith("https://public.example/")) {
        return new Response(null, {
          status: 302,
          headers: { location: "http://10.0.0.1/x.png" },
        })
      }
      return new Response("nope", { status: 500 })
    })
    await expect(
      fetchRemoteImage(
        "https://public.example/x.png",
        5_000,
        spy as unknown as typeof fetch,
      ),
    ).rejects.toThrow(/private|local/i)
  })

  it("test 20 — Content-Length > 20 MB rejected before body read", async () => {
    const spy = vi.fn(async () =>
      makeResponse(new Uint8Array(0), {
        contentType: "image/png",
        contentLength: String(500_000_000),
      }),
    )
    await expect(
      fetchRemoteImage(
        "https://example.com/big.png",
        5_000,
        spy as unknown as typeof fetch,
      ),
    ).rejects.toThrow(/exceeds/)
    // spy WAS called — HTTP request went out — but body was never read.
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it("test 21 — streaming body cap catches missing/lying Content-Length", async () => {
    // Response with NO content-length, but body > 20 MB. The stream
    // must abort before we buffer the whole thing.
    const oversized = new Uint8Array(MAX_IMAGE_BYTES + 1024)
    const spy = vi.fn(async () =>
      makeResponse(oversized, {
        contentType: "image/png",
        contentLength: null,
      }),
    )
    await expect(
      fetchRemoteImage(
        "https://example.com/mystery.png",
        5_000,
        spy as unknown as typeof fetch,
      ),
    ).rejects.toThrow(/exceeds/)
  })

  it("test 22 — Content-Type text/html rejected", async () => {
    const spy = vi.fn(async () =>
      makeResponse(new TextEncoder().encode("<html>"), {
        contentType: "text/html",
      }),
    )
    await expect(
      fetchRemoteImage(
        "https://example.com/not-really.png",
        5_000,
        spy as unknown as typeof fetch,
      ),
    ).rejects.toThrow(/non-image/i)
  })

  it("test 23 — timeout aborts the fetch (30s default; 50ms in test)", async () => {
    // Never-resolving fetch; timeout=50ms should abort it.
    const spy = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_, reject) => {
          init.signal?.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"))
          })
        }),
    )
    await expect(
      fetchRemoteImage(
        "https://example.com/slow.png",
        50,
        spy as unknown as typeof fetch,
      ),
    ).rejects.toThrow()
  })

  it("happy path — small image/png body returned as bytes + mime", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const spy = vi.fn(async () =>
      makeResponse(png, { contentType: "image/png" }),
    )
    const out = await fetchRemoteImage(
      "https://example.com/tiny.png",
      5_000,
      spy as unknown as typeof fetch,
    )
    expect(out.mimeType).toBe("image/png")
    expect(out.bytes.byteLength).toBe(png.byteLength)
    expect(out.bytes[0]).toBe(0x89)
  })

  it("rejects URLs with embedded credentials before any fetch", async () => {
    const spy = vi.fn()
    await expect(
      fetchRemoteImage(
        "https://user:pass@example.com/x.png",
        5_000,
        spy as unknown as typeof fetch,
      ),
    ).rejects.toThrow(/credentials/i)
    expect(spy).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Group D — caching (Commit 3c; tests 14-17)
// ---------------------------------------------------------------------------

/** Base options for `localizeMarkdownImages` integration tests. */
function makeOpts(overrides: Partial<LocalizeOptions> = {}): LocalizeOptions {
  return {
    projectPath: "/project",
    sourcePath: "/project/raw/sources/notes.md",
    sourceSummarySlug: "notes",
    markdown: "",
    // Default provider is VLM-capable so canRunVlm=true. Tests that
    // want the codex-cli gate override this.
    llmConfig: {
      provider: "openai",
      apiKey: "test-key",
      model: "gpt-4o",
    } as unknown as LocalizeOptions["llmConfig"],
    multimodalConfig: {
      concurrency: 4,
      model: "test-model",
      minImagePixelSize: 64,
      imageFetchTimeoutMs: 5_000,
      urlCacheTtlDays: 45,
      localizeMarkdownImages: true,
    } as unknown as LocalizeOptions["multimodalConfig"],
    // Default probe returns unknown dims (0,0) so §2 threshold treats
    // as "over threshold → run VLM" — matches production Tauri probe
    // behavior when the format isn't decodable. Tests that exercise
    // the too-small branch override with a stub returning known small
    // dims.
    probeImageDimensions: async () => ({ width: 0, height: 0 }),
    ...overrides,
  }
}

/** Install a global fetch stub for one test. */
function stubFetch(impl: (url: string, init: RequestInit) => Promise<Response>) {
  const spy = vi.fn(impl)
  vi.stubGlobal("fetch", spy)
  return spy
}

describe("localizeMarkdownImages — Group D caching (tests 14-17)", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("test 14 — URL cache TTL fresh: no HTTP call, urlCacheHits === 1", async () => {
    const url = "https://example.com/cat.png"
    const cached: UrlCacheEntry = {
      sha256: "0123456789abcdef".repeat(4),
      mimeType: "image/png",
      width: 0,
      height: 0,
      bytesLen: 1234,
      fetchedAt: new Date().toISOString(),
      canonicalRelPath: "wiki/media/notes/cat-01234567.png",
    }
    // fileExists returns true for the URL cache file and the
    // canonical media file; false otherwise.
    mockFileExists.mockImplementation(async (p: string) => {
      if (p.endsWith("image-url-cache.json")) return true
      if (p.endsWith("cat-01234567.png")) return true
      return false
    })
    mockReadFile.mockResolvedValue(JSON.stringify({ [url]: cached }))
    const fetchSpy = stubFetch(async () => new Response("", { status: 500 }))

    const result = await localizeMarkdownImages(
      makeOpts({ markdown: `Look: ![](${url})` }),
    )

    expect(fetchSpy).not.toHaveBeenCalled()
    expect(result.stats.urlCacheHits).toBe(1)
    expect(result.stats.downloaded).toBe(0)
    expect(result.stats.failed).toBe(0)
    expect(result.savedImages).toHaveLength(1)
    expect(result.savedImages[0].relPath).toBe("media/notes/cat-01234567.png")
  })

  it("test 15 — URL cache expired: HTTP call happens, cache re-upserted", async () => {
    const url = "https://example.com/logo.png"
    // 90 days old → expired against 45-day default TTL.
    const stale: UrlCacheEntry = {
      sha256: "aa".repeat(32),
      mimeType: "image/png",
      width: 0,
      height: 0,
      bytesLen: 999,
      fetchedAt: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString(),
      canonicalRelPath: "wiki/media/notes/logo-aabbccdd.png",
    }
    // Cache file present; canonical media file exists too, but TTL is
    // stale so we still re-fetch. Media write target does NOT exist
    // yet at the new sha8 path.
    mockFileExists.mockImplementation(async (p: string) => {
      if (p.endsWith("image-url-cache.json")) return true
      if (p.endsWith("logo-aabbccdd.png")) return true
      return false
    })
    mockReadFile.mockResolvedValue(JSON.stringify({ [url]: stale }))

    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])
    const fetchSpy = stubFetch(async () =>
      new Response(png, {
        status: 200,
        headers: { "content-type": "image/png" },
      }),
    )

    const result = await localizeMarkdownImages(
      makeOpts({ markdown: `![](${url})` }),
    )

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(result.stats.downloaded).toBe(1)
    expect(result.stats.urlCacheHits).toBe(0)
    expect(result.stats.failed).toBe(0)
    expect(mockWriteFileBase64).toHaveBeenCalledTimes(1)
    // Cache was upserted with the new fetch (write of the JSON file).
    expect(mockWriteFile).toHaveBeenCalled()
    const [, cacheJson] = mockWriteFile.mock.calls[0]
    const parsed = JSON.parse(cacheJson)
    expect(parsed[url]).toBeDefined()
    // fetchedAt bumped to now (within a few seconds).
    const bumped = Date.parse(parsed[url].fetchedAt)
    expect(Math.abs(bumped - Date.now())).toBeLessThan(5_000)
  })

  it("test 17 — cold path: HTTP fetch + write + cache create", async () => {
    const url = "https://example.com/fresh.png"
    // No cache file, no media file.
    mockFileExists.mockResolvedValue(false)
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const fetchSpy = stubFetch(async () =>
      new Response(png, {
        status: 200,
        headers: { "content-type": "image/png" },
      }),
    )

    const result = await localizeMarkdownImages(
      makeOpts({ markdown: `![](${url})` }),
    )

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(result.stats.downloaded).toBe(1)
    expect(mockWriteFileBase64).toHaveBeenCalledTimes(1)
    // Written to /project/wiki/media/notes/fresh-<sha8>.png
    const [writePath] = mockWriteFileBase64.mock.calls[0]
    expect(writePath).toMatch(
      /^\/project\/wiki\/media\/notes\/fresh-[0-9a-f]{8}\.png$/,
    )
    // Cache file written too.
    expect(mockCreateDirectory).toHaveBeenCalledWith("/project/.llm-wiki")
    expect(mockWriteFile).toHaveBeenCalled()
    // SavedImages surfaces the correct relPath (wiki-relative).
    expect(result.savedImages).toHaveLength(1)
    expect(result.savedImages[0].relPath).toMatch(
      /^media\/notes\/fresh-[0-9a-f]{8}\.png$/,
    )
  })

  it("no image refs → early return with zero stats and no I/O", async () => {
    mockFileExists.mockResolvedValue(false)
    const fetchSpy = stubFetch(async () => new Response(""))
    const result = await localizeMarkdownImages(
      makeOpts({ markdown: "Just prose. No images." }),
    )
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(mockCreateDirectory).not.toHaveBeenCalled()
    expect(result.stats.downloaded).toBe(0)
    expect(result.stats.failed).toBe(0)
    expect(result.savedImages).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Main-entry branches — data-uri, local-relative, already-localized, mixed
// ---------------------------------------------------------------------------

describe("localizeMarkdownImages — non-remote branches", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("data-uri branch: decodes, writes to wiki/media/, stats.decoded === 1", async () => {
    mockFileExists.mockResolvedValue(false)
    const dataUri = `data:image/png;base64,${RED_1x1_PNG_B64}`
    const result = await localizeMarkdownImages(
      makeOpts({ markdown: `![](${dataUri})` }),
    )
    expect(result.stats.decoded).toBe(1)
    expect(result.stats.downloaded).toBe(0)
    expect(mockWriteFileBase64).toHaveBeenCalledTimes(1)
    const [writePath] = mockWriteFileBase64.mock.calls[0]
    expect(writePath).toMatch(
      /^\/project\/wiki\/media\/notes\/inline-[0-9a-f]{8}\.png$/,
    )
  })

  it("local-relative branch: reads source, copies to media dir, stats.copied === 1", async () => {
    // File exists at source location + never at target.
    mockFileExists.mockImplementation(async (p: string) => {
      if (p === "/project/raw/assets/pic.png") return true
      if (p.endsWith("image-url-cache.json")) return false
      return false
    })
    // Rust probe returns a valid PNG base64.
    mockReadFileAsBase64.mockResolvedValue({
      base64: RED_1x1_PNG_B64,
      mimeType: "image/png",
    })
    stubFetch(async () => new Response("", { status: 500 }))

    const result = await localizeMarkdownImages(
      makeOpts({ markdown: "![alt](../assets/pic.png)" }),
    )

    expect(result.stats.copied).toBe(1)
    expect(result.stats.failed).toBe(0)
    expect(mockCopyFile).toHaveBeenCalledTimes(1)
    const [src, dst] = mockCopyFile.mock.calls[0]
    expect(src).toBe("/project/raw/assets/pic.png")
    expect(dst).toMatch(
      /^\/project\/wiki\/media\/notes\/pic-[0-9a-f]{8}\.png$/,
    )
  })

  it("already-localized branch: no I/O side effects, stats.alreadyLocalized === 1", async () => {
    mockFileExists.mockImplementation(async (p: string) => {
      if (p.endsWith("cached-abc12345.png")) return true
      return false
    })
    stubFetch(async () => new Response("", { status: 500 }))

    const result = await localizeMarkdownImages(
      makeOpts({
        markdown: "![](../../wiki/media/notes/cached-abc12345.png)",
      }),
    )

    expect(result.stats.alreadyLocalized).toBe(1)
    expect(result.stats.downloaded).toBe(0)
    expect(mockWriteFileBase64).not.toHaveBeenCalled()
    expect(mockCopyFile).not.toHaveBeenCalled()
    // already-localized refs are NOT surfaced in savedImages (see main entry filter).
    expect(result.savedImages).toEqual([])
  })

  it("mixed body: 1 remote + 1 data-uri + 1 already-localized → correct stats fan-out", async () => {
    mockFileExists.mockImplementation(async (p: string) => {
      if (p.endsWith("cached-abc12345.png")) return true
      return false
    })
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    stubFetch(async () =>
      new Response(png, {
        status: 200,
        headers: { "content-type": "image/png" },
      }),
    )

    const md = [
      "![](https://example.com/one.png)",
      `![](data:image/png;base64,${RED_1x1_PNG_B64})`,
      "![](../../wiki/media/notes/cached-abc12345.png)",
    ].join("\n\n")

    const result = await localizeMarkdownImages(makeOpts({ markdown: md }))

    expect(result.stats.downloaded).toBe(1)
    expect(result.stats.decoded).toBe(1)
    expect(result.stats.alreadyLocalized).toBe(1)
    expect(result.stats.failed).toBe(0)
    // remote + data-uri surface as savedImages; already-localized doesn't.
    expect(result.savedImages).toHaveLength(2)
  })

  it("failed refs are counted, not thrown", async () => {
    // path-traversal ref → classifier returns 'failed' → counted, not thrown.
    stubFetch(async () => new Response("", { status: 500 }))
    const result = await localizeMarkdownImages(
      makeOpts({ markdown: "![](../../../../etc/passwd)" }),
    )
    expect(result.stats.failed).toBe(1)
    expect(mockWriteFileBase64).not.toHaveBeenCalled()
  })

  it("body-side fetch throw → counted as failed, batch continues to next ref", async () => {
    mockFileExists.mockResolvedValue(false)
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
    let call = 0
    stubFetch(async () => {
      call += 1
      if (call === 1) throw new Error("network flake")
      return new Response(png, {
        status: 200,
        headers: { "content-type": "image/png" },
      })
    })
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {})
    const result = await localizeMarkdownImages(
      makeOpts({
        markdown: [
          "![](https://example.com/first.png)",
          "![](https://example.com/second.png)",
        ].join("\n"),
      }),
    )
    spy.mockRestore()
    expect(result.stats.failed).toBe(1)
    expect(result.stats.downloaded).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Group F/Integration — body rewrite (§4, §7) — Commit 4a
// ---------------------------------------------------------------------------

describe("pathFormFor — canonical → target-directory-relative (§4)", () => {
  it("source form uses ../../wiki/media/ prefix", () => {
    expect(
      pathFormFor("wiki/media/notes/foo-abc12345.png", "source"),
    ).toBe("../../wiki/media/notes/foo-abc12345.png")
  })

  it("wiki form uses ../media/ prefix (drops leading wiki/)", () => {
    expect(pathFormFor("wiki/media/notes/foo-abc12345.png", "wiki")).toBe(
      "../media/notes/foo-abc12345.png",
    )
  })

  it("passes through paths that don't match the wiki/media/ shape", () => {
    // Defensive: an absolute path (e.g. an already-localized ref that
    // slipped through) should not be silently mangled by the rewriter.
    // The main pipeline filters already-localized out anyway, but this
    // guards against future callers.
    expect(pathFormFor("/some/abs/path.png", "source")).toBe(
      "/some/abs/path.png",
    )
    expect(pathFormFor("./relative.png", "wiki")).toBe("./relative.png")
  })

  it("strips leading slashes from a canonical wiki/media path", () => {
    // Some producers accidentally hand out `/wiki/media/…` with a
    // leading slash. Match against the canonical (no-leading-slash) form.
    expect(
      pathFormFor("/wiki/media/notes/foo-abc12345.png", "source"),
    ).toBe("../../wiki/media/notes/foo-abc12345.png")
  })
})

describe("formatImageAlt — §7 escape (test 29)", () => {
  it("passes plain text through unchanged", () => {
    expect(formatImageAlt("Ferris the crab")).toBe("Ferris the crab")
  })

  it("escapes unescaped ] characters", () => {
    expect(formatImageAlt("citation [1] here")).toBe("citation [1\\] here")
  })

  it("preserves already-escaped \\] in input", () => {
    // Author (or an upstream tool) already wrote `\]` — we must NOT
    // double-escape into `\\]`.
    expect(formatImageAlt("cite [42\\] end")).toBe("cite [42\\] end")
  })

  it("escapes balanced brackets [foo] into \\[foo\\] round-trip", () => {
    // Only the `]` gets escaped; `[` is opaque in alt context per
    // §7 rules. But CommonMark round-trip still recovers it.
    expect(formatImageAlt("[foo]")).toBe("[foo\\]")
  })

  it("collapses newlines and tabs to single spaces", () => {
    expect(formatImageAlt("line one\nline two")).toBe("line one line two")
    expect(formatImageAlt("tab\there")).toBe("tab here")
    expect(formatImageAlt("multi\n\n\nspace")).toBe("multi space")
  })

  it("strips zero-width chars", () => {
    // U+200B (ZWSP), U+FEFF (BOM), U+200D (ZWJ)
    expect(formatImageAlt("in\u200Bvis\uFEFFib\u200Dle")).toBe("invisible")
  })

  it("returns empty string for empty input (author's empty alt preserved)", () => {
    expect(formatImageAlt("")).toBe("")
  })

  it("handles the combined case from plan §7 (test 29)", () => {
    // Input: VLM returns alt with `]`, `\n`, U+200B, and `[foo]`.
    const raw = "Chart [1]\nrevision\u200B [foo]"
    expect(formatImageAlt(raw)).toBe("Chart [1\\] revision [foo\\]")
  })
})

describe("formatImageTitle — §7 sanitize (test 28)", () => {
  it("substitutes \" with \\u201D (right double curly quote)", () => {
    expect(formatImageTitle('a "quoted" phrase')).toBe(
      "a \u201Dquoted\u201D phrase",
    )
  })

  it("leaves backslashes alone (asymmetric with alt escape)", () => {
    expect(formatImageTitle("path\\to\\file")).toBe("path\\to\\file")
  })

  it("collapses newlines to spaces", () => {
    expect(formatImageTitle("multi\nline\ntitle")).toBe("multi line title")
  })

  it("returns empty string for empty input", () => {
    expect(formatImageTitle("")).toBe("")
  })

  it("strips zero-width chars", () => {
    expect(formatImageTitle("in\u200Bvis\uFEFFible")).toBe("invisible")
  })
})

describe("rewriteBySlot — reverse-offset patching", () => {
  it("returns markdown unchanged when slots array is empty", () => {
    expect(rewriteBySlot("hello", [], "source")).toBe("hello")
  })

  it("rewrites a single slot with no title (source form)", () => {
    const md = "before ![orig alt](https://x.example/foo.png) after"
    const slots: RewriteSlot[] = [
      {
        offset: md.indexOf("!["),
        length: "![orig alt](https://x.example/foo.png)".length,
        canonicalRelPath: "wiki/media/notes/foo-abc12345.png",
        alt: "orig alt",
        title: undefined,
      },
    ]
    expect(rewriteBySlot(md, slots, "source")).toBe(
      "before ![orig alt](../../wiki/media/notes/foo-abc12345.png) after",
    )
  })

  it("rewrites a single slot with title (wiki form + curly-quote sanitize)", () => {
    const md = 'x ![alt](https://x.example/f.png "the \\"weird\\" one") y'
    const orig = '![alt](https://x.example/f.png "the \\"weird\\" one")'
    const slots: RewriteSlot[] = [
      {
        offset: md.indexOf("!["),
        length: orig.length,
        canonicalRelPath: "wiki/media/notes/f-abc12345.png",
        alt: "alt",
        title: 'the "weird" one',
      },
    ]
    const out = rewriteBySlot(md, slots, "wiki")
    expect(out).toContain("![alt](../media/notes/f-abc12345.png ")
    expect(out).toContain('"the \u201Dweird\u201D one"')
  })

  it("patches multiple slots in reverse order without offset drift", () => {
    // Two refs; the second one's offset would shift if we patched
    // left-to-right. Reverse-order patching keeps both offsets valid.
    const md = "A ![a](https://x.example/a.png) B ![b](https://x.example/b.png) C"
    const refs = findImageReferencesWithTitle(md)
    expect(refs).toHaveLength(2)
    const slots: RewriteSlot[] = refs.map((r, i) => ({
      offset: r.offset,
      length: r.length,
      canonicalRelPath: `wiki/media/notes/img${i}-abcdef${i}${i}.png`,
      alt: r.alt,
      title: r.title,
    }))
    const out = rewriteBySlot(md, slots, "source")
    // Both replacements landed and text between is preserved.
    expect(out).toBe(
      "A ![a](../../wiki/media/notes/img0-abcdef00.png) B ![b](../../wiki/media/notes/img1-abcdef11.png) C",
    )
  })

  it("accepts slots in any input order (defensive sort)", () => {
    const md = "A ![a](http://x/a.png) B ![b](http://x/b.png) C"
    const refs = findImageReferencesWithTitle(md)
    const slots: RewriteSlot[] = [
      {
        offset: refs[1].offset,
        length: refs[1].length,
        canonicalRelPath: "wiki/media/notes/b-11111111.png",
        alt: "b",
        title: undefined,
      },
      {
        offset: refs[0].offset,
        length: refs[0].length,
        canonicalRelPath: "wiki/media/notes/a-00000000.png",
        alt: "a",
        title: undefined,
      },
    ]
    const out = rewriteBySlot(md, slots, "wiki")
    expect(out).toBe(
      "A ![a](../media/notes/a-00000000.png) B ![b](../media/notes/b-11111111.png) C",
    )
  })

  it("applies alt escape and title sanitize when rewriting", () => {
    const md = 'x ![cite [1]](http://x/f.png "old \\"title\\"") y'
    const orig = '![cite [1]](http://x/f.png "old \\"title\\"")'
    const slots: RewriteSlot[] = [
      {
        offset: md.indexOf("!["),
        length: orig.length,
        canonicalRelPath: "wiki/media/notes/f-deadbeef.png",
        alt: "cite [1]",
        title: 'old "title"',
      },
    ]
    const out = rewriteBySlot(md, slots, "source")
    expect(out).toContain("![cite [1\\]](../../wiki/media/notes/f-deadbeef.png")
    expect(out).toContain('"old \u201Dtitle\u201D"')
  })
})

// ---------------------------------------------------------------------------
// Group F integration tests 31–34 — two-form output at the pipeline level
// ---------------------------------------------------------------------------

describe("localizeMarkdownImages — two-form body output (tests 31-34)", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  /** Stub a URL-cache hit for one URL so we don't need a live fetch. */
  function stubCacheHit(url: string, entry: UrlCacheEntry) {
    mockFileExists.mockImplementation(async (p: string) => {
      if (p.endsWith("image-url-cache.json")) return true
      if (p.endsWith(entry.canonicalRelPath.replace(/^.*\//, ""))) return true
      return false
    })
    mockReadFile.mockResolvedValue(JSON.stringify({ [url]: entry }))
    stubFetch(async () => new Response("", { status: 500 }))
  }

  it("test 31/32 — source-form and wiki-form outputs use correct path shapes", async () => {
    const url = "https://example.com/logo.png"
    stubCacheHit(url, {
      sha256: "aa".repeat(32),
      mimeType: "image/png",
      width: 0,
      height: 0,
      bytesLen: 500,
      fetchedAt: new Date().toISOString(),
      canonicalRelPath: "wiki/media/notes/logo-aabbccdd.png",
    })

    const result = await localizeMarkdownImages(
      makeOpts({ markdown: `See: ![The logo](${url})` }),
    )

    // Test 31: raw/sources path form
    expect(result.rewrittenSourceMarkdown).toBe(
      "See: ![The logo](../../wiki/media/notes/logo-aabbccdd.png)",
    )
    // Test 32: wiki/sources path form
    expect(result.rewrittenWikiMarkdown).toBe(
      "See: ![The logo](../media/notes/logo-aabbccdd.png)",
    )
  })

  it("test 34 — both forms share alt/title text; only URL differs", async () => {
    const url = "https://example.com/hero.png"
    stubCacheHit(url, {
      sha256: "bb".repeat(32),
      mimeType: "image/png",
      width: 0,
      height: 0,
      bytesLen: 800,
      fetchedAt: new Date().toISOString(),
      canonicalRelPath: "wiki/media/notes/hero-11223344.png",
    })

    const result = await localizeMarkdownImages(
      makeOpts({
        markdown: `![Author's alt text](${url} "hover title")`,
      }),
    )

    // Both forms preserve author alt verbatim (Commit 4a takes ref.alt as-is)
    // and both share the same title.
    expect(result.rewrittenSourceMarkdown).toContain("![Author's alt text]")
    expect(result.rewrittenWikiMarkdown).toContain("![Author's alt text]")
    expect(result.rewrittenSourceMarkdown).toContain('"hover title"')
    expect(result.rewrittenWikiMarkdown).toContain('"hover title"')

    // Only the URL segment differs between the two.
    expect(result.rewrittenSourceMarkdown).toContain(
      "../../wiki/media/notes/hero-11223344.png",
    )
    expect(result.rewrittenWikiMarkdown).toContain(
      "../media/notes/hero-11223344.png",
    )
    expect(result.rewrittenSourceMarkdown).not.toContain("../media/")
    // Note: rewrittenWikiMarkdown *does* contain the substring "../media/"
    // literally; assert it does NOT contain the source-form prefix.
    expect(result.rewrittenWikiMarkdown).not.toContain("../../wiki/media/")
  })

  it("empty markdown (no image refs) returns input verbatim in both fields", async () => {
    const result = await localizeMarkdownImages(
      makeOpts({ markdown: "# just prose, no images" }),
    )
    expect(result.rewrittenSourceMarkdown).toBe("# just prose, no images")
    expect(result.rewrittenWikiMarkdown).toBe("# just prose, no images")
  })

  it("already-localized ref is left untouched in both output forms", async () => {
    // Author-authored `../../wiki/media/…` reference; localizer's §5
    // classifier says already-localized → do not touch.
    mockFileExists.mockImplementation(async (p: string) => {
      // The classifier resolves against sourceDir (/project/raw/sources)
      // to `/project/wiki/media/notes/keep-cafebabe.png`. Existence gate.
      if (p.endsWith("keep-cafebabe.png")) return true
      return false
    })
    mockReadFile.mockResolvedValue("{}")

    const md = "keep this: ![](../../wiki/media/notes/keep-cafebabe.png) done"
    const result = await localizeMarkdownImages(makeOpts({ markdown: md }))

    // Contract: already-localized refs must round-trip verbatim in the
    // source form (that's the form the author wrote). Wiki form gets
    // the same author-authored string — Commit 5's `injectImagesIntoSourceSummary`
    // may re-emit these differently; here we assert non-mutation.
    expect(result.rewrittenSourceMarkdown).toBe(md)
    expect(result.rewrittenWikiMarkdown).toBe(md)
    expect(result.stats.alreadyLocalized).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Commit 4b — VLM decision matrix (§1) + provider gate + threshold + DI
// ---------------------------------------------------------------------------
//
// Tests 3-10 sweep the 8-cell v3 decision matrix:
//   Axis A (URL kind): remote / data-uri / local / already-localized  (rows)
//   Axis B (author alt): empty vs non-empty  (columns)
// The matrix reduces to a small set of outcomes:
//   - alt empty + captionable + provider open + over threshold → VLM
//   - alt empty + under threshold                              → skippedTooSmall
//   - alt empty + codex-cli provider                           → skippedNoVlmProvider
//   - alt non-empty (any URL kind)                             → skippedAuthorAlt
//   - already-localized                                        → neither counter
// Tests 24 (concurrency), 27 (failure isolation), 30 (provider gate) round out
// the group. Additional tests cover caption-cache reuse and the sha256/probe
// wiring — the mechanisms the decision matrix rides on.

describe("localizeMarkdownImages — Commit 4b VLM decision matrix (§1)", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const remoteUrl = "https://example.com/chart.png"
  const dataUri =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="

  /**
   * Common mock scaffold for VLM tests: URL cache absent, no on-disk
   * canonical files, `readFile` returns empty JSON for both URL and
   * caption caches.
   */
  function scaffoldEmptyCaches() {
    mockFileExists.mockImplementation(async (p: string) => {
      // No cache files, no pre-existing media files.
      if (p.endsWith("image-url-cache.json")) return false
      if (p.endsWith("image-caption-cache.json")) return false
      return false
    })
    mockReadFile.mockResolvedValue("{}")
  }

  it("test 3 — remote + empty alt + provider open + over threshold → VLM called, finalAlt from caption", async () => {
    scaffoldEmptyCaches()
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    stubFetch(async () =>
      new Response(png, {
        status: 200,
        headers: { "content-type": "image/png" },
      }),
    )
    mockCaptionImage.mockResolvedValue("A tidy line chart")

    const result = await localizeMarkdownImages(
      makeOpts({
        markdown: `![](${remoteUrl})`,
        // Force over-threshold: probe returns > minPixel (64) on both axes.
        probeImageDimensions: async () => ({ width: 800, height: 600 }),
      }),
    )

    expect(mockCaptionImage).toHaveBeenCalledTimes(1)
    expect(result.stats.captioned).toBe(1)
    expect(result.stats.skippedAuthorAlt).toBe(0)
    expect(result.stats.skippedTooSmall).toBe(0)
    expect(result.stats.skippedNoVlmProvider).toBe(0)
    // finalAlt threaded into rewritten body.
    expect(result.rewrittenSourceMarkdown).toContain("![A tidy line chart](")
    // Phase 3 metadata embedding ran on the captioned image: the file is
    // read back (readFileAsBase64) and rewritten with XMP/PNG-text bytes.
    // writeFileBase64 is called twice — initial save + embed write-back.
    expect(result.stats.metadataEmbedded).toBe(1)
    expect(result.stats.metadataSkipped).toBe(0)
    expect(mockReadFileAsBase64).toHaveBeenCalledTimes(1)
    expect(mockWriteFileBase64).toHaveBeenCalledTimes(2)
  })

  it("test 4 — remote + NON-empty alt → skippedAuthorAlt, no VLM call", async () => {
    scaffoldEmptyCaches()
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
    stubFetch(async () =>
      new Response(png, {
        status: 200,
        headers: { "content-type": "image/png" },
      }),
    )

    const result = await localizeMarkdownImages(
      makeOpts({
        markdown: `![Author wrote this](${remoteUrl})`,
      }),
    )

    expect(mockCaptionImage).not.toHaveBeenCalled()
    expect(result.stats.captioned).toBe(0)
    expect(result.stats.skippedAuthorAlt).toBe(1)
    // Author alt survives verbatim into both forms.
    expect(result.rewrittenSourceMarkdown).toContain("![Author wrote this](")
    expect(result.rewrittenWikiMarkdown).toContain("![Author wrote this](")
  })

  it("test 5 — data-uri + empty alt + over threshold → VLM called on decoded bytes", async () => {
    scaffoldEmptyCaches()
    mockCaptionImage.mockResolvedValue("Inline diagram")

    const result = await localizeMarkdownImages(
      makeOpts({
        markdown: `![](${dataUri})`,
        probeImageDimensions: async () => ({ width: 200, height: 200 }),
      }),
    )

    expect(mockCaptionImage).toHaveBeenCalledTimes(1)
    // Confirm base64 + mime were passed through to captionImage.
    const [passedB64, passedMime] = mockCaptionImage.mock.calls[0]
    expect(passedMime).toBe("image/png")
    expect(typeof passedB64).toBe("string")
    expect(passedB64.length).toBeGreaterThan(0)
    expect(result.stats.captioned).toBe(1)
    expect(result.rewrittenSourceMarkdown).toContain("![Inline diagram](")
  })

  it("test 6 — data-uri + NON-empty alt → skippedAuthorAlt", async () => {
    scaffoldEmptyCaches()
    const result = await localizeMarkdownImages(
      makeOpts({
        markdown: `![Hand-written label](${dataUri})`,
      }),
    )
    expect(mockCaptionImage).not.toHaveBeenCalled()
    expect(result.stats.skippedAuthorAlt).toBe(1)
    expect(result.stats.captioned).toBe(0)
    expect(result.rewrittenSourceMarkdown).toContain("![Hand-written label](")
  })

  it("test 7 — remote + empty alt + BELOW threshold → skippedTooSmall, no VLM", async () => {
    scaffoldEmptyCaches()
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
    stubFetch(async () =>
      new Response(png, {
        status: 200,
        headers: { "content-type": "image/png" },
      }),
    )

    const result = await localizeMarkdownImages(
      makeOpts({
        markdown: `![](${remoteUrl})`,
        probeImageDimensions: async () => ({ width: 8, height: 8 }),
      }),
    )
    expect(mockCaptionImage).not.toHaveBeenCalled()
    expect(result.stats.captioned).toBe(0)
    expect(result.stats.skippedTooSmall).toBe(1)
    // Empty alt preserved.
    expect(result.rewrittenSourceMarkdown).toMatch(/!\[\]\(/)
  })

  it("test 8 — probe returns unknown dims (0,0) → treated as over threshold (§2 note)", async () => {
    scaffoldEmptyCaches()
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
    stubFetch(async () =>
      new Response(png, {
        status: 200,
        headers: { "content-type": "image/png" },
      }),
    )
    mockCaptionImage.mockResolvedValue("Fallback caption")

    const result = await localizeMarkdownImages(
      makeOpts({
        markdown: `![](${remoteUrl})`,
        // Default `makeOpts` probe returns (0,0). Explicit here for clarity.
        probeImageDimensions: async () => ({ width: 0, height: 0 }),
      }),
    )
    expect(mockCaptionImage).toHaveBeenCalledTimes(1)
    expect(result.stats.captioned).toBe(1)
    expect(result.stats.skippedTooSmall).toBe(0)
  })

  it("test 9 — whitespace-only alt counts as empty (§1)", async () => {
    scaffoldEmptyCaches()
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
    stubFetch(async () =>
      new Response(png, {
        status: 200,
        headers: { "content-type": "image/png" },
      }),
    )
    mockCaptionImage.mockResolvedValue("Ws chart")

    const result = await localizeMarkdownImages(
      makeOpts({
        // Author wrote `![   ](url)` — treated as empty per §1.
        markdown: `![   ](${remoteUrl})`,
        probeImageDimensions: async () => ({ width: 400, height: 300 }),
      }),
    )
    expect(mockCaptionImage).toHaveBeenCalledTimes(1)
    expect(result.stats.captioned).toBe(1)
    expect(result.stats.skippedAuthorAlt).toBe(0)
  })

  it("test 10 — single-word non-empty alt ('image') → skippedAuthorAlt (not overwritten)", async () => {
    scaffoldEmptyCaches()
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
    stubFetch(async () =>
      new Response(png, {
        status: 200,
        headers: { "content-type": "image/png" },
      }),
    )
    const result = await localizeMarkdownImages(
      makeOpts({
        markdown: `![image](${remoteUrl})`,
      }),
    )
    expect(mockCaptionImage).not.toHaveBeenCalled()
    expect(result.stats.skippedAuthorAlt).toBe(1)
    expect(result.rewrittenSourceMarkdown).toContain("![image](")
  })

  it("test 30 — codex-cli provider → all empty-alt images route to skippedNoVlmProvider; I/O still runs", async () => {
    scaffoldEmptyCaches()
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
    let fetches = 0
    stubFetch(async () => {
      fetches += 1
      return new Response(png, {
        status: 200,
        headers: { "content-type": "image/png" },
      })
    })

    // Fixture: 2 empty-alt + 1 non-empty-alt.
    const md = [
      `![](https://example.com/a.png)`,
      `![](https://example.com/b.png)`,
      `![Author](https://example.com/c.png)`,
    ].join("\n\n")

    const result = await localizeMarkdownImages(
      makeOpts({
        markdown: md,
        llmConfig: {
          provider: "codex-cli",
          model: "gpt-4o-mini",
        } as unknown as LocalizeOptions["llmConfig"],
      }),
    )

    // Provider gate is upfront: VLM never invoked.
    expect(mockCaptionImage).not.toHaveBeenCalled()
    expect(result.stats.captioned).toBe(0)
    expect(result.stats.failed).toBe(0)
    // The two skip counters partition the "no VLM call" set.
    expect(result.stats.skippedNoVlmProvider).toBe(2)
    expect(result.stats.skippedAuthorAlt).toBe(1)
    expect(result.stats.skippedTooSmall).toBe(0)
    // I/O still ran for all 3.
    expect(fetches).toBe(3)
    expect(result.stats.downloaded).toBe(3)
    // Empty alts stay byte-identical (empty), non-empty stays verbatim.
    const src = result.rewrittenSourceMarkdown
    expect(src).toMatch(/!\[\]\(\.\.\/\.\.\/wiki\/media\/notes\/a-[0-9a-f]{8}\.png\)/)
    expect(src).toMatch(/!\[\]\(\.\.\/\.\.\/wiki\/media\/notes\/b-[0-9a-f]{8}\.png\)/)
    expect(src).toContain("![Author](")
  })

  it("caption cache HIT — same image content across two refs, VLM called once", async () => {
    // Both refs have the same sha256 → cache hit for the 2nd (in memory).
    // We simulate a pre-existing on-disk cache too, so VLM is called ZERO
    // times: both refs consume the cache.
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    // Precompute sha256 of these exact bytes for the pre-seeded cache.
    // We just seed with a wildcard — the important part is that the
    // caption cache file exists and, on the 1st image's SHA, contains
    // a caption. Since we can't easily precompute the sha here without
    // duplicating the impl, we instead assert on the FRESH path with
    // an in-memory reuse: two references to the same URL → 1 VLM call.
    mockFileExists.mockImplementation(async (p: string) => {
      if (p.endsWith("image-url-cache.json")) return false
      if (p.endsWith("image-caption-cache.json")) return false
      return false
    })
    mockReadFile.mockResolvedValue("{}")

    stubFetch(async () =>
      new Response(png, {
        status: 200,
        headers: { "content-type": "image/png" },
      }),
    )
    mockCaptionImage.mockResolvedValue("Shared caption")

    const url = "https://example.com/shared.png"
    const md = `![](${url})\n\n![](${url})`

    const result = await localizeMarkdownImages(
      makeOpts({
        markdown: md,
        probeImageDimensions: async () => ({ width: 400, height: 300 }),
      }),
    )

    // First occurrence: VLM. Second occurrence (same sha256): cache hit.
    expect(mockCaptionImage).toHaveBeenCalledTimes(1)
    expect(result.stats.captioned).toBe(1)
    expect(result.stats.captionCacheHits).toBe(1)
    // Both refs get the caption in the rewrite.
    const matches = result.rewrittenSourceMarkdown.match(
      /!\[Shared caption\]\(/g,
    )
    expect(matches).not.toBeNull()
    expect(matches!.length).toBe(2)
  })

  it("caption cache WRITE — successful VLM call persists to .llm-wiki/image-caption-cache.json", async () => {
    scaffoldEmptyCaches()
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
    stubFetch(async () =>
      new Response(png, {
        status: 200,
        headers: { "content-type": "image/png" },
      }),
    )
    mockCaptionImage.mockResolvedValue("Persisted caption")

    await localizeMarkdownImages(
      makeOpts({
        markdown: `![](${remoteUrl})`,
        probeImageDimensions: async () => ({ width: 200, height: 200 }),
      }),
    )

    // A writeFile targeting the caption cache path must have happened.
    const captionWrites = mockWriteFile.mock.calls.filter(([p]) =>
      String(p).endsWith("image-caption-cache.json"),
    )
    expect(captionWrites.length).toBe(1)
    const [, body] = captionWrites[0]
    const parsed = JSON.parse(String(body)) as Record<
      string,
      { caption: string; mimeType: string; model: string }
    >
    const entries = Object.values(parsed)
    expect(entries.length).toBe(1)
    expect(entries[0].caption).toBe("Persisted caption")
    expect(entries[0].mimeType).toBe("image/png")
    expect(entries[0].model).toBe("test-model")
  })

  it("caption FAILURE — VLM error isolated; alt stays empty, batch continues", async () => {
    scaffoldEmptyCaches()
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
    stubFetch(async () =>
      new Response(png, {
        status: 200,
        headers: { "content-type": "image/png" },
      }),
    )
    mockCaptionImage.mockRejectedValue(new Error("model boom"))

    const result = await localizeMarkdownImages(
      makeOpts({
        markdown: `![](${remoteUrl})`,
        probeImageDimensions: async () => ({ width: 200, height: 200 }),
      }),
    )
    // I/O succeeded, VLM failed — NOT counted as `failed` (that field is
    // reserved for I/O failures). No cache write.
    expect(result.stats.downloaded).toBe(1)
    expect(result.stats.failed).toBe(0)
    expect(result.stats.captioned).toBe(0)
    // Empty alt survived.
    expect(result.rewrittenSourceMarkdown).toMatch(/!\[\]\(/)
    // No caption cache file written.
    const captionWrites = mockWriteFile.mock.calls.filter(([p]) =>
      String(p).endsWith("image-caption-cache.json"),
    )
    expect(captionWrites.length).toBe(0)
  })

  it("test 27 — failure isolation: 1 remote 404s, other 2 empty-alt refs still VLM-captioned", async () => {
    scaffoldEmptyCaches()
    // Distinct bytes per successful URL so the 2nd doesn't hit the
    // caption cache from the 1st via sha256 collision.
    const png1 = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1])
    const png2 = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 2])
    stubFetch(async (url) => {
      if (url.includes("dead.png")) {
        return new Response("", { status: 404 })
      }
      const body = url.includes("ok1") ? png1 : png2
      return new Response(body, {
        status: 200,
        headers: { "content-type": "image/png" },
      })
    })
    mockCaptionImage.mockResolvedValue("Still worked")

    const md = [
      `![](https://example.com/ok1.png)`,
      `![](https://example.com/dead.png)`,
      `![](https://example.com/ok2.png)`,
    ].join("\n\n")

    const result = await localizeMarkdownImages(
      makeOpts({
        markdown: md,
        probeImageDimensions: async () => ({ width: 300, height: 200 }),
      }),
    )

    expect(result.stats.downloaded).toBe(2)
    expect(result.stats.failed).toBe(1)
    expect(result.stats.captioned).toBe(2)
    // The dead ref stays untouched (fell out of `localized`).
    expect(result.rewrittenSourceMarkdown).toContain(
      "https://example.com/dead.png",
    )
    // The other two got captions.
    const captionMatches = result.rewrittenSourceMarkdown.match(
      /!\[Still worked\]\(/g,
    )
    expect(captionMatches).not.toBeNull()
    expect(captionMatches!.length).toBe(2)
  })

  it("test 24 — concurrency limit: with concurrency=2 and 6 refs, at most 2 in-flight fetches", async () => {
    scaffoldEmptyCaches()
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
    let inflight = 0
    let peak = 0
    stubFetch(async () => {
      inflight += 1
      peak = Math.max(peak, inflight)
      // Force scheduler yields so concurrent slots overlap.
      await new Promise((r) => setTimeout(r, 5))
      inflight -= 1
      return new Response(png, {
        status: 200,
        headers: { "content-type": "image/png" },
      })
    })

    const md = Array.from(
      { length: 6 },
      (_, i) => `![](https://example.com/img${i}.png)`,
    ).join("\n\n")

    const result = await localizeMarkdownImages(
      makeOpts({
        markdown: md,
        // Author alt non-empty on nothing; but VLM would inflate the
        // timeline. Force skippedTooSmall so we only measure fetch
        // concurrency.
        probeImageDimensions: async () => ({ width: 8, height: 8 }),
        multimodalConfig: {
          concurrency: 2,
          model: "test-model",
          minImagePixelSize: 64,
          imageFetchTimeoutMs: 5_000,
          urlCacheTtlDays: 45,
          localizeMarkdownImages: true,
        } as unknown as LocalizeOptions["multimodalConfig"],
      }),
    )

    expect(result.stats.downloaded).toBe(6)
    expect(mockCaptionImage).not.toHaveBeenCalled()
    expect(peak).toBeLessThanOrEqual(2)
    expect(peak).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// Commit 4c — mergeImageSourcesFrontmatter (§11)
// ---------------------------------------------------------------------------

describe("mergeImageSourcesFrontmatter — §11 lifecycle", () => {
  it("test 11 — populates image_sources with remote URL entries in body-only content", () => {
    const content = "# My notes\n\nHello world.\n"
    const entries: FrontmatterImageEntry[] = [
      {
        localPath: "wiki/media/notes/logo-abc12345.png",
        source: "https://example.com/logo.png",
      },
      {
        localPath: "wiki/media/notes/hero-def67890.jpg",
        source: "https://example.com/hero.jpg",
      },
    ]
    const out = mergeImageSourcesFrontmatter(content, entries)
    expect(out).toMatch(/^---\n/)
    expect(out).toContain("image_sources:")
    expect(out).toContain(
      '"wiki/media/notes/logo-abc12345.png": "https://example.com/logo.png"',
    )
    expect(out).toContain(
      '"wiki/media/notes/hero-def67890.jpg": "https://example.com/hero.jpg"',
    )
    expect(out).toContain("# My notes")
    expect(out).toContain("Hello world.")
  })

  it("test 11b — includes truncated data-uri entries alongside remote entries", () => {
    const content = "# Notes\n\n"
    const longDataUri =
      "data:image/png;base64," + "iVBORw0KGgoAAAANSUhEUgAA".repeat(50)
    const truncated = truncateDataUriForFrontmatter(longDataUri)
    // Sanity: truncateDataUriForFrontmatter enforces §11's 64-char cap.
    expect(truncated.length).toBeLessThanOrEqual(65)
    expect(truncated.endsWith("…")).toBe(true)

    const entries: FrontmatterImageEntry[] = [
      {
        localPath: "wiki/media/notes/remote-11112222.png",
        source: "https://example.com/remote.png",
      },
      {
        localPath: "wiki/media/notes/inline-33334444.png",
        source: truncated,
      },
    ]
    const out = mergeImageSourcesFrontmatter(content, entries)
    expect(out).toContain(
      '"wiki/media/notes/remote-11112222.png": "https://example.com/remote.png"',
    )
    // The truncated data URI must appear verbatim as the mapping value.
    expect(out).toContain(`"wiki/media/notes/inline-33334444.png": "${truncated}"`)
  })

  it("test 12 — re-run drops entries whose local path no longer appears", () => {
    // Simulate: previous run left 2 localizer entries; this re-run only
    // produces 1 (user deleted the 2nd ref from the body between runs).
    const priorContent = [
      "---",
      "title: Notes",
      "image_sources:",
      '  "wiki/media/notes/keep-aaaaaaaa.png": "https://example.com/keep.png"',
      '  "wiki/media/notes/drop-bbbbbbbb.png": "https://example.com/drop.png"',
      "---",
      "",
      "# Body",
      "",
    ].join("\n")

    const entries: FrontmatterImageEntry[] = [
      {
        localPath: "wiki/media/notes/keep-aaaaaaaa.png",
        source: "https://example.com/keep.png",
      },
    ]
    const out = mergeImageSourcesFrontmatter(priorContent, entries)
    expect(out).toContain(
      '"wiki/media/notes/keep-aaaaaaaa.png": "https://example.com/keep.png"',
    )
    // The dropped entry must be gone.
    expect(out).not.toContain("drop-bbbbbbbb.png")
    expect(out).not.toContain("https://example.com/drop.png")
    // Other frontmatter keys survive verbatim.
    expect(out).toContain("title: Notes")
    // Body untouched.
    expect(out).toContain("# Body")
  })

  it("test 13a — foreign entries preserved verbatim across rewrite", () => {
    // User pre-authored a non-`wiki/media/` entry — foreign per §11.5.
    const priorContent = [
      "---",
      "title: Foreign example",
      "image_sources:",
      '  "assets/user-drawing.png": "https://user-source.example/x.png"',
      "---",
      "# body",
      "",
    ].join("\n")

    const entries: FrontmatterImageEntry[] = [
      {
        localPath: "wiki/media/notes/localizer-ccccdddd.png",
        source: "https://example.com/localizer.png",
      },
    ]
    const out = mergeImageSourcesFrontmatter(priorContent, entries)
    // Foreign entry byte-preserved.
    expect(out).toContain(
      '"assets/user-drawing.png": "https://user-source.example/x.png"',
    )
    // Localizer entry appears after foreign entries.
    expect(out).toContain(
      '"wiki/media/notes/localizer-ccccdddd.png": "https://example.com/localizer.png"',
    )
    // Foreign entry appears BEFORE localizer entry (§11.6 emit order).
    const foreignIdx = out.indexOf("assets/user-drawing.png")
    const ownedIdx = out.indexOf("localizer-ccccdddd.png")
    expect(foreignIdx).toBeGreaterThan(-1)
    expect(ownedIdx).toBeGreaterThan(foreignIdx)
    // Non-image_sources frontmatter untouched.
    expect(out).toContain("title: Foreign example")
    expect(out).toContain("# body")
  })

  it("test 13b — user pre-wrote a wiki/media/ key colliding with localizer → OVERWRITTEN", () => {
    // Per §11.5: keys under `wiki/media/` are RESERVED. If a user
    // manually writes one, the localizer overwrites it on next run.
    // Note the key must match the localizer-owned regex — trailing
    // `-<sha8>.<ext>` — otherwise it counts as foreign (see 13c).
    const priorContent = [
      "---",
      "image_sources:",
      '  "wiki/media/notes/logo-abc12345.png": "https://user.example/old.png"',
      "---",
      "",
    ].join("\n")

    const entries: FrontmatterImageEntry[] = [
      {
        localPath: "wiki/media/notes/logo-abc12345.png",
        source: "https://example.com/new.png",
      },
    ]
    const out = mergeImageSourcesFrontmatter(priorContent, entries)
    // Localizer's value replaces the user's.
    expect(out).toContain(
      '"wiki/media/notes/logo-abc12345.png": "https://example.com/new.png"',
    )
    // The old URL is gone (only the new one remains under that key).
    expect(out).not.toContain("https://user.example/old.png")
  })

  it("test 13c — pre-existing wiki/media/ key WITHOUT the -<sha8>.<ext> discriminator stays foreign", () => {
    // Cross-subsystem prefix per §11.5: `wiki/media/<slug>/mineru/foo.png`
    // has no `-<sha8>.<ext>` suffix on its last segment. LOCALIZER_KEY_RE
    // rejects it → treated as foreign → survives.
    const priorContent = [
      "---",
      "image_sources:",
      '  "wiki/media/notes/mineru/page-01.png": "https://mineru.example/p01.png"',
      "---",
      "",
    ].join("\n")

    const out = mergeImageSourcesFrontmatter(priorContent, [
      {
        localPath: "wiki/media/notes/actual-abcd1234.png",
        source: "https://example.com/actual.png",
      },
    ])
    expect(out).toContain(
      '"wiki/media/notes/mineru/page-01.png": "https://mineru.example/p01.png"',
    )
    expect(out).toContain(
      '"wiki/media/notes/actual-abcd1234.png": "https://example.com/actual.png"',
    )
  })

  it("empty entries + no existing block → content unchanged", () => {
    const content = "# just prose, no images\n"
    const out = mergeImageSourcesFrontmatter(content, [])
    expect(out).toBe(content)
  })

  it("empty entries + no foreign entries but existing localizer block → block dropped", () => {
    const priorContent = [
      "---",
      "title: Cleanup",
      "image_sources:",
      '  "wiki/media/notes/stale-ffffffff.png": "https://example.com/stale.png"',
      "---",
      "",
      "# body",
      "",
    ].join("\n")

    const out = mergeImageSourcesFrontmatter(priorContent, [])
    // Block gone entirely.
    expect(out).not.toContain("image_sources:")
    expect(out).not.toContain("stale-ffffffff.png")
    // Other frontmatter preserved.
    expect(out).toContain("title: Cleanup")
    expect(out).toContain("# body")
  })

  it("duplicate localPath in entries → later wins (dedup by key)", () => {
    const content = "# Notes\n"
    const entries: FrontmatterImageEntry[] = [
      {
        localPath: "wiki/media/notes/dup-12345678.png",
        source: "https://example.com/first.png",
      },
      {
        localPath: "wiki/media/notes/dup-12345678.png",
        source: "https://example.com/second.png",
      },
    ]
    const out = mergeImageSourcesFrontmatter(content, entries)
    // Only one entry, and it's the second URL.
    expect(out).toContain('"wiki/media/notes/dup-12345678.png": "https://example.com/second.png"')
    expect(out).not.toContain("first.png")
    // Just one line for this key.
    const matches = out.match(/wiki\/media\/notes\/dup-12345678\.png/g)
    expect(matches).not.toBeNull()
    expect(matches!.length).toBe(1)
  })

  it("preserves non-image_sources keys verbatim (round-trip)", () => {
    const priorContent = [
      "---",
      "title: Round Trip",
      "tags:",
      "  - alpha",
      "  - beta",
      "custom_field: 42",
      "---",
      "",
      "Body text here.",
      "",
    ].join("\n")

    const out = mergeImageSourcesFrontmatter(priorContent, [
      {
        localPath: "wiki/media/notes/x-11223344.png",
        source: "https://example.com/x.png",
      },
    ])
    expect(out).toContain("title: Round Trip")
    expect(out).toContain("tags:")
    expect(out).toContain("  - alpha")
    expect(out).toContain("  - beta")
    expect(out).toContain("custom_field: 42")
    expect(out).toContain("image_sources:")
    expect(out).toContain(
      '"wiki/media/notes/x-11223344.png": "https://example.com/x.png"',
    )
    expect(out).toContain("Body text here.")
  })

  it("value with embedded double quote is escaped for YAML safety", () => {
    // Defensive: escape `"` in values so we don't break the block.
    const out = mergeImageSourcesFrontmatter("# body\n", [
      {
        localPath: 'wiki/media/notes/weird-99887766.png',
        source: 'https://example.com/x?q="hello"',
      },
    ])
    // `\"` (backslash-escaped) inside the double-quoted YAML string.
    expect(out).toContain(
      '"wiki/media/notes/weird-99887766.png": "https://example.com/x?q=\\"hello\\""',
    )
  })
})

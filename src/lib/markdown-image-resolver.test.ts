/**
 * Tests for `resolveMarkdownImageSrc`.
 *
 * Tauri's `convertFileSrc` is mocked to a deterministic identity
 * wrapper so we can assert the path that goes IN, not the actual
 * Tauri-side URL shape (which differs across platforms — `asset://`
 * on macOS, `https://asset.localhost/` on Windows, etc.).
 */
import { describe, it, expect, vi } from "vitest"

// Hoisted mock — all calls to convertFileSrc return `tauri-asset:<path>`
// so tests can assert the input path was assembled correctly without
// caring about Tauri's per-platform URL scheme.
vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string) => `tauri-asset:${path}`,
}))

import { resolveMarkdownImageSrc } from "./markdown-image-resolver"

describe("resolveMarkdownImageSrc", () => {
  const PROJECT = "/Users/me/MyWiki"

  it("passes http(s) URLs through unchanged", () => {
    expect(resolveMarkdownImageSrc("https://example.com/img.png", PROJECT)).toBe(
      "https://example.com/img.png",
    )
    expect(resolveMarkdownImageSrc("http://insecure.test/x.png", PROJECT)).toBe(
      "http://insecure.test/x.png",
    )
  })

  it("passes data: URIs through unchanged (inline base64)", () => {
    const src = "data:image/png;base64,iVBORw0K..."
    expect(resolveMarkdownImageSrc(src, PROJECT)).toBe(src)
  })

  it("passes blob: and tauri: URIs through unchanged", () => {
    expect(resolveMarkdownImageSrc("blob:abc-123", PROJECT)).toBe("blob:abc-123")
    expect(resolveMarkdownImageSrc("tauri://asset/foo.png", PROJECT)).toBe(
      "tauri://asset/foo.png",
    )
  })

  it("treats raw/assets as project-rooted", () => {
    // This is the canonical case — ingest emits exactly this shape:
    //   ![](raw/assets/<source-slug>/img-1.png)
    expect(
      resolveMarkdownImageSrc("raw/assets/rope-paper/img-1.png", PROJECT),
    ).toBe("tauri-asset:/Users/me/MyWiki/raw/assets/rope-paper/img-1.png")
  })

  it("keeps legacy media paths rooted under <project>/wiki/", () => {
    expect(
      resolveMarkdownImageSrc("media/rope-paper/img-1.png", PROJECT),
    ).toBe("tauri-asset:/Users/me/MyWiki/wiki/media/rope-paper/img-1.png")
  })

  it("strips a leading ./ for cleanliness", () => {
    expect(
      resolveMarkdownImageSrc("./raw/assets/foo/img-2.png", PROJECT),
    ).toBe("tauri-asset:/Users/me/MyWiki/raw/assets/foo/img-2.png")
  })

  it("resolves nested paths (e.g. user-organized subfolders) under wiki/ root", () => {
    expect(
      resolveMarkdownImageSrc("entities/transformer/diagram.png", PROJECT),
    ).toBe("tauri-asset:/Users/me/MyWiki/wiki/entities/transformer/diagram.png")
  })

  it("treats an absolute POSIX path as a literal filesystem path", () => {
    // Some user content may legitimately reference an image outside
    // the wiki root (a system-wide asset, a mounted drive). Don't
    // re-anchor — just convert.
    expect(
      resolveMarkdownImageSrc("/var/data/screenshot.png", PROJECT),
    ).toBe("tauri-asset:/var/data/screenshot.png")
  })

  it("treats a Windows drive-letter path as absolute", () => {
    expect(
      resolveMarkdownImageSrc("C:/Users/me/Pictures/x.png", PROJECT),
    ).toBe("tauri-asset:C:/Users/me/Pictures/x.png")
  })

  it("treats a UNC path as absolute", () => {
    expect(
      resolveMarkdownImageSrc("\\\\share\\folder\\img.png", PROJECT),
    ).toBe("tauri-asset:\\\\share\\folder\\img.png")
  })

  it("returns the raw src unchanged when no project is loaded", () => {
    // Resolver is intentionally safe to call before a project is
    // open — preview surfaces (welcome screen, settings) might
    // render markdown without a project context.
    expect(resolveMarkdownImageSrc("media/foo/img.png", null)).toBe(
      "media/foo/img.png",
    )
  })

  it("normalizes Windows backslashes in projectPath via path-utils", () => {
    // normalizePath flips backslashes, so the assembled abs path
    // uses forward slashes regardless of OS.
    expect(
      resolveMarkdownImageSrc(
        "raw/assets/x/y.png",
        "C:\\Users\\me\\MyWiki",
      ),
    ).toBe("tauri-asset:C:/Users/me/MyWiki/raw/assets/x/y.png")
  })

  it("returns empty string verbatim for empty src", () => {
    expect(resolveMarkdownImageSrc("", PROJECT)).toBe("")
  })
})

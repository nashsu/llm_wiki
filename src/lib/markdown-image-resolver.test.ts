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

  it("treats a wiki-rooted relative path as media under <project>/wiki/", () => {
    // This is the canonical case — ingest emits exactly this shape:
    //   ![](media/<source-slug>/img-1.png)
    expect(
      resolveMarkdownImageSrc("media/rope-paper/img-1.png", PROJECT),
    ).toBe("tauri-asset:/Users/me/MyWiki/wiki/media/rope-paper/img-1.png")
  })

  it("strips a leading ./ for cleanliness", () => {
    expect(
      resolveMarkdownImageSrc("./media/foo/img-2.png", PROJECT),
    ).toBe("tauri-asset:/Users/me/MyWiki/wiki/media/foo/img-2.png")
  })

  it("resolves nested paths (e.g. user-organized subfolders) under wiki/ root", () => {
    expect(
      resolveMarkdownImageSrc("entities/transformer/diagram.png", PROJECT),
    ).toBe("tauri-asset:/Users/me/MyWiki/wiki/entities/transformer/diagram.png")
  })

  it("converts an absolute POSIX path only when it stays inside the project", () => {
    expect(
      resolveMarkdownImageSrc("/Users/me/MyWiki/raw/assets/screenshot.png", PROJECT),
    ).toBe("tauri-asset:/Users/me/MyWiki/raw/assets/screenshot.png")
  })

  it("decodes percent-encoded CJK in absolute in-project paths", () => {
    expect(
      resolveMarkdownImageSrc(
        "/Users/me/MyWiki/wiki/media/%E4%B8%AD%E6%96%87/x.png",
        PROJECT,
      ),
    ).toBe("tauri-asset:/Users/me/MyWiki/wiki/media/中文/x.png")
  })

  it("decodes percent-encoded CJK when the project path itself contains CJK", () => {
    expect(
      resolveMarkdownImageSrc(
        "/Users/me/%E6%88%91%E7%9A%84Wiki/wiki/media/x.png",
        "/Users/me/我的Wiki",
      ),
    ).toBe("tauri-asset:/Users/me/我的Wiki/wiki/media/x.png")
  })

  it("does not convert an absolute POSIX path outside the project", () => {
    expect(resolveMarkdownImageSrc("/var/data/screenshot.png", PROJECT)).toBe(
      "/var/data/screenshot.png",
    )
  })

  it("does not convert an absolute POSIX path that escapes via .. segments", () => {
    const src = "/Users/me/MyWiki/../../../etc/passwd.png"
    expect(resolveMarkdownImageSrc(src, PROJECT)).toBe(src)
  })

  it("does not treat a sibling path with the same prefix as inside the project", () => {
    const src = "/Users/me/MyWikiSecret/screenshot.png"
    expect(resolveMarkdownImageSrc(src, PROJECT)).toBe(src)
  })

  it("converts a Windows drive-letter path only when it stays inside the project", () => {
    expect(
      resolveMarkdownImageSrc(
        "C:/Users/me/MyWiki/raw/assets/x.png",
        "C:/Users/me/MyWiki",
      ),
    ).toBe("tauri-asset:C:/Users/me/MyWiki/raw/assets/x.png")
  })

  it("does not convert a Windows drive-letter path outside the project", () => {
    expect(
      resolveMarkdownImageSrc("C:/Users/me/Pictures/x.png", "C:/Users/me/MyWiki"),
    ).toBe("C:/Users/me/Pictures/x.png")
  })

  it("does not convert a UNC path outside the project", () => {
    expect(
      resolveMarkdownImageSrc("\\\\share\\folder\\img.png", PROJECT),
    ).toBe("\\\\share\\folder\\img.png")
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
        "media/x/y.png",
        "C:\\Users\\me\\MyWiki",
      ),
    ).toBe("tauri-asset:C:/Users/me/MyWiki/wiki/media/x/y.png")
  })

  it("returns empty string verbatim for empty src", () => {
    expect(resolveMarkdownImageSrc("", PROJECT)).toBe("")
  })

  describe("file-relative resolution (currentFileDir)", () => {
    it("resolves ../assets against the file's own directory (Obsidian-style)", () => {
      // A skill-exported raw source lives in raw/sources and refers
      // to ../assets/<md5>.png — must land on raw/assets, NOT
      // wiki/../assets.
      expect(
        resolveMarkdownImageSrc(
          "../assets/abc123.png",
          PROJECT,
          `${PROJECT}/raw/sources`,
        ),
      ).toBe("tauri-asset:/Users/me/MyWiki/raw/assets/abc123.png")
    })

    it("resolves ../assets/boards (whiteboard screenshots) correctly", () => {
      expect(
        resolveMarkdownImageSrc(
          "../assets/boards/WB1.jpg",
          PROJECT,
          `${PROJECT}/raw/sources`,
        ),
      ).toBe("tauri-asset:/Users/me/MyWiki/raw/assets/boards/WB1.jpg")
    })

    it("resolves a same-directory relative path against the file dir", () => {
      expect(
        resolveMarkdownImageSrc(
          "diagram.png",
          PROJECT,
          `${PROJECT}/wiki/concepts`,
        ),
      ).toBe("tauri-asset:/Users/me/MyWiki/wiki/concepts/diagram.png")
    })

    it("strips a leading ./ before joining to the file dir", () => {
      expect(
        resolveMarkdownImageSrc(
          "./img.png",
          PROJECT,
          `${PROJECT}/raw/sources`,
        ),
      ).toBe("tauri-asset:/Users/me/MyWiki/raw/sources/img.png")
    })

    it("accepts a project-relative currentFileDir and anchors it under the project", () => {
      expect(
        resolveMarkdownImageSrc("../assets/x.png", PROJECT, "raw/sources"),
      ).toBe("tauri-asset:/Users/me/MyWiki/raw/assets/x.png")
    })

    it("normalizes backslashes in currentFileDir", () => {
      expect(
        resolveMarkdownImageSrc(
          "../assets/x.png",
          "C:\\Users\\me\\MyWiki",
          "C:\\Users\\me\\MyWiki\\raw\\sources",
        ),
      ).toBe("tauri-asset:C:/Users/me/MyWiki/raw/assets/x.png")
    })

    it("does not convert a file-relative path that escapes the project", () => {
      expect(
        resolveMarkdownImageSrc("../../../../etc/x.png", PROJECT, `${PROJECT}/raw/sources`),
      ).toBe("../../../../etc/x.png")
    })

    it("does not convert paths that climb above the project root", () => {
      expect(
        resolveMarkdownImageSrc("../../../x.png", PROJECT, `${PROJECT}/wiki/concepts`),
      ).toBe("../../../x.png")
    })

    it("still uses wiki-root fallback when no currentFileDir is given", () => {
      // The canonical generated-wiki case is unchanged.
      expect(resolveMarkdownImageSrc("media/slug/img-1.png", PROJECT)).toBe(
        "tauri-asset:/Users/me/MyWiki/wiki/media/slug/img-1.png",
      )
      expect(resolveMarkdownImageSrc("../media/slug/img-1.png", PROJECT)).toBe(
        "tauri-asset:/Users/me/MyWiki/wiki/media/slug/img-1.png",
      )
    })

    it("keeps `media/` refs wiki-root-relative even WITH a currentFileDir set", () => {
      // Regression: a generated `wiki/sources/<slug>.md` page embeds
      // ingest images as `media/<slug>/img.jpg` — wiki-ROOT-relative,
      // NOT relative to wiki/sources. Passing currentFileDir must not
      // re-anchor it to wiki/sources/media/… (one level too deep,
      // which 404s and shows the alt text instead of the image).
      expect(
        resolveMarkdownImageSrc(
          "media/易配置平台2.0培训-1/001-abc.jpg",
          PROJECT,
          `${PROJECT}/wiki/sources`,
        ),
      ).toBe(
        "tauri-asset:/Users/me/MyWiki/wiki/media/易配置平台2.0培训-1/001-abc.jpg",
      )
      expect(
        resolveMarkdownImageSrc(
          "../media/易配置平台2.0培训-1/001-abc.jpg",
          PROJECT,
          `${PROJECT}/wiki/sources`,
        ),
      ).toBe(
        "tauri-asset:/Users/me/MyWiki/wiki/media/易配置平台2.0培训-1/001-abc.jpg",
      )
    })

    it("decodes percent-encoded CJK paths so the disk path is literal UTF-8", () => {
      // Regression: ReactMarkdown/remark percent-encodes non-ASCII
      // image URLs. The src arrives already-encoded; if we don't
      // decode it, convertFileSrc double-encodes (%E6 → %25E6) and
      // the asset server 404s. Decode must restore the real filename.
      const encoded =
        "media/%E6%98%93%E9%85%8D%E7%BD%AE%E5%B9%B3%E5%8F%B02.0%E5%9F%B9%E8%AE%AD-1/001-GTuhw460rheJYBb4dnccLxYDngd.jpg"
      expect(
        resolveMarkdownImageSrc(encoded, PROJECT, `${PROJECT}/wiki/sources`),
      ).toBe(
        "tauri-asset:/Users/me/MyWiki/wiki/media/易配置平台2.0培训-1/001-GTuhw460rheJYBb4dnccLxYDngd.jpg",
      )
    })

    it("decodes percent-encoded file-relative CJK paths too", () => {
      // Same fix must apply on the file-relative branch (raw/sources
      // with a CJK asset name, e.g. an exported Feishu image).
      expect(
        resolveMarkdownImageSrc(
          "../assets/%E5%9B%BE%E7%89%87.png",
          PROJECT,
          `${PROJECT}/raw/sources`,
        ),
      ).toBe("tauri-asset:/Users/me/MyWiki/raw/assets/图片.png")
    })

    it("keeps a malformed percent sequence as-is rather than throwing", () => {
      // A bare `%` that isn't a valid escape must not crash the
      // renderer — fall back to the raw value.
      expect(
        resolveMarkdownImageSrc("media/100%-done.png", PROJECT),
      ).toBe("tauri-asset:/Users/me/MyWiki/wiki/media/100%-done.png")
    })

    it("honors `./media/` (leading ./) as a wiki-root ref too, with a file dir", () => {
      expect(
        resolveMarkdownImageSrc(
          "./media/slug/img-2.png",
          PROJECT,
          `${PROJECT}/wiki/concepts`,
        ),
      ).toBe("tauri-asset:/Users/me/MyWiki/wiki/media/slug/img-2.png")
    })

    it("does not convert project-external absolute srcs even with a file dir set", () => {
      expect(
        resolveMarkdownImageSrc("/var/data/x.png", PROJECT, `${PROJECT}/raw/sources`),
      ).toBe("/var/data/x.png")
    })
  })
})

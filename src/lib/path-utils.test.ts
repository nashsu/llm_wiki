import { describe, it, expect } from "vitest"
import {
  normalizePath,
  joinPath,
  getFileName,
  getFileStem,
  getRelativePath,
  isAbsolutePath,
} from "./path-utils"

describe("normalizePath", () => {
  it("converts backslashes to forward slashes", () => {
    expect(normalizePath("C:\\Users\\foo\\bar")).toBe("C:/Users/foo/bar")
  })

  it("leaves forward slash paths unchanged", () => {
    expect(normalizePath("/Users/foo/bar")).toBe("/Users/foo/bar")
  })

  it("handles mixed separators", () => {
    expect(normalizePath("C:\\mixed/path\\here")).toBe("C:/mixed/path/here")
  })

  it("handles empty string", () => {
    expect(normalizePath("")).toBe("")
  })

  it("doesn't collapse consecutive slashes (by design)", () => {
    // normalizePath only does separator replacement, not deduplication
    expect(normalizePath("a\\\\b")).toBe("a//b")
  })
})

describe("joinPath", () => {
  it("joins simple segments with forward slashes", () => {
    expect(joinPath("a", "b", "c")).toBe("a/b/c")
  })

  it("collapses duplicate slashes at the join boundary", () => {
    expect(joinPath("a/", "/b", "c")).toBe("a/b/c")
  })

  it("normalizes backslashes inside segments", () => {
    expect(joinPath("C:\\Users", "foo", "bar")).toBe("C:/Users/foo/bar")
  })

  it("preserves a leading slash", () => {
    expect(joinPath("/abs", "path")).toBe("/abs/path")
  })

  it("joins a single segment", () => {
    expect(joinPath("only")).toBe("only")
  })
})

describe("getFileName", () => {
  it("returns the last segment of a POSIX path", () => {
    expect(getFileName("/a/b/c.md")).toBe("c.md")
  })

  it("returns the last segment of a Windows path", () => {
    expect(getFileName("C:\\Users\\foo\\bar.pdf")).toBe("bar.pdf")
  })

  it("returns the original string when no separators", () => {
    expect(getFileName("solo.md")).toBe("solo.md")
  })

  it("returns empty string when path ends with separator", () => {
    expect(getFileName("/dir/")).toBe("")
  })
})

describe("getFileStem", () => {
  it("strips a single extension", () => {
    expect(getFileStem("/a/b/note.md")).toBe("note")
  })

  it("strips only the LAST extension for double extensions", () => {
    expect(getFileStem("archive.tar.gz")).toBe("archive.tar")
  })

  it("returns the name unchanged for dotfiles (leading dot)", () => {
    // lastDot > 0 — so .env stays as .env
    expect(getFileStem(".env")).toBe(".env")
  })

  it("works across separators", () => {
    expect(getFileStem("C:\\dir\\notes.txt")).toBe("notes")
  })

  it("handles names with no extension", () => {
    expect(getFileStem("README")).toBe("README")
  })
})

describe("getRelativePath", () => {
  it("strips the base prefix", () => {
    expect(getRelativePath("/project/wiki/note.md", "/project")).toBe("wiki/note.md")
  })

  it("handles base with trailing slash", () => {
    expect(getRelativePath("/project/wiki/note.md", "/project/")).toBe("wiki/note.md")
  })

  it("normalizes separators on both sides", () => {
    expect(getRelativePath("C:\\project\\wiki\\note.md", "C:\\project")).toBe("wiki/note.md")
  })

  it("returns the full path if base doesn't prefix it", () => {
    expect(getRelativePath("/other/path", "/project")).toBe("/other/path")
  })

  it("requires an exact segment boundary (not just prefix match)", () => {
    // '/projector' should NOT be considered a base of '/project...'
    // The impl adds '/' to base for matching, so this is handled.
    expect(getRelativePath("/projector/a", "/project")).toBe("/projector/a")
  })
})

describe("isAbsolutePath", () => {
  it("recognizes Unix absolute paths", () => {
    expect(isAbsolutePath("/")).toBe(true)
    expect(isAbsolutePath("/home/user")).toBe(true)
    expect(isAbsolutePath("/a/b/c.md")).toBe(true)
  })

  it("recognizes Windows drive-letter paths with both separators", () => {
    expect(isAbsolutePath("C:\\Users\\nash")).toBe(true)
    expect(isAbsolutePath("C:/Users/nash")).toBe(true)
    expect(isAbsolutePath("D:\\")).toBe(true)
    expect(isAbsolutePath("z:/project/file.pdf")).toBe(true)
  })

  it("recognizes Windows UNC paths", () => {
    expect(isAbsolutePath("\\\\server\\share")).toBe(true)
    expect(isAbsolutePath("//server/share")).toBe(true)
  })

  it("rejects relative paths", () => {
    expect(isAbsolutePath("")).toBe(false)
    expect(isAbsolutePath("foo")).toBe(false)
    expect(isAbsolutePath("foo/bar.md")).toBe(false)
    expect(isAbsolutePath("./foo")).toBe(false)
    expect(isAbsolutePath("../foo")).toBe(false)
    expect(isAbsolutePath("wiki/concepts/attention.md")).toBe(false)
  })

  it("rejects drive-letter WITHOUT a separator (ambiguous)", () => {
    // "C:foo" is a Windows drive-relative path, not absolute.
    expect(isAbsolutePath("C:foo")).toBe(false)
  })
})

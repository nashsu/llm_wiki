import { describe, expect, it } from "vitest"
import { MAX_BATCH_URLS, fetchImportUrl, parseImportUrls, urlSourceFileName } from "./url-source-import"

describe("parseImportUrls", () => {
  it("normalizes fragments, removes duplicates, and preserves order", () => {
    expect(parseImportUrls(" https://example.com/a#part\nhttps://example.com/a\nhttp://例子.测试/b ")).toEqual([
      "https://example.com/a",
      "http://xn--fsqu00a.xn--0zwm56d/b",
    ])
  })

  it("rejects malformed and non-http URLs", () => {
    expect(() => parseImportUrls("not-a-url")).toThrow("Invalid URL")
    expect(() => parseImportUrls("file:///tmp/secret")).toThrow("Unsupported URL scheme")
    expect(() => parseImportUrls("https://user:secret@example.com/page")).toThrow("embedded credentials")
  })

  it("caps batch size", () => {
    const urls = Array.from({ length: MAX_BATCH_URLS + 1 }, (_, index) => `https://example.com/${index}`)
    expect(() => parseImportUrls(urls.join("\n"))).toThrow(`at most ${MAX_BATCH_URLS}`)
  })
})

describe("urlSourceFileName", () => {
  it("prefers a safe HTML title", () => {
    expect(urlSourceFileName(
      "https://example.com/post/123",
      "text/html; charset=utf-8",
      "<html><head><title>安全 / Useful: Guide</title></head></html>",
    )).toBe("安全-Useful-Guide.html")
  })

  it("uses the URL leaf for plain text", () => {
    expect(urlSourceFileName("https://example.com/docs/readme.md", "text/plain", "hello"))
      .toBe("readme.txt")
  })

  it("avoids Windows reserved names and tolerates malformed escapes", () => {
    expect(urlSourceFileName("https://example.com/AUX", "text/plain", "hello"))
      .toBe("AUX-web.txt")
    expect(urlSourceFileName("https://example.com/bad%escape", "text/plain", "hello"))
      .toBe("bad-escape.txt")
  })
})

describe("fetchImportUrl", () => {
  it("blocks a public URL redirect before requesting a private target", async () => {
    const fetch = async (url: string | URL | Request, init?: RequestInit & { maxRedirections?: number }) => {
      expect(String(url)).toBe("https://example.com/start")
      expect(init).toMatchObject({ redirect: "manual", maxRedirections: 0 })
      return new Response(null, {
        status: 302,
        headers: { location: "http://169.254.169.254/latest/meta-data" },
      })
    }
    await expect(fetchImportUrl(fetch as typeof globalThis.fetch, "https://example.com/start", new AbortController().signal))
      .rejects.toThrow("cannot redirect")
  })

  it("blocks IPv4-mapped IPv6 private redirect targets", async () => {
    const fetch = async () => new Response(null, {
      status: 302,
      headers: { location: "http://[::ffff:169.254.169.254]/metadata" },
    })
    await expect(fetchImportUrl(fetch as typeof globalThis.fetch, "https://example.com", new AbortController().signal))
      .rejects.toThrow("cannot redirect")
  })

  it("allows an explicitly requested private URL and follows relative redirects", async () => {
    const seen: string[] = []
    const fetch = async (url: string | URL | Request, init?: RequestInit & { maxRedirections?: number }) => {
      seen.push(String(url))
      expect(init).toMatchObject({ redirect: "manual", maxRedirections: 0 })
      return seen.length === 1
        ? new Response(null, { status: 302, headers: { location: "/page" } })
        : new Response("ok", { status: 200 })
    }
    const response = await fetchImportUrl(
      fetch as typeof globalThis.fetch,
      "http://192.168.1.50/start",
      new AbortController().signal,
    )
    expect(await response.text()).toBe("ok")
    expect(seen).toEqual(["http://192.168.1.50/start", "http://192.168.1.50/page"])
  })
})

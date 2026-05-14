import { describe, it, expect } from "vitest"
import { extractContentFromHtml } from "./web-crawler"

const FULL_HTML = `<!DOCTYPE html>
<html><head>
<meta property="og:title" content="Test Article">
<style>body{color:red}</style>
<script>console.log("hi")</script>
</head><body>
<header>Nav stuff</header>
<article>
  <h1>Test Article</h1>
  <p>This is the main content with <b>bold</b> text.</p>
  <p>Second paragraph.</p>
</article>
<footer>Footer links</footer>
</body></html>`

const MAIN_ONLY = `<!DOCTYPE html>
<html><head><title>Main Page</title></head><body>
<nav>Navigation</nav>
<main>
  <p>Main content here.</p>
</main>
<aside>Sidebar</aside>
</body></html>`

const BODY_ONLY = `<!DOCTYPE html>
<html><head><title>Body Page</title></head><body>
  <p>Just body content.</p>
</body></html>`

const NO_STRUCTURE = `Plain text without any HTML structure.`

const TITLE_ENTITIES = `<!DOCTYPE html>
<html><head><title>Tom &amp; Jerry &lt;Cartoon&gt;</title></head><body>
<article>Content</article>
</body></html>`

describe("extractContentFromHtml", () => {
  it("extracts article content and og:title", () => {
    const result = extractContentFromHtml(FULL_HTML)
    expect(result.title).toBe("Test Article")
    expect(result.content).toContain("This is the main content with <b>bold</b> text.")
    expect(result.content).toContain("Second paragraph.")
    expect(result.content).not.toContain("Nav stuff")
    expect(result.content).not.toContain("Footer links")
  })

  it("falls back to <main> when no <article>", () => {
    const result = extractContentFromHtml(MAIN_ONLY)
    expect(result.title).toBe("Main Page")
    expect(result.content).toContain("Main content here.")
    expect(result.content).not.toContain("Navigation")
  })

  it("falls back to <body> when no <article> or <main>", () => {
    const result = extractContentFromHtml(BODY_ONLY)
    expect(result.title).toBe("Body Page")
    expect(result.content).toContain("Just body content.")
  })

  it("handles plain text with no HTML structure", () => {
    const result = extractContentFromHtml(NO_STRUCTURE)
    expect(result.content).toContain("Plain text")
  })

  it("unescapes HTML entities in title", () => {
    const result = extractContentFromHtml(TITLE_ENTITIES)
    expect(result.title).toBe("Tom & Jerry <Cartoon>")
  })

  it("removes script and style tags", () => {
    const result = extractContentFromHtml(FULL_HTML)
    expect(result.content).not.toContain("console.log")
    expect(result.content).not.toContain("color:red")
  })
})

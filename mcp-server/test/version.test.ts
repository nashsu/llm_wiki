import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"
import { FALLBACK_VERSION, VERSION, loadMcpServerVersion } from "../src/version.js"

const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
  version: string
}

test("MCP server version is read from package.json", () => {
  assert.equal(VERSION, pkg.version)
})

test("MCP server version supports source-layout execution", () => {
  assert.equal(
    loadMcpServerVersion(new URL("../../src/version.ts", import.meta.url).href),
    pkg.version,
  )
})

test("MCP server version falls back when package.json cannot be found", () => {
  assert.equal(loadMcpServerVersion("file:///tmp/llm-wiki-missing/dist/src/version.js"), FALLBACK_VERSION)
})

test("MCP server version falls back for invalid meta URLs", () => {
  assert.equal(loadMcpServerVersion("not a url"), FALLBACK_VERSION)
})

#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { createToolServer } from "./tool-server.js"
import { VERSION } from "./version.js"

async function main(): Promise<void> {
  const server = createToolServer()
  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error(`LLM Wiki MCP server v${VERSION} connected to ${process.env.LLM_WIKI_API_BASE_URL ?? "http://127.0.0.1:19828"}`)
}

main().catch((err) => {
  console.error("Failed to start LLM Wiki MCP server:", err)
  process.exit(1)
})

/**
 * fake-llm-server.ts — A real HTTP server that speaks the OpenAI-compatible
 * Chat Completions SSE protocol AND the Tavily search REST protocol.
 *
 * This is NOT a code-level mock. The skill code (llm-client.ts, web-search.ts)
 * runs unmodified and goes through real fetch / real SSE parsing / real JSON
 * decoding. Only the upstream provider is replaced with a deterministic local
 * server so tests are reproducible and don't burn API credits.
 *
 * Routes:
 *   POST /v1/chat/completions   → OpenAI-style streaming SSE
 *   POST /search                → Tavily search results
 *
 * Programming model: the server picks its response based on a sequential
 * "script" you push via PUSH_SCRIPT, or falls back to a default echo. This
 * lets a test pre-arm Stage 1 (analysis) and Stage 2 (generation) responses
 * for the two-stage ingest pipeline.
 *
 * Run standalone:
 *   node dist/test-server/fake-llm-server.js [port]
 */
import * as http from "http"

export interface ScriptedResponse {
  /** Match against the user/system message text (substring). Empty = match any. */
  match?: string
  /** SSE chunks to stream (each becomes one delta token). */
  chunks: string[]
}

export interface FakeServerHandle {
  port: number
  baseUrl: string
  pushChat: (resp: ScriptedResponse) => void
  pushSearch: (results: { title: string; url: string; content: string; score?: number }[]) => void
  callCount: () => { chat: number; search: number }
  close: () => Promise<void>
}

interface InternalState {
  chatScript: ScriptedResponse[]
  searchScript: { title: string; url: string; content: string; score?: number }[][]
  chatCalls: number
  searchCalls: number
}

function sseEncode(content: string): string {
  const payload = {
    choices: [{ delta: { content }, index: 0, finish_reason: null }],
  }
  return `data: ${JSON.stringify(payload)}\n\n`
}

function sseDone(): string {
  const payload = {
    choices: [{ delta: {}, index: 0, finish_reason: "stop" }],
  }
  return `data: ${JSON.stringify(payload)}\n\ndata: [DONE]\n\n`
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on("data", (c) => chunks.push(c))
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")))
    req.on("error", reject)
  })
}

export function startFakeServer(port = 0): Promise<FakeServerHandle> {
  const state: InternalState = {
    chatScript: [],
    searchScript: [],
    chatCalls: 0,
    searchCalls: 0,
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = req.url ?? ""

      if (req.method === "POST" && url.startsWith("/v1/chat/completions")) {
        state.chatCalls++
        const bodyText = await readBody(req)
        let parsed: any = {}
        try { parsed = JSON.parse(bodyText) } catch { /* ignore */ }
        const lastMsg = (parsed.messages ?? []).map((m: any) => m.content ?? "").join("\n")

        // Pick the first script entry that matches; fall back to the first
        // unmatched ("match" undefined) entry; else echo.
        let chosen: ScriptedResponse | undefined
        for (let i = 0; i < state.chatScript.length; i++) {
          const s = state.chatScript[i]
          if (!s.match || lastMsg.includes(s.match)) {
            chosen = s
            state.chatScript.splice(i, 1)
            break
          }
        }
        if (!chosen) {
          chosen = { chunks: [`echo: ${lastMsg.slice(0, 80)}`] }
        }

        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        })
        for (const chunk of chosen.chunks) {
          res.write(sseEncode(chunk))
          // tiny delay so SSE parser exercises buffering
          await new Promise((r) => setTimeout(r, 5))
        }
        res.write(sseDone())
        res.end()
        return
      }

      if (req.method === "POST" && url.startsWith("/search")) {
        state.searchCalls++
        await readBody(req)
        const results = state.searchScript.shift() ?? []
        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ results: results.map((r) => ({ score: 0.5, ...r })) }))
        return
      }

      res.writeHead(404, { "Content-Type": "text/plain" })
      res.end("not found")
    } catch (err) {
      res.writeHead(500, { "Content-Type": "text/plain" })
      res.end(String(err))
    }
  })

  return new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(port, "127.0.0.1", () => {
      const addr = server.address()
      const actualPort = typeof addr === "object" && addr ? addr.port : port
      resolve({
        port: actualPort,
        baseUrl: `http://127.0.0.1:${actualPort}`,
        pushChat: (resp) => state.chatScript.push(resp),
        pushSearch: (results) => state.searchScript.push(results),
        callCount: () => ({ chat: state.chatCalls, search: state.searchCalls }),
        close: () => new Promise((r) => server.close(() => r())),
      })
    })
  })
}

// CLI entry: run standalone for ad-hoc testing.
if (require.main === module) {
  const port = parseInt(process.argv[2] ?? "0", 10) || 0
  startFakeServer(port).then((h) => {
    // Pre-arm a default chat response so curl works
    h.pushChat({ chunks: ["Hello", " from", " fake", " LLM"] })
    console.log(`Fake LLM server listening on ${h.baseUrl}`)
    console.log(`Endpoints:`)
    console.log(`  POST ${h.baseUrl}/v1/chat/completions`)
    console.log(`  POST ${h.baseUrl}/search`)
  }).catch((err) => {
    console.error("Failed to start fake server:", err)
    process.exit(1)
  })
}

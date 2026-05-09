/**
 * End-to-end TCP test: drive `streamChat` against a local fake Ollama
 * server and assert the request lands with our explicit `Origin`
 * header (NOT a webview-injected `http://tauri.localhost`).
 *
 * Scope of what this proves vs. what it can't prove:
 *
 *   ✓ Bytes-on-wire: from `getProviderConfig` → `streamChat` →
 *     fetch → real TCP, the headers we asked for actually reach
 *     the server. Catches regressions where future refactors strip
 *     or rename the Origin header anywhere in the pipeline.
 *
 *   ✗ plugin-http v2.5.x merge semantics: under Node, `tauri-fetch`
 *     falls back to `globalThis.fetch` (undici), which never
 *     auto-injects Origin. So the "user-set Origin overrides
 *     plugin-http auto-injection" claim isn't exercised here —
 *     that's verified by reading
 *     `node_modules/@tauri-apps/plugin-http/dist-js/index.js`
 *     line 71-75 (browser-default headers only fill keys the user
 *     hasn't already set) plus a manual Windows packet capture
 *     against a real desktop build. This test catches regressions
 *     on OUR side; the upstream plugin behavior is verified
 *     out-of-band.
 *
 * Lives in a `.real-llm.` file so it's excluded from the fast
 * mocked suite — it stands up a real listening socket and
 * shouldn't run on every save.
 */
import { describe, it, expect, vi } from "vitest"
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"

// streamChat doesn't touch Tauri commands or fs, but the module graph
// pulls them in transitively. Stub for sanity.
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}))
vi.mock("@/commands/fs", () => ({
  readFile: vi.fn(),
  listDirectory: vi.fn(),
}))

import { streamChat } from "./llm-client"
import type { LlmConfig } from "@/stores/wiki-store"

interface FakeOllamaHandle {
  url: string
  receivedRequests: () => Array<{ origin?: string; userAgent?: string; body: string }>
  setRejectMode: (mode: RejectMode) => void
  close: () => Promise<void>
}

type RejectMode =
  | { kind: "accept-same-origin"; selfOrigin: string }
  | { kind: "reject-all" }

/**
 * Start a fake Ollama-compatible server on 127.0.0.1. Behavior is
 * scriptable per test:
 *   - "accept-same-origin": 200 + SSE stream when the request's
 *     Origin equals the configured selfOrigin; 403 with a body
 *     mimicking Ollama's real CORS rejection otherwise.
 *   - "reject-all": every request returns 403 (lets us prove the
 *     server's CORS check is actually being exercised).
 *
 * The server records each incoming request so tests can assert what
 * Origin / User-Agent actually reached the wire.
 */
async function startFakeOllamaServer(initialMode: RejectMode): Promise<FakeOllamaHandle> {
  let mode = initialMode
  const requests: Array<{ origin?: string; userAgent?: string; body: string }> = []
  let server: Server | null = null

  const url = await new Promise<string>((resolve, reject) => {
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = []
      req.on("data", (c: Buffer) => chunks.push(c))
      req.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf-8")
        const origin = req.headers["origin"] as string | undefined
        const userAgent = req.headers["user-agent"] as string | undefined
        requests.push({ origin, userAgent, body })

        // Mimic Ollama's CORS check.
        const allow =
          mode.kind === "accept-same-origin" && origin === mode.selfOrigin
        if (!allow) {
          res.statusCode = 403
          res.setHeader("Content-Type", "text/plain")
          res.end("Forbidden: origin not in allowlist")
          return
        }

        res.statusCode = 200
        if (req.url === "/api/chat") {
          res.setHeader("Content-Type", "application/x-ndjson")
          res.end([
            JSON.stringify({ message: { content: "hello" }, done: false }),
            JSON.stringify({ message: { content: " world" }, done: true }),
            "",
          ].join("\n"))
          return
        }

        // Custom OpenAI-compatible endpoints still stream SSE.
        res.setHeader("Content-Type", "text/event-stream")
        res.setHeader("Cache-Control", "no-cache")
        res.end([
          `data: ${JSON.stringify({ choices: [{ delta: { content: "hello" } }] })}`,
          ``,
          `data: ${JSON.stringify({ choices: [{ delta: { content: " world" } }] })}`,
          ``,
          `data: [DONE]`,
          ``,
          ``,
        ].join("\n"))
      })
    })
    server.on("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const addr = server!.address() as AddressInfo
      resolve(`http://127.0.0.1:${addr.port}`)
    })
  })

  return {
    url,
    receivedRequests: () => [...requests],
    setRejectMode: (m: RejectMode) => {
      mode = m
    },
    close: () =>
      new Promise<void>((resolve) => {
        if (server) server.close(() => resolve())
        else resolve()
      }),
  }
}

const TEST_TIMEOUT_MS = 30_000

describe("streamChat against a fake Ollama server (real TCP)", () => {
  it(
    "sends Origin = http://localhost so Ollama's CORS check passes",
    async () => {
      const server = await startFakeOllamaServer({
        kind: "accept-same-origin",
        selfOrigin: "", // set after we know the URL
      })
      try {
        server.setRejectMode({ kind: "accept-same-origin", selfOrigin: "http://localhost" })

        const cfg: LlmConfig = {
          provider: "ollama",
          apiKey: "",
          model: "llama3",
          ollamaUrl: server.url,
          customEndpoint: "",
          maxContextSize: 8192,
        }

        const tokens: string[] = []
        const state: { done: boolean; error: Error | null } = { done: false, error: null }
        await streamChat(
          cfg,
          [{ role: "user", content: "hi" }],
          {
            onToken: (t) => {
              tokens.push(t)
            },
            onDone: () => {
              state.done = true
            },
            onError: (e) => {
              state.error = e
            },
          },
        )

        expect(state.error, `streamChat reported error: ${state.error?.message}`).toBeNull()
        expect(state.done).toBe(true)
        expect(tokens.join("")).toBe("hello world")

        const reqs = server.receivedRequests()
        expect(reqs).toHaveLength(1)
        // Bytes-on-wire assertion: our explicit Origin made it through.
        expect(reqs[0].origin).toBe("http://localhost")
        const parsed = JSON.parse(reqs[0].body) as { model: string; messages: unknown[]; options: { num_ctx: number } }
        expect(parsed.model).toBe("llama3")
        expect(parsed.messages).toEqual([{ role: "user", content: "hi" }])
        expect(parsed.options.num_ctx).toBe(8192)
      } finally {
        await server.close()
      }
    },
    TEST_TIMEOUT_MS,
  )

  it(
    "the fake server's CORS check actually rejects mismatched origins (proves the test isn't trivially green)",
    async () => {
      // Sanity check: if our Origin override regressed, the server
      // would reject. We force a wrong-origin scenario by setting the
      // server to "accept only http://something-else" and confirming
      // that streamChat surfaces a 4xx error.
      const server = await startFakeOllamaServer({
        kind: "accept-same-origin",
        selfOrigin: "http://impossible-mismatch.test",
      })
      try {
        const cfg: LlmConfig = {
          provider: "ollama",
          apiKey: "",
          model: "llama3",
          ollamaUrl: server.url,
          customEndpoint: "",
          maxContextSize: 8192,
        }

        const state: { done: boolean; error: Error | null } = { done: false, error: null }
        await streamChat(
          cfg,
          [{ role: "user", content: "hi" }],
          {
            onToken: () => {},
            onDone: () => {
              state.done = true
            },
            onError: (e) => {
              state.error = e
            },
          },
        )

        // streamChat reports HTTP errors via onError; the request still
        // resolves cleanly (no thrown exception).
        expect(state.error, "expected the 403 to surface as an onError, not silent success").not.toBeNull()
        expect(state.error!.message).toMatch(/403/)
        expect(state.done).toBe(false)

        const reqs = server.receivedRequests()
        expect(reqs).toHaveLength(1)
        // The request DID reach the server with our Origin — the 403
        // was generated by the server's allowlist mismatch, not a
        // pre-flight failure or network error.
        expect(reqs[0].origin).toBe("http://localhost")
      } finally {
        await server.close()
      }
    },
    TEST_TIMEOUT_MS,
  )

  it(
    "custom OpenAI-compat endpoint (LM Studio / llama.cpp) also sends Origin = http://localhost",
    async () => {
      const server = await startFakeOllamaServer({
        kind: "accept-same-origin",
        selfOrigin: "",
      })
      try {
        server.setRejectMode({ kind: "accept-same-origin", selfOrigin: "http://localhost" })

        const cfg: LlmConfig = {
          provider: "custom",
          apiKey: "",
          model: "qwen3",
          ollamaUrl: "",
          customEndpoint: server.url,
          maxContextSize: 8192,
          apiMode: "chat_completions",
        }

        const state: { done: boolean; error: Error | null } = { done: false, error: null }
        await streamChat(
          cfg,
          [{ role: "user", content: "hi" }],
          {
            onToken: () => {},
            onDone: () => {
              state.done = true
            },
            onError: (e) => {
              state.error = e
            },
          },
        )

        expect(state.error).toBeNull()
        expect(state.done).toBe(true)
        expect(server.receivedRequests()[0].origin).toBe("http://localhost")
      } finally {
        await server.close()
      }
    },
    TEST_TIMEOUT_MS,
  )
})

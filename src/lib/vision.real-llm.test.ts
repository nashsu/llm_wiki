/**
 * Real-LLM probe: drive `streamChat` against a vision-capable
 * OpenAI-compatible endpoint (defaults to the user's Qwen3.6 box at
 * 192.168.1.50:8000) with a `ContentBlock[]` carrying one image.
 *
 * What this verifies (end-to-end):
 *   - `buildOpenAiBody` → `toOpenAiContent` produces a body the
 *     vision model actually accepts (vs. the unit tests which just
 *     check the JSON shape against our expectation).
 *   - The streaming response is parsed by `parseOpenAiLine` and
 *     reaches our `onToken` callback.
 *   - The model "looked at" the image — we assert the response
 *     mentions either "red" / "color" / a non-trivial substring.
 *     A pure-text endpoint would just answer "I cannot see any
 *     image" or hallucinate, which the assertion catches.
 *
 * Lives in a `.real-llm.` file so the fast suite skips it (it hits
 * a real network and a real GPU). Override the endpoint and model
 * via env if your setup differs:
 *
 *   VISION_ENDPOINT=http://localhost:8000/v1 \
 *   VISION_MODEL=Qwen2.5-VL-7B-Instruct \
 *   npx vitest run src/lib/vision.real-llm.test.ts
 *
 * Default skip path: when VISION_ENDPOINT is unset AND the default
 * host (192.168.1.50:8000) isn't reachable in <2s, the test is
 * skipped rather than failed. Lets contributors without the LAN
 * box still run the rest of the .real-llm.* suite.
 */
import { describe, it, expect, vi } from "vitest"

// Same module-graph stubs as llm-client.real-llm.test.ts — streamChat
// transitively imports stores that touch Tauri commands during init.
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}))
vi.mock("@/commands/fs", () => ({
  readFile: vi.fn(),
  listDirectory: vi.fn(),
}))

import { streamChat } from "./llm-client"
import type { LlmConfig } from "@/stores/wiki-store"
import type { ChatMessage } from "./llm-providers"

const DEFAULT_ENDPOINT = "http://192.168.1.50:8000/v1"
const DEFAULT_MODEL = "Qwen3.6-27B-Q4_K_M.gguf"
const ENDPOINT = process.env.VISION_ENDPOINT ?? DEFAULT_ENDPOINT
const MODEL = process.env.VISION_MODEL ?? DEFAULT_MODEL
const REACHABILITY_TIMEOUT_MS = 2000
const TEST_TIMEOUT_MS = 120_000

/**
 * Solid-red 64×64 PNG, deterministically generated and pinned as
 * base64. We started with a 1×1 pixel which several vision-model
 * loaders rejected with "Failed to load image" / "Invalid image
 * detected" — too small for typical image preprocessing pipelines
 * that downsample/normalize the input. 64×64 is enough to clear
 * those guards while still keeping the request under 1KB.
 *
 * Pinned (not computed at runtime) so the test stays deterministic
 * and works without a PNG encoder dependency in the test env.
 */
const RED_PNG_64_B64 = "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAb0lEQVR4nO3PAQkAAAyEwO9feoshgnABdLep8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3IPanc8OLDQitxAAAAAElFTkSuQmCC"

async function isEndpointReachable(url: string, timeoutMs: number): Promise<boolean> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    // /v1/models is the canonical liveness probe for OpenAI-compat
    // servers. We don't actually care about the response body — a
    // socket-level success means the host is up, which is what the
    // skip gate cares about.
    const probe = url.replace(/\/+$/, "") + "/models"
    await fetch(probe, { signal: controller.signal })
    return true
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

describe("vision wire E2E (real LLM)", () => {
  it(
    "text-only baseline — endpoint is alive and our SSE parser sees its output",
    async () => {
      const reachable = await isEndpointReachable(ENDPOINT, REACHABILITY_TIMEOUT_MS)
      if (!reachable) {
        console.warn(`[vision.real-llm] ${ENDPOINT} not reachable — skipping`)
        return
      }
      const cfg: LlmConfig = {
        provider: "custom",
        apiKey: "",
        model: MODEL,
        ollamaUrl: "",
        customEndpoint: ENDPOINT,
        apiMode: "chat_completions",
        maxContextSize: 8192,
      }
      const tokens: string[] = []
      const state: { done: boolean; error: Error | null } = { done: false, error: null }
      await streamChat(
        cfg,
        [{ role: "user", content: "Say the single word: ready" }],
        {
          onToken: (t) => tokens.push(t),
          onDone: () => {
            state.done = true
          },
          onError: (e) => {
            state.error = e
          },
        },
        undefined,
        // max_tokens is the budget for the *answer*, not just the
        // visible content — Qwen3 / DeepSeek-R1-style models stream
        // their internal reasoning in `delta.reasoning_content`
        // FIRST, then the actual answer in `delta.content` after
        // the </think> boundary. Our `parseOpenAiLine` only
        // surfaces `delta.content`, so a small max_tokens like 16
        // gets entirely consumed by reasoning and the visible
        // stream stays empty. 4096 leaves room for both.
        { temperature: 0, max_tokens: 4096 },
      )
      const body = tokens.join("").trim()
      console.log(`[vision.real-llm:text-baseline] tokens=${tokens.length} body="${body}"`)
      expect(state.error, `text-baseline error: ${state.error?.message}`).toBeNull()
      expect(state.done).toBe(true)
      expect(body.length, "text-only response is non-empty (proves the endpoint+parser pipeline works at all)").toBeGreaterThan(0)
    },
    TEST_TIMEOUT_MS,
  )

  it(
    "OpenAI-compat endpoint accepts ContentBlock[] with image and produces a description",
    async () => {
      // Skip rather than fail when the LAN endpoint isn't reachable —
      // contributors without that machine still get to run the rest
      // of the .real-llm.* suite.
      const reachable = await isEndpointReachable(ENDPOINT, REACHABILITY_TIMEOUT_MS)
      if (!reachable) {
        console.warn(`[vision.real-llm] ${ENDPOINT} not reachable in ${REACHABILITY_TIMEOUT_MS}ms — skipping`)
        return
      }

      const cfg: LlmConfig = {
        provider: "custom",
        apiKey: "",
        model: MODEL,
        ollamaUrl: "",
        customEndpoint: ENDPOINT,
        apiMode: "chat_completions",
        maxContextSize: 8192,
      }

      const messages: ChatMessage[] = [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "What single color fills this image? Reply with one English word.",
            },
            {
              type: "image",
              mediaType: "image/png",
              dataBase64: RED_PNG_64_B64,
            },
          ],
        },
      ]

      const tokens: string[] = []
      const state: { done: boolean; error: Error | null } = { done: false, error: null }

      await streamChat(
        cfg,
        messages,
        {
          onToken: (t) => tokens.push(t),
          onDone: () => {
            state.done = true
          },
          onError: (e) => {
            state.error = e
          },
        },
        undefined,
        // See text-baseline test for max_tokens rationale (Qwen3
        // thinking-mode tokens count against this budget).
        { temperature: 0, max_tokens: 4096 },
      )

      const body = tokens.join("").trim()
      console.log(`[vision.real-llm] model="${MODEL}" replied: "${body}"`)

      expect(state.error, `streamChat error: ${state.error?.message}`).toBeNull()
      expect(state.done, "stream finished cleanly").toBe(true)
      expect(body.length, "response is non-empty").toBeGreaterThan(0)

      // Behavioral assertion — the model should "see" red. We
      // accept "red" in any case and tolerate trailing punctuation
      // / Chinese 红色 (some Qwen builds prefer answering in the
      // model's pretraining-dominant language regardless of the
      // prompt language).
      const matchesRed = /\bred\b/i.test(body) || body.includes("红")
      expect(matchesRed, `expected "red" or "红" in response; got: "${body}"`).toBe(true)
    },
    TEST_TIMEOUT_MS,
  )
})

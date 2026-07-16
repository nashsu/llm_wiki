/**
 * Real-LLM probe: drive `captionImage` against a vision endpoint
 * (defaults to LM Studio at 192.168.1.218:1234, override via
 * VISION_ENDPOINT / VISION_MODEL env vars). Verifies the WHOLE
 * captioning path end-to-end, not just the wire shape:
 *
 *   ContentBlock[] → buildOpenAiBody → SSE stream
 *   → parseOpenAiLine → onToken → captionImage joins → trimmed string
 *
 * What the assertions actually check:
 *   - The returned string is non-empty (rules out the "thinking
 *     mode burns all max_tokens" failure mode that bit Phase 2).
 *   - The caption mentions "red" (case-insensitive) or 红色 — proves
 *     the model both received the image AND reasoned about it,
 *     not just ran a hard-coded "I see an image" reply.
 *
 * Skipped when the endpoint isn't reachable in <2s. Lives in
 * `.real-llm.` so the fast suite ignores it.
 */
import { describe, it, expect, vi } from "vitest"

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}))
vi.mock("@/commands/fs", () => ({
  readFile: vi.fn(),
  listDirectory: vi.fn(),
}))

import { captionImage } from "./vision-caption"
import type { LlmConfig } from "@/stores/wiki-store"

const DEFAULT_ENDPOINT = "http://192.168.1.218:1234/v1"
const DEFAULT_MODEL = "qwen3.5-4b"
const ENDPOINT = process.env.VISION_ENDPOINT ?? DEFAULT_ENDPOINT
const MODEL = process.env.VISION_MODEL ?? DEFAULT_MODEL
const REACHABILITY_TIMEOUT_MS = 2000
const TEST_TIMEOUT_MS = 180_000

// Same 64×64 solid-red PNG used in vision.real-llm.test.ts.
// Pinned base64 of the raw bytes (NOT a data: URL — that framing
// is added by the OpenAI provider translator).
const RED_PNG_64_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAb0lEQVR4nO3PAQkAAAyEwO9feoshgnABdLep8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3IPanc8OLDQitxAAAAAElFTkSuQmCC"

async function isEndpointReachable(url: string, timeoutMs: number): Promise<boolean> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    await fetch(url.replace(/\/+$/, "") + "/models", { signal: controller.signal })
    return true
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

describe("captionImage E2E (real LLM)", () => {
  it(
    "returns a non-empty caption mentioning 'red' for a solid-red image",
    async () => {
      const reachable = await isEndpointReachable(ENDPOINT, REACHABILITY_TIMEOUT_MS)
      if (!reachable) {
        console.warn(`[vision-caption.real-llm] ${ENDPOINT} not reachable — skipping`)
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

      const caption = await captionImage(RED_PNG_64_B64, "image/png", cfg)
      console.log(`[vision-caption.real-llm] caption: "${caption}"`)

      expect(caption.length, "caption is non-empty").toBeGreaterThan(0)
      const mentionsRed = /\bred\b/i.test(caption) || caption.includes("红")
      expect(
        mentionsRed,
        `expected caption to mention "red" or "红"; got: "${caption}"`,
      ).toBe(true)

      // Plain text contract: no markdown structure leaking out.
      // The pinned prompt explicitly bans this; this assertion
      // catches drift in the model's instruction-following.
      expect(caption).not.toMatch(/^#+\s/m) // no heading lines
      expect(caption).not.toMatch(/```/) // no fenced code blocks
    },
    TEST_TIMEOUT_MS,
  )
})

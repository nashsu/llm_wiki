import { describe, it, expect } from "vitest"
import { countReasoningCharsInLine, extractReasoningTextFromLine } from "./reasoning-detector"

describe("countReasoningCharsInLine", () => {
  it("returns 0 for empty / non-stream lines", () => {
    expect(countReasoningCharsInLine("")).toBe(0)
    expect(countReasoningCharsInLine("data: [DONE]")).toBe(0)
    expect(countReasoningCharsInLine("not even json")).toBe(0)
  })

  it("returns 0 when only `content` is present (the normal happy path)", () => {
    const line =
      'data: {"choices":[{"index":0,"delta":{"content":"hello"},"finish_reason":null}]}'
    expect(countReasoningCharsInLine(line)).toBe(0)
  })

  it("counts chars in `reasoning_content` (DeepSeek-R1 / Kimi K2.6 convention)", () => {
    const line =
      'data: {"choices":[{"index":0,"delta":{"reasoning_content":"thinking"}}]}'
    expect(countReasoningCharsInLine(line)).toBe("thinking".length)
  })

  it("counts chars in `reasoning` (the user's Qwen3.5-122B endpoint)", () => {
    const line =
      'data: {"choices":[{"index":0,"delta":{"reasoning":"Let me think..."}}]}'
    expect(countReasoningCharsInLine(line)).toBe("Let me think...".length)
  })

  it("doesn't double-count `reasoning_content` as `reasoning`", () => {
    // Defensive: only one of the two fields ever appears per chunk
    // in real-world endpoints, but if both showed up we'd count
    // each exactly once.
    const line =
      'data: {"choices":[{"delta":{"reasoning":"abc","reasoning_content":"xyz"}}]}'
    expect(countReasoningCharsInLine(line)).toBe(6)
  })

  it("ignores other fields whose names contain `reasoning` substring", () => {
    // e.g. a hypothetical `reasoning_done: true` flag — we only
    // want string-valued reasoning fields. The regex requires `:`
    // immediately followed by a quoted string, so this is safe.
    const line = 'data: {"reasoning_done":true,"delta":{"content":"hi"}}'
    expect(countReasoningCharsInLine(line)).toBe(0)
  })

  it("handles JSON string escapes in the reasoning text", () => {
    // The escaped-length is what we count (we don't decode); for
    // a "\n" escape sequence that's 2 chars, not 1. Acceptable
    // for the diagnostic threshold check.
    const line =
      'data: {"choices":[{"delta":{"reasoning":"line one\\nline two"}}]}'
    expect(countReasoningCharsInLine(line)).toBe("line one\\nline two".length)
  })

  it("returns 0 for malformed JSON without crashing", () => {
    expect(countReasoningCharsInLine('data: {"reasoning":')).toBe(0)
    expect(countReasoningCharsInLine('{"unclosed: "string"}')).toBe(0)
  })

  it("works on a real Kimi K2.6 chunk (reasoning_content path)", () => {
    const line =
      'data: {"id":"chatcmpl-abc","choices":[{"index":0,"delta":{"reasoning_content":"用户"},"finish_reason":null}]}'
    expect(countReasoningCharsInLine(line)).toBe("用户".length)
  })

  it("works on a real Qwen3.5 chunk (the user's reported case)", () => {
    const line =
      'data: {"id":"chatcmpl-b5152c89f36f8aa7","object":"chat.completion.chunk","model":"Qwen3.5-122B","choices":[{"index":0,"delta":{"reasoning":"Thinking"},"logprobs":null,"finish_reason":null}]}'
    expect(countReasoningCharsInLine(line)).toBe("Thinking".length)
  })
})

describe("extractReasoningTextFromLine", () => {
  it("extracts OpenAI-compatible reasoning_content chunks", () => {
    const line =
      'data: {"choices":[{"index":0,"delta":{"reasoning_content":"thinking"}}]}'
    expect(extractReasoningTextFromLine(line)).toEqual(["thinking"])
  })

  it("extracts Qwen-style reasoning chunks", () => {
    const line =
      'data: {"choices":[{"index":0,"delta":{"reasoning":"Let me think"}}]}'
    expect(extractReasoningTextFromLine(line)).toEqual(["Let me think"])
  })

  it("extracts Anthropic thinking deltas", () => {
    const line =
      'data: {"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"reasoning"}}'
    expect(extractReasoningTextFromLine(line)).toEqual(["reasoning"])
  })

  it("extracts Gemini thought parts", () => {
    const line =
      'data: {"candidates":[{"content":{"parts":[{"thought":true,"text":"hidden"},{"text":"visible"}]}}]}'
    expect(extractReasoningTextFromLine(line)).toEqual(["hidden"])
  })

  it("ignores visible content", () => {
    const line =
      'data: {"choices":[{"index":0,"delta":{"content":"hello"},"finish_reason":null}]}'
    expect(extractReasoningTextFromLine(line)).toEqual([])
  })
})

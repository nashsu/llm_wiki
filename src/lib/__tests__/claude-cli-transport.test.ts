import { describe, it, expect } from "vitest"
import { createClaudeCodeStreamParser } from "../claude-cli-transport"

describe("createClaudeCodeStreamParser", () => {
  it("emits text from a single stream_event text_delta", () => {
    const parse = createClaudeCodeStreamParser()
    const line = JSON.stringify({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        delta: { type: "text_delta", text: "Hello" },
      },
    })
    expect(parse(line)).toBe("Hello")
  })

  it("accumulates multiple stream_event deltas in order", () => {
    const parse = createClaudeCodeStreamParser()
    const mk = (t: string) =>
      JSON.stringify({
        type: "stream_event",
        event: { type: "content_block_delta", delta: { type: "text_delta", text: t } },
      })
    expect(parse(mk("Hello "))).toBe("Hello ")
    expect(parse(mk("world"))).toBe("world")
    expect(parse(mk("!"))).toBe("!")
  })

  it("falls back to `assistant` message text when no deltas arrived", () => {
    const parse = createClaudeCodeStreamParser()
    const line = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "Hi there" }] },
    })
    expect(parse(line)).toBe("Hi there")
  })

  it("emits only the novel tail when `assistant` events ship cumulative text", () => {
    // Older claude CLI versions re-send the full in-progress message on
    // each assistant event instead of emitting deltas. The parser must
    // diff those so the UI doesn't render "HiHi thereHi there, friend".
    const parse = createClaudeCodeStreamParser()
    const mk = (t: string) =>
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: t }] } })
    expect(parse(mk("Hi"))).toBe("Hi")
    expect(parse(mk("Hi there"))).toBe(" there")
    expect(parse(mk("Hi there, friend"))).toBe(", friend")
  })

  it("skips `assistant` events entirely once stream_event deltas are seen", () => {
    // When both event types are present (newer CLIs with --verbose),
    // deltas are authoritative and the fat `assistant` events would
    // duplicate text if we emitted them.
    const parse = createClaudeCodeStreamParser()
    const delta = JSON.stringify({
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hi" } },
    })
    const asst = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "Hi" }] },
    })
    expect(parse(delta)).toBe("Hi")
    expect(parse(asst)).toBeNull()
  })

  it("concatenates multiple text parts inside one `assistant` event", () => {
    const parse = createClaudeCodeStreamParser()
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "Part one. " },
          { type: "tool_use", id: "x", name: "bash", input: {} },
          { type: "text", text: "Part two." },
        ],
      },
    })
    expect(parse(line)).toBe("Part one. Part two.")
  })

  it("returns null for system init, result, tool_use, and unknown types", () => {
    const parse = createClaudeCodeStreamParser()
    expect(parse(JSON.stringify({ type: "system", subtype: "init" }))).toBeNull()
    expect(parse(JSON.stringify({ type: "result", subtype: "success", result: "done" }))).toBeNull()
    expect(parse(JSON.stringify({ type: "tool_use", id: "x" }))).toBeNull()
    expect(parse(JSON.stringify({ type: "future_type_we_dont_know" }))).toBeNull()
  })

  it("returns null for malformed JSON or blank lines", () => {
    const parse = createClaudeCodeStreamParser()
    expect(parse("")).toBeNull()
    expect(parse("   ")).toBeNull()
    expect(parse("not json at all")).toBeNull()
    expect(parse("{bad json")).toBeNull()
  })

  it("returns null for stream_event shapes we don't recognize (usage/etc.)", () => {
    const parse = createClaudeCodeStreamParser()
    // e.g. message_start / message_delta / ping — Anthropic lifecycle
    // events that carry no user-visible text.
    expect(
      parse(
        JSON.stringify({
          type: "stream_event",
          event: { type: "message_start", message: { id: "m" } },
        }),
      ),
    ).toBeNull()
    expect(
      parse(
        JSON.stringify({
          type: "stream_event",
          event: {
            type: "content_block_delta",
            delta: { type: "input_json_delta", partial_json: "{\"a\":" },
          },
        }),
      ),
    ).toBeNull()
  })
})

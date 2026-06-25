import { describe, it, expect } from "vitest"
import { chatMessagesToLLM, type DisplayMessage } from "./chat-store"

function msg(partial: Partial<DisplayMessage> & Pick<DisplayMessage, "role" | "content">): DisplayMessage {
  return {
    id: "1",
    timestamp: 0,
    conversationId: "c1",
    ...partial,
  }
}

describe("chatMessagesToLLM", () => {
  it("keeps the legacy string shape when a message has no images", () => {
    const out = chatMessagesToLLM([msg({ role: "user", content: "hello" })])
    expect(out).toEqual([{ role: "user", content: "hello" }])
    expect(typeof out[0].content).toBe("string")
  })

  it("keeps string shape when images is an empty array", () => {
    const out = chatMessagesToLLM([msg({ role: "user", content: "hi", images: [] })])
    expect(out[0].content).toBe("hi")
  })

  it("emits ContentBlock[] (text first, then image blocks) when images are present", () => {
    const out = chatMessagesToLLM([
      msg({
        role: "user",
        content: "what is this?",
        images: [
          { mediaType: "image/png", dataBase64: "AAAA" },
          { mediaType: "image/jpeg", dataBase64: "BBBB" },
        ],
      }),
    ])
    expect(out[0].role).toBe("user")
    expect(out[0].content).toEqual([
      { type: "text", text: "what is this?" },
      { type: "image", mediaType: "image/png", dataBase64: "AAAA" },
      { type: "image", mediaType: "image/jpeg", dataBase64: "BBBB" },
    ])
  })

  it("still includes a (possibly empty) text block for image-only messages", () => {
    const out = chatMessagesToLLM([
      msg({ role: "user", content: "", images: [{ mediaType: "image/webp", dataBase64: "CCCC" }] }),
    ])
    const blocks = out[0].content as Array<{ type: string }>
    expect(blocks[0]).toEqual({ type: "text", text: "" })
    expect(blocks[1]).toEqual({ type: "image", mediaType: "image/webp", dataBase64: "CCCC" })
  })
})

import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"
import "@/i18n"
import { ChatPanel } from "./chat-panel"

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(),
}))

describe("ChatPanel agent mode rendering", () => {
  it("renders the mode switch in the default chat panel", () => {
    const html = renderToStaticMarkup(<ChatPanel />)

    expect(html).toContain("Chat")
    expect(html).toContain("Agent")
    expect(html).toContain("Ingest")
    expect(html).toContain("Type a message")
  })
})

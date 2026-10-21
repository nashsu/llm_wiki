import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { CopilotAuth } from "./copilot-auth"

const mocks = vi.hoisted(() => ({
  session: { authenticated: false, models: [] as { id: string; name: string }[], flow: null as null | { verificationUri: string; userCode: string; expiresIn: number }, busy: false, error: null as null | string },
  refresh: vi.fn(), start: vi.fn(), logout: vi.fn(), cancel: vi.fn(),
}))
vi.mock("@/lib/copilot-session", () => ({
  useCopilotSession: (selector?: (state: typeof mocks.session) => unknown) => selector ? selector(mocks.session) : mocks.session,
  refreshCopilotSession: mocks.refresh, signInCopilot: mocks.start, signOutCopilot: mocks.logout, cancelCopilotSignIn: mocks.cancel,
}))
vi.mock("@/components/ui/button", () => ({ Button: "button" }))
function render() { return renderToStaticMarkup(createElement(CopilotAuth, { model: "gpt-4.1-mini", onModelChange: vi.fn() })) }
beforeEach(() => {
  mocks.session = { authenticated: false, models: [], flow: null, busy: false, error: null }
  vi.clearAllMocks()
})

describe("Copilot explicit device sign-in UI", () => {
  it("shows a sign-in action and disabled picker, never a credential field or implicit auth", () => {
    const html = render()
    expect(html).toContain("Sign in to GitHub Copilot")
    expect(html).toMatch(/<select[^>]*\sdisabled(?:=|\s|>)/)
    expect(html).not.toMatch(/type="password"|type="text"|textarea/)
    expect(mocks.start).not.toHaveBeenCalled()
  })
  it("displays the manual device URL and code, with no auto-opening link", () => {
    mocks.session.flow = { verificationUri: "https://github.com/login/device", userCode: "example-pairing-label", expiresIn: 900 }
    mocks.session.busy = true
    const html = render()
    expect(html).toContain("https://github.com/login/device")
    expect(html).toContain("example-pairing-label")
    expect(html).toContain("Cancel sign-in")
    expect(html).not.toContain("href=")
  })
  it("enables catalog-only model selection and sign-out after authentication", () => {
    mocks.session.authenticated = true
    mocks.session.models = [{ id: "gpt-4.1-mini", name: "GPT 4.1 mini" }]
    const html = render()
    expect(html).toContain("Sign out")
    expect(html).toContain('value="gpt-4.1-mini" selected=""')
    expect(html).not.toMatch(/<select[^>]*\sdisabled(?:=|\s|>)/)
    expect(html).not.toContain("<input")
  })
  it("surfaces sign-in failures and provider limitations accessibly", () => {
    mocks.session.error = "Authorization expired"
    const html = render()
    expect(html).toContain('role="alert"')
    expect(html).toContain("Authorization expired")
    expect(html).toContain("Text only, buffered responses")
  })
})

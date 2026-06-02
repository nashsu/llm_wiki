import { renderToStaticMarkup } from "react-dom/server"
import type { ReactNode } from "react"
import { describe, expect, it, vi } from "vitest"
import "@/i18n"

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { open?: boolean; children: ReactNode }) =>
    open ? <div>{children}</div> : null,
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
}))

import {
  buildAgentPermissionDecision,
  formatAgentPermissionInputPreview,
  isAgentPermissionInteractiveElement,
} from "./agent-permission"
import {
  AgentPermissionDialogBody,
  AgentPermissionDialogHost,
} from "./agent-permission-dialog"
import { useChatStore, type AgentPermissionRequestRecord } from "@/stores/chat-store"

function permissionRequest(overrides: Partial<AgentPermissionRequestRecord> = {}): AgentPermissionRequestRecord {
  return {
    requestId: "permission-1",
    toolName: "Bash",
    displayName: "Shell command",
    description: "Claude wants to run a shell command.",
    inputPreview: { command: "pwd" },
    blockedPath: "/tmp/blocked",
    toolUseID: "tool-1",
    suggestions: [{ type: "allow", pattern: "Bash" }],
    receivedAt: 0,
    expiresAt: Date.now() + 60_000,
    timeoutMs: 60_000,
    ...overrides,
  }
}

describe("agent permission helpers", () => {
  it("builds allow and deny permission decisions", () => {
    const request = permissionRequest()

    expect(buildAgentPermissionDecision("allow_temporary", request)).toEqual({
      behavior: "allow",
      decisionClassification: "user_temporary",
    })
    expect(buildAgentPermissionDecision("allow_permanent", request)).toEqual({
      behavior: "allow",
      updatedPermissions: request.suggestions,
      decisionClassification: "user_permanent",
    })
    expect(buildAgentPermissionDecision("deny", request)).toMatchObject({
      behavior: "deny",
      decisionClassification: "user_reject",
    })
    expect(buildAgentPermissionDecision("deny_interrupt", request)).toMatchObject({
      behavior: "deny",
      interrupt: true,
      decisionClassification: "user_reject",
    })
  })

  it("formats circular input previews safely", () => {
    const value: Record<string, unknown> = { command: "pwd" }
    value.self = value

    expect(formatAgentPermissionInputPreview(value)).toContain("[Circular]")
  })

  it("detects interactive elements that should keep native Enter behavior", () => {
    expect(isAgentPermissionInteractiveElement("button")).toBe(true)
    expect(isAgentPermissionInteractiveElement("input")).toBe(true)
    expect(isAgentPermissionInteractiveElement("div", "button")).toBe(true)
    expect(isAgentPermissionInteractiveElement("div")).toBe(false)
  })
})

describe("AgentPermissionDialog", () => {
  it("renders a permission request", () => {
    const html = renderToStaticMarkup(
      <AgentPermissionDialogBody
        request={permissionRequest()}
        remainingSeconds={60}
        onAction={vi.fn()}
      />,
    )

    expect(html).toContain("Agent needs permission")
    expect(html).toContain("Shell command")
    expect(html).toContain("Claude wants to run a shell command.")
    expect(html).toContain("/tmp/blocked")
    expect(html).toContain("Allow Temporary")
    expect(html).toContain("Deny + Interrupt")
  })

  it("does not render the host when there is no active request", () => {
    useChatStore.setState({
      activeAgentPermissionRequest: null,
      queuedAgentPermissionRequests: [],
    })

    const html = renderToStaticMarkup(<AgentPermissionDialogHost />)

    expect(html).not.toContain("Agent needs permission")
  })
})

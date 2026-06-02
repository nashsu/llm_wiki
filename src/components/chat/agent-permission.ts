import type {
  AgentPermissionDecision,
  AgentPermissionRequestPayload,
} from "@/lib/agent/agent-types"
import { safeStringify } from "./agent-format"

export type AgentPermissionAction =
  | "allow_temporary"
  | "allow_permanent"
  | "deny"
  | "deny_interrupt"

/** Convert a user dialog action into the SDK permission decision shape. */
export function buildAgentPermissionDecision(
  action: AgentPermissionAction,
  payload: AgentPermissionRequestPayload,
): AgentPermissionDecision {
  if (action === "allow_temporary") {
    return {
      behavior: "allow",
      decisionClassification: "user_temporary",
    }
  }
  if (action === "allow_permanent") {
    return {
      behavior: "allow",
      updatedPermissions: payload.suggestions ?? [],
      decisionClassification: "user_permanent",
    }
  }
  const reason = payload.decisionReason ?? "Permission denied"
  return {
    behavior: "deny",
    message: reason,
    reason,
    interrupt: action === "deny_interrupt" ? true : undefined,
    decisionClassification: "user_reject",
  }
}

/** Safely format the permission input preview for the dialog. */
export function formatAgentPermissionInputPreview(value: unknown): string {
  return safeStringify(value)
}

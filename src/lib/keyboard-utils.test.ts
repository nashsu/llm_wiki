import { describe, it, expect } from "vitest"
import { isImeComposing } from "./keyboard-utils"

// Build a minimal stand-in for a React KeyboardEvent. Vitest's jsdom
// environment doesn't fire real composition events, so we synthesize
// the two signals isImeComposing inspects.
function ke(opts: {
  isComposing?: boolean
  keyCode?: number
  key?: string
}): React.KeyboardEvent {
  return {
    key: opts.key ?? "Enter",
    keyCode: opts.keyCode ?? 13,
    nativeEvent: { isComposing: opts.isComposing ?? false } as unknown as KeyboardEvent,
  } as unknown as React.KeyboardEvent
}

describe("isImeComposing", () => {
  it("is false for a plain Enter press with no IME activity", () => {
    expect(isImeComposing(ke({ key: "Enter", keyCode: 13 }))).toBe(false)
  })

  it("is true when the W3C `isComposing` flag is set", () => {
    expect(isImeComposing(ke({ isComposing: true, keyCode: 229 }))).toBe(true)
  })

  it("is true when keyCode === 229 even after isComposing has flipped back", () => {
    // The commit-press itself: Chromium reports keyCode 229 but
    // isComposing has already cleared. Without this branch the
    // commit Enter leaks through as a submit.
    expect(isImeComposing(ke({ isComposing: false, keyCode: 229 }))).toBe(true)
  })

  it("is true for non-Enter keys during composition", () => {
    // Defensive: arrow keys, escape, etc. during composition should
    // also be treated as IME-owned by callers that care.
    expect(isImeComposing(ke({ key: "ArrowDown", isComposing: true, keyCode: 229 }))).toBe(true)
  })

  it("is false for Shift+Enter (no IME)", () => {
    expect(isImeComposing(ke({ key: "Enter", keyCode: 13 }))).toBe(false)
  })
})

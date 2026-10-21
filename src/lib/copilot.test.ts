import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { invoke } from "@tauri-apps/api/core"
import { streamChat } from "./llm-client"
import { getProviderConfig } from "./llm-providers"
import { hasUsableLlm } from "./has-usable-llm"
import { useCopilotSession, refreshCopilotSession, signInCopilot, signOutCopilot, cancelCopilotSignIn } from "./copilot-session"
import { findLlmPreset } from "@/components/settings/llm-presets"
import { resolveConfig } from "@/components/settings/preset-resolver"
import { resolveTaskLlmConfig, resolveProjectLlmConfig } from "./llm-task-routing"
import { testLlmConnection } from "./connection-tests"
import type { LlmConfig } from "@/stores/wiki-store"

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }))
vi.mock("./tauri-fetch", () => ({ getHttpFetch: vi.fn(() => { throw new Error("No HTTP allowed") }), isFetchNetworkError: () => false }))
const mockInvoke = vi.mocked(invoke as (command: string, args?: Record<string, unknown>) => Promise<unknown>)
const cfg: LlmConfig = { provider: "copilot", model: "gpt-4.1-mini", apiKey: "mock-unused", customEndpoint: "https://unused.invalid", customHeaders: { Authorization: "mock-unused" }, ollamaUrl: "", maxContextSize: 32768 }
const catalog = [{ id: "gpt-4.1-mini", name: "GPT 4.1 mini" }]
function callbacks() { return { onToken: vi.fn(), onDone: vi.fn(), onError: vi.fn() } }
function deferred<T>() { let resolve!: (v: T) => void; let reject!: (e: Error) => void; const promise = new Promise<T>((a,b) => { resolve = a; reject = b }); return { promise, resolve, reject } }

beforeEach(() => {
  mockInvoke.mockReset()
  cancelCopilotSignIn()
  useCopilotSession.setState({ authenticated: false, models: [], flow: null, busy: false, error: null })
  mockInvoke.mockImplementation(async (command) => {
    if (command === "copilot_auth_status") return { authenticated: true }
    if (command === "copilot_models") return catalog
    if (command === "copilot_complete") return { content: "Hello", finishReason: "stop" }
    return undefined
  })
})
afterEach(() => { cancelCopilotSignIn(); vi.useRealTimers() })

describe("Copilot preset and routing", () => {
  it("clears credentials, endpoints, headers and forces buffered text transport", () => {
    const preset = findLlmPreset("github-copilot")!
    const resolved = resolveConfig(preset, { apiKey: "mock-unused", customHeaders: cfg.customHeaders, baseUrl: cfg.customEndpoint }, cfg)
    expect(resolved).toMatchObject({ provider: "copilot", model: "gpt-4.1-mini", apiKey: "", customEndpoint: "", streamingEnabled: false })
    expect(resolved.customHeaders).toBeUndefined()
    expect(() => getProviderConfig(resolved)).toThrow(/IPC/)
  })
  it("uses one saved model for both task routes and project overrides", () => {
    const configs = { "github-copilot": { model: "gpt-4.1-mini" } }
    const routing = { chatPresetId: "github-copilot", ingestPresetId: "github-copilot" }
    for (const task of ["chat", "ingest"] as const) expect(resolveTaskLlmConfig(task, cfg, configs, routing)).toMatchObject({ provider: "copilot", model: "gpt-4.1-mini", apiKey: "" })
    expect(resolveProjectLlmConfig(cfg, configs, { enabled: true, presetId: "github-copilot", model: "" })).toMatchObject({ provider: "copilot", model: "gpt-4.1-mini", apiKey: "" })
  })
})

describe("Copilot IPC dispatch", () => {
  it("refuses unauthenticated completions even if a legacy config contains a key", async () => {
    mockInvoke.mockResolvedValue({ authenticated: false })
    const cb = callbacks(); await streamChat(cfg, [], cb)
    expect(cb.onError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringMatching(/Sign in/) }))
    expect(invoke).not.toHaveBeenCalledWith("copilot_complete", expect.anything())
    expect(hasUsableLlm(cfg)).toBe(false)
  })
  it("rejects models outside the authenticated catalog", async () => {
    const cb = callbacks(); await streamChat({ ...cfg, model: "unavailable-mock" }, [], cb)
    expect(cb.onError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringMatching(/available Copilot/) }))
    expect(invoke).not.toHaveBeenCalledWith("copilot_complete", expect.anything())
  })
  it("flattens text blocks and strips extra runtime message properties", async () => {
    const cb = callbacks()
    await streamChat(cfg, [{ role: "user", content: [{ type: "text", text: "one" }, { type: "text", text: "two" }], ...{ extraSecret: "mock-unused" } }], cb)
    expect(invoke).toHaveBeenCalledWith("copilot_complete", { model: cfg.model, messages: [{ role: "user", content: "one\ntwo" }] })
  })
  it("does not emit done if the token callback itself aborts", async () => {
    const controller = new AbortController(); const cb = callbacks()
    cb.onToken.mockImplementation(() => controller.abort())
    await streamChat(cfg, [], cb, controller.signal)
    expect(cb.onDone).not.toHaveBeenCalled()
  })

  it("sends only allowlisted text fields and emits buffered completion", async () => {
    const cb = callbacks()
    await streamChat(cfg, [{ role: "user", content: "mock prompt" }], cb, undefined, { max_tokens: 128, temperature: 0.1 })
    expect(invoke).toHaveBeenCalledWith("copilot_complete", { model: "gpt-4.1-mini", messages: [{ role: "user", content: "mock prompt" }], maxTokens: 128 })
    expect(cb.onToken).toHaveBeenCalledWith("Hello")
    expect(cb.onDone).toHaveBeenCalledWith({ finishReason: "stop", truncated: false })
    expect(cb.onError).not.toHaveBeenCalled()
  })
  it("covers connection tests through the same IPC path", async () => { expect((await testLlmConnection(cfg)).ok).toBe(true) })
  it("reports token truncation, including empty truncated completions", async () => {
    mockInvoke.mockImplementation(async c => c === "copilot_auth_status" ? { authenticated: true } : c === "copilot_models" ? catalog : { content: "", finishReason: "length" })
    const cb = callbacks(); await streamChat(cfg, [], cb)
    expect(cb.onDone).toHaveBeenCalledWith({ finishReason: "length", truncated: true })
  })
  it("rejects image blocks instead of silently losing user input", async () => {
    const cb = callbacks(); await streamChat(cfg, [{ role: "user", content: [{ type: "image", mediaType: "image/png", dataBase64: "mock" }] }], cb)
    expect(cb.onError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringMatching(/text.only/i) }))
    expect(invoke).not.toHaveBeenCalledWith("copilot_complete", expect.anything())
  })
  it("does not dispatch or emit callbacks when already aborted", async () => {
    const cb = callbacks(); const controller = new AbortController(); controller.abort()
    await streamChat(cfg, [], cb, controller.signal)
    expect(invoke).not.toHaveBeenCalled(); expect(cb.onDone).not.toHaveBeenCalled()
  })
  it("settles promptly on abort and ignores late IPC responses", async () => {
    const request = deferred<{ content: string }>()
    mockInvoke.mockImplementation(async c => c === "copilot_auth_status" ? { authenticated: true } : c === "copilot_models" ? catalog : request.promise)
    const cb = callbacks(); const controller = new AbortController()
    const done = streamChat(cfg, [], cb, controller.signal)
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith("copilot_complete", expect.anything()))
    controller.abort(); await done
    request.resolve({ content: "late" }); await Promise.resolve()
    expect(cb.onToken).not.toHaveBeenCalled(); expect(cb.onDone).not.toHaveBeenCalled(); expect(cb.onError).not.toHaveBeenCalled()
  })
})

describe("Copilot session (never persisted)", () => {
  it("respects slow-down intervals and cancellation suppresses late auth", async () => {
    vi.useFakeTimers()
    const poll = deferred<{ authenticated: boolean; pending: boolean; interval: number }>()
    let polls = 0
    mockInvoke.mockImplementation(async command => {
      if (command === "copilot_auth_start") return { flowId: "flow", userCode: "example-pairing-label", verificationUri: "https://github.com/login/device", interval: 1, expiresIn: 30 }
      if (command === "copilot_auth_poll") return ++polls === 1 ? { authenticated: false, pending: true, interval: 10 } : poll.promise
      return catalog
    })
    const done = signInCopilot(); await vi.advanceTimersByTimeAsync(1000)
    expect(polls).toBe(1)
    await vi.advanceTimersByTimeAsync(9999); expect(polls).toBe(1)
    await vi.advanceTimersByTimeAsync(1); expect(polls).toBe(2)
    cancelCopilotSignIn()
    poll.resolve({ authenticated: true, pending: false, interval: 10 }); await done
    expect(hasUsableLlm(cfg)).toBe(false)
    expect(useCopilotSession.getState().models).toEqual([])
  })
  it("fails closed on status or catalog failures", async () => {
    useCopilotSession.setState({ authenticated: true, models: catalog })
    mockInvoke.mockRejectedValue(new Error("Native session unavailable"))
    await refreshCopilotSession()
    expect(hasUsableLlm(cfg)).toBe(false)
    expect(useCopilotSession.getState().models).toEqual([])
  })

  it("fails closed until native status is verified, and logout clears readiness", async () => {
    expect(hasUsableLlm(cfg)).toBe(false)
    await refreshCopilotSession(); expect(hasUsableLlm(cfg)).toBe(true)
    await signOutCopilot(); expect(hasUsableLlm(cfg)).toBe(false)
    expect(useCopilotSession.getState().models).toEqual([])
  })
  it("never starts device auth while checking status", async () => {
    await refreshCopilotSession()
    expect(invoke).not.toHaveBeenCalledWith("copilot_auth_start")
  })
  it("does not restore auth from an in-flight status response after logout", async () => {
    const status = deferred<{ authenticated: boolean }>()
    mockInvoke.mockImplementation(async c => c === "copilot_auth_status" ? status.promise : undefined)
    const refresh = refreshCopilotSession(); await signOutCopilot(); status.resolve({ authenticated: true }); await refresh
    expect(hasUsableLlm(cfg)).toBe(false)
  })
  it("polls only after explicit sign-in, respects interval and loads catalog", async () => {
    vi.useFakeTimers()
    mockInvoke.mockImplementation(async c => c === "copilot_auth_start" ? { flowId: "flow", userCode: "example-pairing-label", verificationUri: "https://github.com/login/device", interval: 5, expiresIn: 30 } : c === "copilot_auth_poll" ? { authenticated: true, pending: false, interval: 5 } : catalog)
    const done = signInCopilot(); await vi.advanceTimersByTimeAsync(0)
    expect(useCopilotSession.getState().flow?.userCode).toBe("example-pairing-label")
    expect(invoke).not.toHaveBeenCalledWith("copilot_auth_poll", expect.anything())
    await vi.advanceTimersByTimeAsync(5000); await done
    expect(invoke).toHaveBeenCalledWith("copilot_auth_poll", { flowId: "flow" })
    expect(useCopilotSession.getState()).toMatchObject({ authenticated: true, models: catalog, flow: null })
  })
  it("expires without polling after the deadline", async () => {
    vi.useFakeTimers()
    mockInvoke.mockResolvedValue({ flowId: "flow", userCode: "example-pairing-label", verificationUri: "https://github.com/login/device", interval: 5, expiresIn: 2 })
    const done = signInCopilot(); await vi.advanceTimersByTimeAsync(2000); await done
    expect(invoke).not.toHaveBeenCalledWith("copilot_auth_poll", expect.anything())
    expect(useCopilotSession.getState()).toMatchObject({ authenticated: false, flow: null, error: expect.stringMatching(/expired/i) })
  })
})

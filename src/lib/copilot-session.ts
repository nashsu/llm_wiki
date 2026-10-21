import { invoke } from "@tauri-apps/api/core"
import { create } from "zustand"

export interface CopilotModel { id: string; name: string }
export interface CopilotDeviceFlow {
  flowId: string
  userCode: string
  verificationUri: string
  interval: number
  expiresIn: number
}
interface CopilotSession {
  authenticated: boolean
  models: CopilotModel[]
  flow: CopilotDeviceFlow | null
  busy: boolean
  error: string | null
}
// Process memory only: never add persist middleware or write this to project-store.
// Tokens and provider endpoints remain entirely in the native backend.
export const useCopilotSession = create<CopilotSession>(() => ({
  authenticated: false, models: [], flow: null, busy: false, error: null,
}))
let generation = 0
let cancelWait: (() => void) | undefined
const message = (error: unknown) => error instanceof Error ? error.message : String(error)
const intervalMs = (seconds: number) => Math.max(1, Number.isFinite(seconds) ? seconds : 5) * 1000

export function cancelCopilotSignIn() {
  generation++
  cancelWait?.()
  cancelWait = undefined
  useCopilotSession.setState({ flow: null, busy: false })
}

export function clearCopilotReadiness() {
  cancelCopilotSignIn()
  useCopilotSession.setState({ authenticated: false, models: [] })
}

export async function refreshCopilotSession(): Promise<boolean> {
  if (useCopilotSession.getState().busy) return false
  const current = generation
  try {
    const status = await invoke<{ authenticated: boolean }>("copilot_auth_status")
    if (current !== generation) return false
    useCopilotSession.setState({ authenticated: status.authenticated === true, ...(status.authenticated ? {} : { models: [] }) })
    if (status.authenticated) {
      const models = await invoke<CopilotModel[]>("copilot_models")
      if (current !== generation) return false
      useCopilotSession.setState({ models, error: null })
    }
    return status.authenticated === true
  } catch (error) {
    if (current === generation) useCopilotSession.setState({ authenticated: false, models: [], error: message(error) })
    return false
  }
}

function wait(ms: number) {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => { cancelWait = undefined; resolve() }, ms)
    cancelWait = () => { clearTimeout(timer); resolve() }
  })
}

/** Explicit user action only. No browser launch, credential input or persistence. */
export async function signInCopilot(): Promise<void> {
  if (useCopilotSession.getState().busy) return
  clearCopilotReadiness()
  const current = generation
  useCopilotSession.setState({ busy: true, error: null })
  try {
    const flow = await invoke<CopilotDeviceFlow>("copilot_auth_start")
    if (current !== generation) return
    // Show only the official device page, never a backend-supplied executable URL.
    if (flow.verificationUri !== "https://github.com/login/device" || !Number.isFinite(flow.expiresIn) || flow.expiresIn <= 0) {
      throw new Error("Invalid Copilot device sign-in response.")
    }
    useCopilotSession.setState({ flow })
    const deadline = Date.now() + flow.expiresIn * 1000
    let interval = intervalMs(flow.interval)
    while (current === generation) {
      await wait(Math.min(interval, Math.max(0, deadline - Date.now())))
      if (current !== generation) return
      if (Date.now() >= deadline) throw new Error("Copilot sign-in expired. Sign in again.")
      const result = await invoke<{ authenticated: boolean; pending: boolean; interval: number }>("copilot_auth_poll", { flowId: flow.flowId })
      if (current !== generation) return
      if (Date.now() >= deadline) throw new Error("Copilot sign-in expired. Sign in again.")
      if (result.authenticated) {
        const models = await invoke<CopilotModel[]>("copilot_models")
        if (current !== generation) return
        useCopilotSession.setState({ authenticated: true, models, flow: null })
        return
      }
      if (!result.pending) throw new Error("Copilot sign-in was not authorized. Sign in again.")
      interval = intervalMs(result.interval)
    }
  } catch (error) {
    if (current === generation) useCopilotSession.setState({ authenticated: false, models: [], flow: null, error: message(error) })
  } finally {
    if (current === generation) useCopilotSession.setState({ busy: false })
  }
}

export async function signOutCopilot(): Promise<void> {
  clearCopilotReadiness() // Fail closed immediately, even if the native logout fails.
  useCopilotSession.setState({ error: null, busy: true })
  const current = generation
  try { await invoke("copilot_logout") }
  catch (error) { if (current === generation) useCopilotSession.setState({ error: message(error) }) }
  finally { if (current === generation) useCopilotSession.setState({ busy: false }) }
}

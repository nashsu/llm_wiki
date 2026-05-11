import { create } from "zustand"
import type { UpdateStatus } from "@/lib/update-check"

/**
 * UI-side state for the update-check feature. Persistence (user-level
 * "auto check enabled" flag, "dismissed this version" memo, and last-
 * checked timestamp) lives in plugin-store via src/lib/project-store.ts.
 * The store mirrors the persisted values at runtime and lets the UI
 * subscribe to them without awaiting the store read every render.
 */
export interface UpdateStoreState {
  /** True while a check-for-updates HTTP call is in flight. */
  checking: boolean
  /** The most recent result (null if never checked this session). */
  lastResult: UpdateStatus | null
  /** Unix ms timestamp of the last successful (or attempted) check. */
  lastCheckedAt: number | null
  /**
   * Remote version the user clicked "later" on. If the remote version
   * later becomes something different, the "available" UI returns.
   * null = no dismissal active.
   */
  dismissedVersion: string | null
  /** User preference: run the automatic check on app startup. */
  enabled: boolean

  setChecking: (b: boolean) => void
  setResult: (result: UpdateStatus, at: number) => void
  setDismissed: (version: string | null) => void
  setEnabled: (b: boolean) => void
  hydrate: (partial: Partial<UpdateStoreState>) => void
}

export const useUpdateStore = create<UpdateStoreState>((set) => ({
  checking: false,
  lastResult: null,
  lastCheckedAt: null,
  dismissedVersion: null,
  // Kevin's app is maintained as a local fork, so startup should not
  // nag with upstream release banners. Manual checks remain available
  // from Settings -> About when an update review is intentional.
  enabled: false,

  setChecking: (checking) => set({ checking }),
  setResult: (lastResult, lastCheckedAt) =>
    set({ lastResult, lastCheckedAt, checking: false }),
  setDismissed: (dismissedVersion) => set({ dismissedVersion }),
  setEnabled: (enabled) => set({ enabled }),
  hydrate: (partial) => set(partial),
}))

/**
 * Whether an update is available, IGNORING the user's dismiss
 * preference. Used by passive indicators (the red dot on the
 * Settings gear, the red dot next to the About row in Settings)
 * that should keep nudging the user toward the update — those
 * surfaces are the canonical "where do I find this" signposts,
 * not pressure to act NOW.
 *
 * Returns true iff the latest check finished with kind="available".
 */
export function hasAvailableUpdate(state: UpdateStoreState): boolean {
  if (!state.lastResult) return false
  return state.lastResult.kind === "available"
}

/**
 * Whether the FULL banner (with download CTA + dismiss button) at
 * the top of the app should be shown. Stricter than
 * `hasAvailableUpdate`: ALSO suppresses when the user has
 * dismissed this exact version. Re-appears naturally when a newer
 * release ships because `dismissedVersion` no longer matches
 * `result.remote`.
 *
 * Banner = active interruption; dots = passive presence. Splitting
 * the gates lets dismissing the banner stop the interruption
 * without hiding the way to the update.
 */
export function shouldShowUpdateBanner(state: UpdateStoreState): boolean {
  if (!hasAvailableUpdate(state)) return false
  // `hasAvailableUpdate` already proved kind === "available", so we
  // can narrow safely here. Type-narrow inside the branch rather
  // than using `as` so a future refactor of UpdateStatus would
  // catch up the gating logic too.
  if (state.lastResult?.kind !== "available") return false
  if (state.dismissedVersion === state.lastResult.remote) {
    return false
  }
  return true
}

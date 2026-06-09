import { create } from "zustand"

export interface ZoomState {
  /** Current zoom level as a decimal (1 = 100%) */
  level: number
  setLevel: (level: number) => void
}

/**
 * Clamp the zoom level between 0.5 (50%) and 3 (300%).
 */
function clamp(v: number): number {
  return Math.min(3, Math.max(0.5, v))
}

export const useZoomStore = create<ZoomState>((set) => ({
  level: 1,
  setLevel: (level: number) => set({ level: clamp(level) }),
}))

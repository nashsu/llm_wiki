import { create } from "zustand"

export interface ZoomState {
  /** Current zoom level as a decimal (1 = 100%) */
  level: number
  setLevel: (level: number) => void
}

export const DEFAULT_ZOOM_LEVEL = 1
export const MIN_ZOOM_LEVEL = 0.5
export const MAX_ZOOM_LEVEL = 3
export const ZOOM_STEP = 0.05
export const BASE_FONT_SIZE_PX = 16

/**
 * Clamp the zoom level between the configured minimum and maximum.
 */
export function clampZoomLevel(v: number): number {
  return Math.min(MAX_ZOOM_LEVEL, Math.max(MIN_ZOOM_LEVEL, v))
}

export function roundZoomLevel(v: number): number {
  return Math.round(v * 100) / 100
}

export const useZoomStore = create<ZoomState>((set) => ({
  level: DEFAULT_ZOOM_LEVEL,
  setLevel: (level: number) => set({ level: clampZoomLevel(level) }),
}))

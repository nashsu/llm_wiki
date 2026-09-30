import { create } from "zustand"

export const DEFAULT_BACKGROUND_OPACITY = 0.5
export const MIN_BACKGROUND_OPACITY = 0.1
export const MAX_BACKGROUND_OPACITY = 1
export const DEFAULT_BACKGROUND_BRIGHTNESS = 1
export const MIN_BACKGROUND_BRIGHTNESS = 0.4
export const MAX_BACKGROUND_BRIGHTNESS = 1.5
/** Hard cap so a huge wallpaper can't bloat app-state.json (base64 inflates ~33%). */
export const MAX_BACKGROUND_IMAGE_BYTES = 5 * 1024 * 1024

export function clampBackgroundOpacity(v: number): number {
  return Math.min(MAX_BACKGROUND_OPACITY, Math.max(MIN_BACKGROUND_OPACITY, v))
}

export function clampBackgroundBrightness(v: number): number {
  return Math.min(MAX_BACKGROUND_BRIGHTNESS, Math.max(MIN_BACKGROUND_BRIGHTNESS, v))
}

interface BackgroundState {
  /** Background image as a `data:` URL, or null when disabled. */
  imageUrl: string | null
  opacity: number
  brightness: number
  setImage: (imageUrl: string | null) => void
  setOpacity: (opacity: number) => void
  setBrightness: (brightness: number) => void
}

export const useBackgroundStore = create<BackgroundState>((set) => ({
  imageUrl: null,
  opacity: DEFAULT_BACKGROUND_OPACITY,
  brightness: DEFAULT_BACKGROUND_BRIGHTNESS,
  setImage: (imageUrl) => set({ imageUrl }),
  setOpacity: (opacity) => set({ opacity: clampBackgroundOpacity(opacity) }),
  setBrightness: (brightness) => set({ brightness: clampBackgroundBrightness(brightness) }),
}))

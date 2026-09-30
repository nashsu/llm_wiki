import { create } from "zustand"
import { morphWindow, type FloatingMode } from "@/lib/floating"

interface FloatingState {
  mode: FloatingMode
  setMode: (mode: FloatingMode) => void
}

export const useFloatingStore = create<FloatingState>((set) => ({
  mode: "full",
  setMode: (mode) => {
    void morphWindow(mode)
    set({ mode })
  },
}))

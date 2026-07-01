import { create } from "zustand"
import type { FileChangeTask } from "@/commands/file-sync"

interface FileSyncState {
  tasks: FileChangeTask[]
  running: boolean
  lastError: string | null
  setTasks: (tasks: FileChangeTask[]) => void
  setRunning: (running: boolean) => void
  setLastError: (error: string | null) => void
  clear: () => void
}

export const useFileSyncStore = create<FileSyncState>((set) => ({
  tasks: [],
  running: false,
  lastError: null,
  setTasks: (tasks) => set({ tasks }),
  setRunning: (running) => set({ running }),
  setLastError: (lastError) => set({ lastError }),
  clear: () => set({ tasks: [], running: false, lastError: null }),
}))

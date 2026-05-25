import { create } from "zustand"

type DialogButtonVariant = "default" | "destructive"

interface AppAlertOptions {
  title?: string
  message: string
  confirmLabel?: string
  confirmVariant?: DialogButtonVariant
}

interface AppConfirmOptions extends AppAlertOptions {
  cancelLabel?: string
}

interface AlertDialogRequest extends Required<AppAlertOptions> {
  id: number
  kind: "alert"
  resolve: () => void
}

interface ConfirmDialogRequest extends Required<AppConfirmOptions> {
  id: number
  kind: "confirm"
  resolve: (confirmed: boolean) => void
}

export type AppDialogRequest = AlertDialogRequest | ConfirmDialogRequest

interface AppDialogStoreState {
  queue: AppDialogRequest[]
  alert: (options: AppAlertOptions) => Promise<void>
  confirm: (options: AppConfirmOptions) => Promise<boolean>
  dismissCurrent: (confirmed?: boolean) => void
}

let nextDialogId = 1

function buildAlertRequest(
  options: AppAlertOptions,
  resolve: () => void,
): AlertDialogRequest {
  return {
    id: nextDialogId++,
    kind: "alert",
    title: options.title ?? "Notice",
    message: options.message,
    confirmLabel: options.confirmLabel ?? "OK",
    confirmVariant: options.confirmVariant ?? "default",
    resolve,
  }
}

function buildConfirmRequest(
  options: AppConfirmOptions,
  resolve: (confirmed: boolean) => void,
): ConfirmDialogRequest {
  return {
    id: nextDialogId++,
    kind: "confirm",
    title: options.title ?? "Confirm",
    message: options.message,
    confirmLabel: options.confirmLabel ?? "Confirm",
    cancelLabel: options.cancelLabel ?? "Cancel",
    confirmVariant: options.confirmVariant ?? "default",
    resolve,
  }
}

export const useAppDialogStore = create<AppDialogStoreState>((set) => ({
  queue: [],
  alert: (options) =>
    new Promise<void>((resolve) => {
      set((state) => ({
        queue: [...state.queue, buildAlertRequest(options, resolve)],
      }))
    }),
  confirm: (options) =>
    new Promise<boolean>((resolve) => {
      set((state) => ({
        queue: [...state.queue, buildConfirmRequest(options, resolve)],
      }))
    }),
  dismissCurrent: (confirmed = false) => {
    let current: AppDialogRequest | undefined

    set((state) => {
      current = state.queue[0]
      if (!current) return state
      return { queue: state.queue.slice(1) }
    })

    if (!current) return

    if (current.kind === "confirm") {
      current.resolve(confirmed)
      return
    }

    current.resolve()
  },
}))

export function useAppDialog() {
  const alert = useAppDialogStore((s) => s.alert)
  const confirm = useAppDialogStore((s) => s.confirm)

  return { alert, confirm }
}

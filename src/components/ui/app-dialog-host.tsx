import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { useAppDialogStore } from "@/stores/app-dialog-store"

export function AppDialogHost() {
  const dialog = useAppDialogStore((s) => s.queue[0] ?? null)
  const dismissCurrent = useAppDialogStore((s) => s.dismissCurrent)

  return (
    <Dialog
      open={dialog !== null}
      onOpenChange={(open) => {
        if (!open && dialog) dismissCurrent(false)
      }}
    >
      {dialog && (
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>{dialog.title}</DialogTitle>
            <DialogDescription className="whitespace-pre-wrap">
              {dialog.message}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            {dialog.kind === "confirm" && (
              <Button
                variant="outline"
                onClick={() => dismissCurrent(false)}
              >
                {dialog.cancelLabel}
              </Button>
            )}
            <Button
              variant={dialog.confirmVariant}
              onClick={() => dismissCurrent(dialog.kind === "confirm")}
            >
              {dialog.confirmLabel}
            </Button>
          </DialogFooter>
        </DialogContent>
      )}
    </Dialog>
  )
}

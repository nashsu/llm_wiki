import { useEffect, useMemo, useRef, useState } from "react"
import {
  Ban,
  Check,
  ChevronDown,
  Link2Off,
  Loader2,
  RefreshCw,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import type { AutoLinkReviewResult } from "@/lib/auto-link-review"
import {
  countSuggestionsByBand,
  createInitialAutoLinkSelection,
  selectedLinksFromState,
  setSuggestionSelected,
  setSuggestionTarget,
  type AutoLinkSelectionState,
} from "@/lib/auto-link-review-state"
import type {
  AutoLinkSuggestion,
  ConfidenceBand,
  LinkEntry,
} from "@/lib/auto-link-types"

interface AutoLinkReviewDialogProps {
  open: boolean
  result: AutoLinkReviewResult | null
  loading: boolean
  applying: boolean
  applyError: string | null
  onOpenChange: (open: boolean) => void
  onRetry: () => void
  onApply: (links: LinkEntry[]) => Promise<void> | void
  onIgnoreTerm: (term: string) => Promise<void> | void
  onIgnorePair: (term: string, target: string) => Promise<void> | void
}

const EMPTY_SELECTION: AutoLinkSelectionState = {
  selectedIds: new Set(),
  selectedTargets: {},
  lowExpanded: false,
}

export function AutoLinkReviewDialog({
  open,
  result,
  loading,
  applying,
  applyError,
  onOpenChange,
  onRetry,
  onApply,
  onIgnoreTerm,
  onIgnorePair,
}: AutoLinkReviewDialogProps) {
  const [selection, setSelection] = useState<AutoLinkSelectionState>(
    EMPTY_SELECTION,
  )
  const [pendingIgnore, setPendingIgnore] = useState<string | null>(null)
  const previousSuggestions = useRef<AutoLinkSuggestion[] | null>(null)

  useEffect(() => {
    if (!open) {
      previousSuggestions.current = null
      setSelection(EMPTY_SELECTION)
      setPendingIgnore(null)
      return
    }
    if (result?.status !== "ready") {
      previousSuggestions.current = null
      return
    }

    const nextSuggestions = result.suggestions
    setSelection((current) => {
      if (previousSuggestions.current === null) {
        return createInitialAutoLinkSelection(nextSuggestions)
      }

      const previousIds = new Set(
        previousSuggestions.current.map((suggestion) => suggestion.id),
      )
      const selectedIds = new Set<string>()
      const selectedTargets: Record<string, string> = {}
      for (const suggestion of nextSuggestions) {
        const currentTarget = current.selectedTargets[suggestion.id]
        const targetStillExists = suggestion.alternatives.some(
          (alternative) => alternative.target === currentTarget,
        )
        selectedTargets[suggestion.id] = targetStillExists
          ? currentTarget
          : suggestion.selectedTarget
        if (
          current.selectedIds.has(suggestion.id) ||
          (!previousIds.has(suggestion.id) && suggestion.selectedByDefault)
        ) {
          selectedIds.add(suggestion.id)
        }
      }
      return { ...current, selectedIds, selectedTargets }
    })
    previousSuggestions.current = nextSuggestions
  }, [open, result])

  const suggestions = result?.status === "ready" ? result.suggestions : []
  const counts = useMemo(
    () => countSuggestionsByBand(suggestions),
    [suggestions],
  )
  const selectedLinks = useMemo(
    () => selectedLinksFromState(suggestions, selection),
    [selection, suggestions],
  )

  const handleIgnoreTerm = async (suggestion: AutoLinkSuggestion) => {
    const key = `term:${suggestion.id}`
    setPendingIgnore(key)
    try {
      await onIgnoreTerm(suggestion.term)
    } finally {
      setPendingIgnore(null)
    }
  }

  const handleIgnorePair = async (suggestion: AutoLinkSuggestion) => {
    const target = selection.selectedTargets[suggestion.id]
      ?? suggestion.selectedTarget
    const key = `pair:${suggestion.id}:${target}`
    setPendingIgnore(key)
    try {
      await onIgnorePair(suggestion.term, target)
    } finally {
      setPendingIgnore(null)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[88vh] sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Auto Link Review</DialogTitle>
          <DialogDescription>
            {result?.status === "ready"
              ? `${suggestions.length} suggestions: ${counts.high} High, ${counts.medium} Medium, ${counts.low} Low.`
              : "Review link suggestions for the current wiki page."}
          </DialogDescription>
        </DialogHeader>

        {loading || result === null ? (
          <div className="flex min-h-40 items-center justify-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            Scanning page
          </div>
        ) : result.status !== "ready" ? (
          <EmptyState result={result} onRetry={onRetry} />
        ) : (
          <>
            <ScrollArea className="h-[min(60vh,34rem)] pr-3">
              <TooltipProvider delay={300}>
                <div className="space-y-5 pb-2">
                  <SuggestionSection
                    title="High confidence"
                    band="high"
                    suggestions={suggestions}
                    selection={selection}
                    pendingIgnore={pendingIgnore}
                    onSelectionChange={setSelection}
                    onIgnoreTerm={handleIgnoreTerm}
                    onIgnorePair={handleIgnorePair}
                  />
                  <SuggestionSection
                    title="Medium confidence"
                    band="medium"
                    suggestions={suggestions}
                    selection={selection}
                    pendingIgnore={pendingIgnore}
                    onSelectionChange={setSelection}
                    onIgnoreTerm={handleIgnoreTerm}
                    onIgnorePair={handleIgnorePair}
                  />
                  {counts.low > 0 && (
                    <details
                      open={selection.lowExpanded}
                      onToggle={(event) => {
                        const lowExpanded = event.currentTarget.open
                        setSelection((current) => ({
                          ...current,
                          lowExpanded,
                        }))
                      }}
                      className="group border-t pt-4"
                    >
                      <summary className="flex cursor-pointer list-none items-center gap-2 text-xs font-semibold text-muted-foreground">
                        <ChevronDown className="size-3.5 transition-transform group-open:rotate-180" />
                        Low confidence ({counts.low})
                      </summary>
                      <div className="mt-3">
                        <SuggestionRows
                          band="low"
                          suggestions={suggestions}
                          selection={selection}
                          pendingIgnore={pendingIgnore}
                          onSelectionChange={setSelection}
                          onIgnoreTerm={handleIgnoreTerm}
                          onIgnorePair={handleIgnorePair}
                        />
                      </div>
                    </details>
                  )}
                </div>
              </TooltipProvider>
            </ScrollArea>

            {applyError && (
              <p className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
                {applyError}
              </p>
            )}

            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => onOpenChange(false)}
                disabled={applying}
              >
                Cancel
              </Button>
              <Button
                onClick={() => void onApply(selectedLinks)}
                disabled={applying || selectedLinks.length === 0}
              >
                {applying ? (
                  <Loader2 className="animate-spin" />
                ) : (
                  <Check />
                )}
                Apply Selected ({selectedLinks.length})
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

function EmptyState({
  result,
  onRetry,
}: {
  result: Exclude<AutoLinkReviewResult, { status: "ready" }>
  onRetry: () => void
}) {
  const retryable = result.status === "error" || result.status === "none"
  return (
    <div className="flex min-h-40 flex-col items-center justify-center gap-3 text-center">
      <p className={
        result.status === "error"
          ? "text-sm text-destructive"
          : "text-sm text-muted-foreground"
      }>
        {result.message}
      </p>
      {retryable && (
        <Button variant="outline" size="sm" onClick={onRetry}>
          <RefreshCw />
          Retry
        </Button>
      )}
    </div>
  )
}

interface SuggestionRowsProps {
  band: ConfidenceBand
  suggestions: AutoLinkSuggestion[]
  selection: AutoLinkSelectionState
  pendingIgnore: string | null
  onSelectionChange: React.Dispatch<React.SetStateAction<AutoLinkSelectionState>>
  onIgnoreTerm: (suggestion: AutoLinkSuggestion) => Promise<void>
  onIgnorePair: (suggestion: AutoLinkSuggestion) => Promise<void>
}

function SuggestionSection({
  title,
  ...props
}: SuggestionRowsProps & { title: string }) {
  if (!props.suggestions.some((suggestion) => suggestion.band === props.band)) {
    return null
  }
  return (
    <section>
      <h3 className="mb-2 text-xs font-semibold text-muted-foreground">
        {title}
      </h3>
      <SuggestionRows {...props} />
    </section>
  )
}

function SuggestionRows({
  band,
  suggestions,
  selection,
  pendingIgnore,
  onSelectionChange,
  onIgnoreTerm,
  onIgnorePair,
}: SuggestionRowsProps) {
  return (
    <div className="divide-y rounded-md border">
      {suggestions
        .filter((suggestion) => suggestion.band === band)
        .map((suggestion, index) => {
          const selected = selection.selectedIds.has(suggestion.id)
          const selectedTarget = selection.selectedTargets[suggestion.id]
            ?? suggestion.selectedTarget
          const selectedAlternative = suggestion.alternatives.find(
            (alternative) => alternative.target === selectedTarget,
          ) ?? suggestion.alternatives[0]
          const checkboxId = `auto-link-${band}-${index}`
          const termPending = pendingIgnore === `term:${suggestion.id}`
          const pairPending = pendingIgnore
            === `pair:${suggestion.id}:${selectedTarget}`

          return (
            <div key={suggestion.id} className="flex gap-3 px-3 py-3">
              <input
                id={checkboxId}
                type="checkbox"
                checked={selected}
                onChange={(event) => {
                  onSelectionChange((current) =>
                    setSuggestionSelected(
                      current,
                      suggestion.id,
                      event.target.checked,
                    ),
                  )
                }}
                className="mt-1 size-4 shrink-0 accent-primary"
              />
              <div className="min-w-0 flex-1 space-y-2">
                <div className="flex min-w-0 items-center gap-2">
                  <label
                    htmlFor={checkboxId}
                    className="truncate text-sm font-medium"
                    title={suggestion.term}
                  >
                    {suggestion.term}
                  </label>
                  <BandBadge band={band} />
                </div>

                <div className="flex min-w-0 items-center gap-2">
                  {suggestion.alternatives.length > 1 ? (
                    <select
                      value={selectedTarget}
                      onChange={(event) => {
                        onSelectionChange((current) =>
                          setSuggestionTarget(
                            current,
                            suggestion.id,
                            event.target.value,
                          ),
                        )
                      }}
                      className="h-8 min-w-0 flex-1 rounded-md border bg-background px-2 text-xs outline-none focus:ring-2 focus:ring-ring"
                    >
                      {suggestion.alternatives.map((alternative) => (
                        <option
                          key={`${alternative.target}\u0000${alternative.path}`}
                          value={alternative.target}
                        >
                          {alternative.title || alternative.target}
                          {alternative.title !== alternative.target
                            ? ` (${alternative.target})`
                            : ""}
                          {alternative.target === suggestion.preferredTarget
                            ? " - LLM suggests"
                            : ""}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <span className="min-w-0 flex-1 truncate text-xs" title={selectedTarget}>
                      {selectedAlternative?.title || selectedTarget}
                    </span>
                  )}
                  {selectedTarget === suggestion.preferredTarget && (
                    <span className="shrink-0 rounded-sm bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                      LLM suggests
                    </span>
                  )}
                </div>

                <p className="text-xs text-muted-foreground">
                  {selectedAlternative?.reason ?? suggestion.reason}
                </p>
              </div>

              <div className="flex shrink-0 items-start gap-1">
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        aria-label={`Ignore term ${suggestion.term}`}
                        disabled={pendingIgnore !== null}
                        onClick={() => void onIgnoreTerm(suggestion)}
                      />
                    }
                  >
                    {termPending ? <Loader2 className="animate-spin" /> : <Ban />}
                  </TooltipTrigger>
                  <TooltipContent>Ignore this term</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        aria-label={`Ignore ${suggestion.term} to ${selectedTarget}`}
                        disabled={pendingIgnore !== null}
                        onClick={() => void onIgnorePair(suggestion)}
                      />
                    }
                  >
                    {pairPending ? (
                      <Loader2 className="animate-spin" />
                    ) : (
                      <Link2Off />
                    )}
                  </TooltipTrigger>
                  <TooltipContent>Ignore this term-target pair</TooltipContent>
                </Tooltip>
              </div>
            </div>
          )
        })}
    </div>
  )
}

function BandBadge({ band }: { band: ConfidenceBand }) {
  const styles: Record<ConfidenceBand, string> = {
    high: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
    medium: "bg-amber-500/10 text-amber-700 dark:text-amber-300",
    low: "bg-muted text-muted-foreground",
  }
  return (
    <span className={`shrink-0 rounded-sm px-1.5 py-0.5 text-[10px] ${styles[band]}`}>
      {band[0].toUpperCase() + band.slice(1)}
    </span>
  )
}

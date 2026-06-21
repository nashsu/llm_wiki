import type {
  AutoLinkSuggestion,
  ConfidenceBand,
  LinkEntry,
} from "./auto-link-types"

export interface AutoLinkSelectionState {
  selectedIds: Set<string>
  selectedTargets: Record<string, string>
  lowExpanded: boolean
}

export function shouldAllowAutoLinkOpenChange(
  nextOpen: boolean,
  applying: boolean,
): boolean {
  return nextOpen || !applying
}

export function isAutoLinkReviewInteractionBusy(
  applying: boolean,
  pendingIgnore: string | null,
): boolean {
  return applying || pendingIgnore !== null
}

export function createInitialAutoLinkSelection(
  suggestions: AutoLinkSuggestion[],
): AutoLinkSelectionState {
  return {
    selectedIds: new Set(
      suggestions
        .filter((suggestion) => suggestion.selectedByDefault)
        .map((suggestion) => suggestion.id),
    ),
    selectedTargets: Object.fromEntries(
      suggestions.map((suggestion) => [
        suggestion.id,
        suggestion.selectedTarget,
      ]),
    ),
    lowExpanded: false,
  }
}

export function setSuggestionSelected(
  state: AutoLinkSelectionState,
  suggestionId: string,
  selected: boolean,
): AutoLinkSelectionState {
  const selectedIds = new Set(state.selectedIds)
  if (selected) selectedIds.add(suggestionId)
  else selectedIds.delete(suggestionId)
  return { ...state, selectedIds }
}

export function setSuggestionTarget(
  state: AutoLinkSelectionState,
  suggestionId: string,
  target: string,
): AutoLinkSelectionState {
  return {
    ...state,
    selectedTargets: {
      ...state.selectedTargets,
      [suggestionId]: target,
    },
  }
}

export function selectedLinksFromState(
  suggestions: AutoLinkSuggestion[],
  state: AutoLinkSelectionState,
): LinkEntry[] {
  return suggestions.flatMap((suggestion): LinkEntry[] => {
    if (!state.selectedIds.has(suggestion.id)) return []
    const requestedTarget = state.selectedTargets[suggestion.id]
    const selectedTarget = suggestion.alternatives.some(
      (alternative) => alternative.target === requestedTarget,
    )
      ? requestedTarget
      : suggestion.selectedTarget
    return [{ term: suggestion.term, target: selectedTarget }]
  })
}

export function countSuggestionsByBand(
  suggestions: AutoLinkSuggestion[],
): Record<ConfidenceBand, number> {
  const counts: Record<ConfidenceBand, number> = {
    high: 0,
    medium: 0,
    low: 0,
  }
  for (const suggestion of suggestions) counts[suggestion.band]++
  return counts
}

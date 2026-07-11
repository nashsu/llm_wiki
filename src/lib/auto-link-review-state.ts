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

export interface AutoLinkSuggestionGroup {
  target: string
  primary: AutoLinkSuggestion
  suggestions: AutoLinkSuggestion[]
  band: ConfidenceBand
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
  return groupAutoLinkSuggestionsByTarget(suggestions, state).flatMap(
    (group): LinkEntry[] => {
      if (!group.suggestions.some((item) => state.selectedIds.has(item.id))) {
        return []
      }
      const terms = [...new Set(group.suggestions.map((item) => item.term))]
      return [{
        term: terms[0],
        target: group.target,
        ...(terms.length > 1 ? { alternativeTerms: terms.slice(1) } : {}),
      }]
    },
  )
}

export function groupAutoLinkSuggestionsByTarget(
  suggestions: AutoLinkSuggestion[],
  state: AutoLinkSelectionState,
): AutoLinkSuggestionGroup[] {
  const groups = new Map<string, AutoLinkSuggestionGroup>()
  for (const suggestion of suggestions) {
    const target = resolvedSuggestionTarget(suggestion, state)
    const key = target.toLowerCase()
    const group = groups.get(key)
    if (group) {
      group.suggestions.push(suggestion)
    } else {
      groups.set(key, {
        target,
        primary: suggestion,
        suggestions: [suggestion],
        band: suggestion.band,
      })
    }
  }
  return [...groups.values()]
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

function resolvedSuggestionTarget(
  suggestion: AutoLinkSuggestion,
  state: AutoLinkSelectionState,
): string {
  const requestedTarget = state.selectedTargets[suggestion.id]
  return suggestion.alternatives.some(
    (alternative) => alternative.target === requestedTarget,
  )
    ? requestedTarget
    : suggestion.selectedTarget
}

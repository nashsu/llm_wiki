/**
 * High-level workflow presets that configure the entire app for common use cases.
 *
 * Unlike LLM provider presets (which set up API endpoints), workflow presets
 * adjust prompt templates, analysis depth, and page types to match the user's
 * primary workflow.
 */

export interface WorkflowPreset {
  /** Stable id used as the persisted key. */
  id: string
  /** i18n key for the display label. */
  labelKey: string
  /** i18n key for the short description. */
  descriptionKey: string
  /** Which built-in prompt template to activate (null = default behavior). */
  activePromptTemplate: string | null
  /** How thorough the analysis pipeline should be. */
  ingestDepth: "full" | "balanced" | "quick"
  /** Default page type for new wiki pages. */
  defaultPageType: string
}

export const WORKFLOW_PRESETS: WorkflowPreset[] = [
  {
    id: "academic-research",
    labelKey: "settings.sections.workflow.presets.academicResearch.label",
    descriptionKey: "settings.sections.workflow.presets.academicResearch.description",
    activePromptTemplate: "academic",
    ingestDepth: "full",
    defaultPageType: "entity",
  },
  {
    id: "daily-notes",
    labelKey: "settings.sections.workflow.presets.dailyNotes.label",
    descriptionKey: "settings.sections.workflow.presets.dailyNotes.description",
    activePromptTemplate: "concise",
    ingestDepth: "quick",
    defaultPageType: "query",
  },
  {
    id: "team-knowledge-base",
    labelKey: "settings.sections.workflow.presets.teamKnowledgeBase.label",
    descriptionKey: "settings.sections.workflow.presets.teamKnowledgeBase.description",
    activePromptTemplate: "default",
    ingestDepth: "balanced",
    defaultPageType: "concept",
  },
]

export function getWorkflowPreset(id: string): WorkflowPreset | undefined {
  return WORKFLOW_PRESETS.find((p) => p.id === id)
}

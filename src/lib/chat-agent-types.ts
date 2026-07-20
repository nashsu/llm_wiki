/**
 * UI-facing Agent metadata types.
 *
 * The Agent execution engine lives in Rust (`src-tauri/src/agent`). Keep this
 * file intentionally limited to display/persistence shapes used by the React UI.
 * Do not reintroduce routing, retrieval, tool execution, or prompt-building
 * logic here; those belong in the Rust Agent runtime so API, MCP, and UI callers
 * share one backend behavior.
 */

export type ChatAgentEventStage =
  | "understanding"
  | "routing"
  | "tool_call"
  | "tool_result"
  | "searching_wiki"
  | "searching_graph"
  | "searching_web"
  | "searching_anytxt"
  | "reading_context"
  | "writing"

export interface ChatAgentEvent {
  stage: ChatAgentEventStage
  query?: string
  tool?: ChatAgentToolName
  message?: string
  count?: number
  status?: "running" | "success" | "error" | "skipped"
  timestamp?: number
}

export type ChatAgentMode = "fast" | "standard" | "deep" | "local_first"
export type ChatRetrievalMode = "standard" | "smart"

export type ChatAgentToolName =
  | "project_files"
  | "project_file_read"
  | "wiki_search"
  | "graph_search"
  | "web_search"
  | "anytxt_search"
  | "shell_exec"
  | "unknown_tool"

export interface ChatUserInputOption {
  label: string
  value: string
  description?: string
  recommended?: boolean
}

export type ChatUserInputFieldType = "single" | "multi" | "text" | "textarea" | "confirm"

export interface ChatUserInputField {
  id: string
  type: ChatUserInputFieldType
  label: string
  description?: string
  placeholder?: string
  options?: ChatUserInputOption[]
  defaultValue?: unknown
}

export interface ChatUserInputRequest {
  requestId: string
  title: string
  description?: string
  fields: ChatUserInputField[]
}

export interface ChatAgentStep {
  id: string
  type: "understanding" | "routing" | "tool_call" | "tool_result" | "final"
  tool?: ChatAgentToolName
  query?: string
  message?: string
  count?: number
  status?: "running" | "success" | "error" | "skipped"
  timestamp?: number
}

export interface ChatAgentFileChange {
  id: string
  path: string
  tool: string
  operation: "created" | "modified"
  additions: number
  deletions: number
  diff: string
  timestamp: number
  /** Runtime-only rollback snapshot. It is deliberately removed by persist.ts. */
  beforeContent?: string | null
  /** Runtime-only post-write snapshot used to reject stale or unsafe undo. */
  afterContent?: string
}

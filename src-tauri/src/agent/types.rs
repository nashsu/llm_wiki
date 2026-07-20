use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AgentMode {
    Fast,
    Standard,
    Deep,
    LocalFirst,
}

impl Default for AgentMode {
    fn default() -> Self {
        Self::Standard
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AgentRetrievalMode {
    // Preserve the established single-pass/planner-driven retrieval behavior.
    Standard,
    // Let the Agent iteratively close evidence gaps under a strict retrieval
    // budget and no-progress guard.
    Smart,
}

impl Default for AgentRetrievalMode {
    fn default() -> Self {
        Self::Standard
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentToolOptions {
    #[serde(default = "default_true")]
    pub wiki: bool,
    #[serde(default)]
    pub web: bool,
    #[serde(default)]
    pub anytxt: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentUsage {
    pub prompt_chars: usize,
    pub completion_chars: usize,
    pub reference_count: usize,
    pub tool_event_count: usize,
}

const fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AgentSkillMode {
    // Enabled skills are available as a candidate set. The model may choose
    // which one, if any, fits the request.
    Auto,
    // The user explicitly selected these skills for the turn. The runtime
    // should narrow skill context to this set and tell the model to apply it.
    Explicit,
}

impl Default for AgentSkillMode {
    fn default() -> Self {
        Self::Explicit
    }
}

impl Default for AgentToolOptions {
    fn default() -> Self {
        Self {
            wiki: true,
            web: false,
            anytxt: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentChatRequest {
    pub message: String,
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub run_id: Option<String>,
    #[serde(default)]
    pub mode: AgentMode,
    #[serde(default)]
    pub retrieval_mode: AgentRetrievalMode,
    #[serde(default)]
    pub tools: AgentToolOptions,
    #[serde(default)]
    pub top_k: Option<usize>,
    #[serde(default)]
    pub include_content: Option<bool>,
    #[serde(default)]
    pub history: Vec<AgentConversationMessage>,
    // UI/API callers set this when they intentionally supplied the history
    // field, including an empty array for a brand-new conversation. Without
    // this guard the Tauri command cannot distinguish "no history sent" from
    // "explicitly empty history" and may hydrate stale persisted session
    // messages into a new chat.
    #[serde(default)]
    pub history_explicit: bool,
    #[serde(default)]
    pub skills: Vec<String>,
    // Explicit project-relative files selected by the user in the chat
    // composer. The context loader re-validates project containment and applies
    // strict count/character budgets; callers cannot use this as an arbitrary
    // filesystem read channel.
    #[serde(default)]
    pub context_files: Vec<String>,
    #[serde(default)]
    pub skill_mode: AgentSkillMode,
    // Security boundary: these commands must come from an explicit trusted
    // user approval flow, never from model output, persisted chat content, or
    // skill instructions. Runtime approval uses an exact trimmed string match.
    #[serde(default)]
    pub approved_shell_commands: Vec<String>,
    // Optional command replayed from a prior approval prompt. This must still
    // appear in approved_shell_commands before the runtime will execute it.
    #[serde(default)]
    pub shell_command: Option<String>,
    #[serde(default)]
    pub images: Vec<AgentImage>,
    #[serde(default)]
    pub stream: Option<bool>,
    #[serde(default = "default_true")]
    pub persist_session: bool,
}

impl Default for AgentChatRequest {
    fn default() -> Self {
        Self {
            message: String::new(),
            session_id: None,
            run_id: None,
            mode: AgentMode::default(),
            retrieval_mode: AgentRetrievalMode::default(),
            tools: AgentToolOptions::default(),
            top_k: None,
            include_content: None,
            history: Vec::new(),
            history_explicit: false,
            skills: Vec::new(),
            context_files: Vec::new(),
            skill_mode: AgentSkillMode::default(),
            approved_shell_commands: Vec::new(),
            shell_command: None,
            images: Vec::new(),
            stream: None,
            persist_session: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentImage {
    pub media_type: String,
    pub data_base64: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentReference {
    pub title: String,
    pub path: String,
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub snippet: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub score: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub knowledge_context: Option<AgentKnowledgeContext>,
}

/// Lightweight graph and provenance briefing attached to wiki retrievals.
/// Keep this bounded: the complete page body is already available through the
/// read/search result and duplicating an unbounded graph would waste context.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentKnowledgeContext {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub related_to: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tags: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub outgoing_links: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub backlinks: Vec<String>,
    pub link_count: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub latest_version: Option<AgentVersionSummary>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentVersionSummary {
    pub timestamp: i64,
    pub author: String,
    pub tool: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentToolEvent {
    pub tool: String,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentUserInputOption {
    pub label: String,
    pub value: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recommended: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentUserInputField {
    pub id: String,
    #[serde(rename = "type")]
    pub field_type: String,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub placeholder: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub options: Vec<AgentUserInputOption>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_value: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentUserInputRequest {
    pub request_id: String,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub fields: Vec<AgentUserInputField>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentChatResponse {
    pub ok: bool,
    pub project_id: String,
    pub session_id: String,
    pub mode: AgentMode,
    pub message: String,
    pub references: Vec<AgentReference>,
    pub tool_events: Vec<AgentToolEvent>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub events: Vec<super::events::AgentEvent>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_input_request: Option<AgentUserInputRequest>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage: Option<AgentUsage>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentConversationMessage {
    pub role: String,
    pub content: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chat_request_accepts_camelcase_api_shape_with_defaults() {
        let req: AgentChatRequest = serde_json::from_value(serde_json::json!({
            "message": "hello",
            "sessionId": "s1",
            "topK": 7,
            "contextFiles": ["wiki/page.md"]
        }))
        .unwrap();

        assert_eq!(req.message, "hello");
        assert_eq!(req.session_id.as_deref(), Some("s1"));
        assert!(req.run_id.is_none());
        assert_eq!(req.mode, AgentMode::Standard);
        assert_eq!(req.retrieval_mode, AgentRetrievalMode::Standard);
        assert_eq!(req.top_k, Some(7));
        assert_eq!(req.context_files, vec!["wiki/page.md".to_string()]);
        assert_eq!(req.skill_mode, AgentSkillMode::Explicit);
        assert!(req.tools.wiki);
        assert!(!req.tools.web);
        assert!(!req.tools.anytxt);
        assert!(req.persist_session);
    }

    #[test]
    fn chat_request_accepts_tool_overrides() {
        let req: AgentChatRequest = serde_json::from_value(serde_json::json!({
            "message": "hello",
            "mode": "local_first",
            "retrievalMode": "smart",
            "tools": {
                "wiki": false,
                "web": true,
                "anytxt": true
            }
        }))
        .unwrap();

        assert_eq!(req.mode, AgentMode::LocalFirst);
        assert_eq!(req.retrieval_mode, AgentRetrievalMode::Smart);
        assert!(!req.tools.wiki);
        assert!(req.tools.web);
        assert!(req.tools.anytxt);
        assert!(req.images.is_empty());
    }

    #[test]
    fn chat_request_accepts_explicit_empty_history_marker() {
        let req: AgentChatRequest = serde_json::from_value(serde_json::json!({
            "message": "hello",
            "history": [],
            "historyExplicit": true
        }))
        .unwrap();

        assert!(req.history.is_empty());
        assert!(req.history_explicit);
    }

    #[test]
    fn chat_request_accepts_auto_skill_mode() {
        let req: AgentChatRequest = serde_json::from_value(serde_json::json!({
            "message": "hello",
            "skills": ["reviewer"],
            "skillMode": "auto"
        }))
        .unwrap();

        assert_eq!(req.skills, vec!["reviewer".to_string()]);
        assert_eq!(req.skill_mode, AgentSkillMode::Auto);
    }
}

use serde::{Deserialize, Serialize};

use super::types::{AgentReference, AgentUserInputRequest};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum AgentEvent {
    AgentStart {
        session_id: String,
    },
    TurnStart {
        mode: String,
    },
    ToolStart {
        tool: String,
        input: Option<String>,
    },
    ToolEnd {
        tool: String,
        output: Option<String>,
    },
    ReferenceAdded {
        reference: AgentReference,
    },
    MessageDelta {
        text: String,
    },
    Error {
        message: String,
    },
    UserInputRequired {
        request: AgentUserInputRequest,
    },
    Done {
        session_id: String,
    },
}

impl AgentEvent {
    pub fn tool_start(tool: impl Into<String>, input: Option<String>) -> Self {
        Self::ToolStart {
            tool: tool.into(),
            input,
        }
    }

    pub fn tool_end(tool: impl Into<String>, output: Option<String>) -> Self {
        Self::ToolEnd {
            tool: tool.into(),
            output,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn agent_event_serializes_with_camelcase_tag() {
        let value = serde_json::to_value(AgentEvent::ToolStart {
            tool: "wiki.search".to_string(),
            input: Some("query".to_string()),
        })
        .unwrap();

        assert_eq!(value["type"], "toolStart");
        assert_eq!(value["tool"], "wiki.search");
        assert_eq!(value["input"], "query");
    }
}

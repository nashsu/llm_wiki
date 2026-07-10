use serde::{Deserialize, Serialize};

use super::types::{AgentMode, AgentToolOptions};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum QueryIntent {
    NeedsInternalSearch,
    NeedsExternalSearch,
    NeedsRawSourceSearch,
    NeedsGraph,
    NeedsWrite,
    SimpleConversational,
    Ambiguous,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RouterDecision {
    pub intent: QueryIntent,
    // Compatibility field for existing API/debug consumers. The router no
    // longer turns this on from message shape; wiki retrieval is selected by
    // the model planner, with a runtime fallback only when the planner is not
    // available.
    pub should_search_wiki: bool,
    pub should_hint_web: bool,
    pub should_hint_anytxt: bool,
    pub should_include_sources: bool,
    pub rationale: String,
}

pub fn route_query(message: &str, mode: AgentMode, tools: &AgentToolOptions) -> RouterDecision {
    let lower = message.to_lowercase();
    let trimmed = message.trim();
    let explicit_web = contains_any(
        &lower,
        &[
            "web search",
            "search the web",
            "internet",
            "online",
            "latest",
            "today",
            "新闻",
            "联网",
            "网上",
            "最新",
        ],
    );
    let explicit_raw = contains_any(
        &lower,
        &[
            "raw source",
            "source file",
            "原始资料",
            "原始文件",
            "源文件",
        ],
    );
    let explicit_graph = contains_any(&lower, &["graph", "relationship", "知识图谱", "关系图"]);
    let explicit_write = contains_any(
        &lower,
        &["write to wiki", "create page", "写入", "创建页面"],
    );
    let conversational = trimmed.len() < 32
        && contains_any(
            &lower,
            &["hi", "hello", "thanks", "谢谢", "你好", "好的", "ok"],
        );

    let intent = if explicit_write {
        QueryIntent::NeedsWrite
    } else if explicit_graph {
        QueryIntent::NeedsGraph
    } else if explicit_raw {
        QueryIntent::NeedsRawSourceSearch
    } else if explicit_web {
        QueryIntent::NeedsExternalSearch
    } else if conversational {
        QueryIntent::SimpleConversational
    } else {
        QueryIntent::Ambiguous
    };

    // This router is intentionally conservative. It may label obvious user
    // hints for the final prompt, but it must not infer retrieval from message
    // shape such as length or a question mark. Tool execution is decided by the
    // model planner so capability/meta questions can be answered from the
    // runtime context without an unnecessary wiki search.
    let should_search_wiki = false;

    RouterDecision {
        intent,
        should_search_wiki,
        should_hint_web: tools.web,
        should_hint_anytxt: tools.anytxt,
        should_include_sources: explicit_raw || matches!(mode, AgentMode::Deep),
        rationale: match intent {
            QueryIntent::NeedsExternalSearch => {
                "User appears to request current/external information.".to_string()
            }
            QueryIntent::SimpleConversational => {
                "Short conversational turn; avoid unnecessary retrieval.".to_string()
            }
            QueryIntent::NeedsRawSourceSearch => {
                "User explicitly referenced raw/source material.".to_string()
            }
            QueryIntent::NeedsGraph => "User asks about graph/relationships.".to_string(),
            QueryIntent::NeedsWrite => "User asks to create or update wiki content.".to_string(),
            QueryIntent::NeedsInternalSearch => {
                "User question likely benefits from project retrieval.".to_string()
            }
            QueryIntent::Ambiguous => {
                "Ambiguous request; let the tool planner decide whether retrieval is useful."
                    .to_string()
            }
        },
    }
}

fn contains_any(value: &str, needles: &[&str]) -> bool {
    needles.iter().any(|needle| value.contains(needle))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn router_detects_external_search_hint_without_forcing_wiki_on() {
        let decision = route_query(
            "Search the web for latest policy updates",
            AgentMode::Standard,
            &AgentToolOptions {
                wiki: true,
                web: true,
                anytxt: false,
            },
        );
        assert_eq!(decision.intent, QueryIntent::NeedsExternalSearch);
        assert!(!decision.should_search_wiki);
        assert!(decision.should_hint_web);
    }

    #[test]
    fn router_does_not_force_search_from_question_shape() {
        let decision = route_query(
            "你现在有哪些 skill 可以使用？",
            AgentMode::Standard,
            &AgentToolOptions::default(),
        );
        assert_eq!(decision.intent, QueryIntent::Ambiguous);
        assert!(!decision.should_search_wiki);
    }
}

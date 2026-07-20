use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::future::Future;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;

use serde::Deserialize;
use serde_json::Value;
use uuid::Uuid;

use crate::commands::search::SearchEmbeddingConfig;

use super::cancel::AgentCancellationToken;
use super::context::{
    build_agent_context, collapse_whitespace, intent_label, load_explicit_context_files,
    load_project_context, trim_chars, AgentContextInput, BuiltAgentContext,
};
use super::events::AgentEvent;
use super::permissions::{AgentCapability, PermissionPolicy};
use super::provider::{AgentLlmProvider, LlmClient, LlmConfig};
use super::router::route_query;
use super::skills::{load_project_skills, AgentSkill};
use super::tools::{self, AnyTxtConfig, ToolRegistry, WebSearchConfig};
use super::types::{
    AgentChatRequest, AgentChatResponse, AgentMode, AgentReference, AgentRetrievalMode,
    AgentSkillMode, AgentToolEvent, AgentUsage, AgentUserInputField, AgentUserInputOption,
    AgentUserInputRequest,
};
use super::workspace::{agent_workspace_display, AGENT_WORKSPACE_DIR};

// These limits are intentionally enforced in the backend Agent rather than the
// React UI. API and MCP callers bypass the UI, so safety and cost boundaries
// must live here.
const DEFAULT_CHAT_SEARCH_RESULTS: usize = 5;
const MAX_CHAT_SEARCH_RESULTS: usize = 10;
const MAX_IMAGES_PER_TURN: usize = 5;
const MAX_IMAGE_BASE64_BYTES: usize = 7 * 1024 * 1024;
const MAX_AGENT_TOOL_ITERATIONS: usize = 8;
const AGENT_STRUCTURED_MAX_TOKENS: u32 = 8192;
const AGENT_SKILL_STRUCTURED_MAX_TOKENS: u32 = 16384;
const MAX_SKILL_REFERENCE_BYTES: u64 = 256 * 1024;
const MAX_USER_INPUT_FIELDS: usize = 12;
const MAX_USER_INPUT_OPTIONS: usize = 8;
const MAX_USER_INPUT_TEXT_CHARS: usize = 400;
const SHELL_APPROVAL_REQUIRED_OBSERVATION: &str = "shell.exec.approval_required";

pub type AgentEventSink = Arc<dyn Fn(AgentEvent) + Send + Sync>;

#[derive(Debug, Clone)]
pub struct AgentRuntime {
    project_id: String,
    project_path: String,
    embedding_config: Option<SearchEmbeddingConfig>,
    llm_config: Option<LlmConfig>,
    web_search_config: Option<WebSearchConfig>,
    anytxt_config: Option<AnyTxtConfig>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ModelToolPlan {
    #[serde(default)]
    tool_calls: Vec<ModelToolCall>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ModelToolCall {
    tool: String,
    #[serde(default)]
    query: Option<String>,
    #[serde(default)]
    command: Option<String>,
    #[serde(default)]
    timeout_seconds: Option<u64>,
    #[serde(default)]
    path: Option<String>,
    #[serde(default)]
    content: Option<String>,
    // Overwriting existing wiki pages is destructive. The planner may set this
    // only when the user explicitly asks to update/overwrite an existing page;
    // the tool defaults to create-only when the field is absent.
    #[serde(default)]
    allow_overwrite: Option<bool>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentLoopAction {
    #[serde(default)]
    action: String,
    #[serde(default)]
    tool: Option<String>,
    #[serde(default)]
    answer: Option<String>,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    query: Option<String>,
    #[serde(default)]
    skill: Option<String>,
    #[serde(default)]
    command: Option<String>,
    #[serde(default)]
    timeout_seconds: Option<u64>,
    #[serde(default)]
    path: Option<String>,
    #[serde(default)]
    content: Option<String>,
    #[serde(default)]
    allow_overwrite: Option<bool>,
    #[serde(default)]
    include_content: Option<bool>,
    #[serde(default)]
    top_k: Option<usize>,
    #[serde(default)]
    fields: Option<Value>,
    #[serde(default)]
    questions: Option<Value>,
}

#[derive(Debug, Clone)]
struct AgentObservation {
    tool: String,
    summary: String,
}

impl AgentRuntime {
    pub fn new(
        project_id: impl Into<String>,
        project_path: impl Into<String>,
        embedding_config: Option<SearchEmbeddingConfig>,
        llm_config: Option<LlmConfig>,
        web_search_config: Option<WebSearchConfig>,
        anytxt_config: Option<AnyTxtConfig>,
    ) -> Self {
        Self {
            project_id: project_id.into(),
            project_path: project_path.into(),
            embedding_config,
            llm_config,
            web_search_config,
            anytxt_config,
        }
    }

    #[allow(dead_code)]
    pub async fn run_once(&self, request: AgentChatRequest) -> Result<AgentChatResponse, String> {
        self.run_once_with_cancel(request, None).await
    }

    pub async fn run_once_with_cancel(
        &self,
        request: AgentChatRequest,
        cancellation: Option<AgentCancellationToken>,
    ) -> Result<AgentChatResponse, String> {
        self.run_once_with_cancel_and_events(request, cancellation, None)
            .await
    }

    pub async fn run_once_with_cancel_and_events(
        &self,
        request: AgentChatRequest,
        cancellation: Option<AgentCancellationToken>,
        event_sink: Option<AgentEventSink>,
    ) -> Result<AgentChatResponse, String> {
        let message = request.message.trim();
        if message.is_empty() {
            return Err("message is required".to_string());
        }
        validate_images(&request.images)?;
        check_cancel(cancellation.as_ref())?;

        let session_id = request
            .session_id
            .clone()
            .filter(|id| !id.trim().is_empty())
            .unwrap_or_else(|| format!("api_{}", Uuid::new_v4()));
        let mut tool_events = Vec::new();
        let mut events = Vec::new();
        emit_event(
            &mut events,
            &event_sink,
            AgentEvent::AgentStart {
                session_id: session_id.clone(),
            },
        );
        emit_event(
            &mut events,
            &event_sink,
            AgentEvent::TurnStart {
                mode: mode_label(request.mode).to_string(),
            },
        );
        let mut references = Vec::new();
        let permission_policy = PermissionPolicy::api_default();
        let router = route_query(message, request.mode, &request.tools);
        let skills = load_project_skills(&self.project_path, &request.skills);
        check_cancel(cancellation.as_ref())?;
        if !request.skills.is_empty() {
            permission_policy.require(AgentCapability::ReadProject)?;
            let skill_detail = match request.skill_mode {
                AgentSkillMode::Auto => format!("{} skill(s) available", skills.len()),
                AgentSkillMode::Explicit => format!("{} skill(s) selected", skills.len()),
            };
            tool_emit_event(
                &mut tool_events,
                &mut events,
                &event_sink,
                AgentToolEvent {
                    tool: "skills.load".to_string(),
                    status: "completed".to_string(),
                    detail: Some(skill_detail.clone()),
                },
            );
            emit_event(
                &mut events,
                &event_sink,
                AgentEvent::tool_end("skills.load", Some(skill_detail)),
            );
        }

        if request.tools.web {
            permission_policy.require(AgentCapability::SearchWeb)?;
            tool_emit_event(&mut tool_events, &mut events, &event_sink, AgentToolEvent {
                tool: "web.search".to_string(),
                status: "available".to_string(),
                detail: Some("Web search is enabled for this turn. Router decides whether to execute it immediately.".to_string()),
            });
        }
        if request.tools.anytxt {
            permission_policy.require(AgentCapability::SearchAnyTxt)?;
            tool_emit_event(&mut tool_events, &mut events, &event_sink, AgentToolEvent {
                tool: "anytxt.search".to_string(),
                status: "available".to_string(),
                detail: Some("AnyTXT search is enabled for this turn. Router decides whether to execute it immediately.".to_string()),
            });
        }

        let mut retrieval_parts = Vec::new();
        let tool_registry = tools::BuiltinToolRegistry::default();
        if self
            .llm_config
            .as_ref()
            .is_some_and(|cfg| cfg.is_usable_for_backend_http())
        {
            return self
                .run_agent_loop(
                    &request,
                    message,
                    session_id,
                    router,
                    skills,
                    permission_policy,
                    tool_registry,
                    references,
                    tool_events,
                    events,
                    event_sink,
                    cancellation.as_ref(),
                )
                .await;
        }

        let should_use_model_planner =
            should_plan_tools_with_model(message, request.mode, &request.tools, !skills.is_empty());
        let planner_has_config = self
            .llm_config
            .as_ref()
            .is_some_and(|cfg| cfg.is_usable_for_backend_http());
        let model_plan_result = self
            .plan_tools_with_model(
                message,
                request.mode,
                &request.tools,
                &skills,
                request.skill_mode,
                cancellation.as_ref(),
            )
            .await;
        let planner_unavailable_or_failed =
            should_use_model_planner && (!planner_has_config || model_plan_result.is_err());
        let model_plan = model_plan_result.unwrap_or_default();
        if !model_plan.tool_calls.is_empty() {
            tool_emit_event(
                &mut tool_events,
                &mut events,
                &event_sink,
                AgentToolEvent {
                    tool: "agent.plan_tools".to_string(),
                    status: "completed".to_string(),
                    detail: Some(format!(
                        "{} planned tool call(s)",
                        model_plan.tool_calls.len()
                    )),
                },
            );
        }
        let planned_queries = planned_tool_queries(&model_plan, message);
        let planned_has = |tool: &str| planned_queries.contains_key(tool);
        // If the planner cannot run, preserve the API/MCP offline contract for
        // plain wiki questions without bringing back message-shape heuristics.
        // Skill turns intentionally do not use this fallback: the skill index is
        // already in the prompt, and falling back to wiki.search would recreate
        // the "what skills do you have?" retrieval bug.
        let fallback_wiki_search = should_fallback_wiki_search(
            planner_unavailable_or_failed,
            &request.tools,
            skills.is_empty(),
        );
        let should_search_wiki =
            router.should_search_wiki || planned_has("wiki.search") || fallback_wiki_search;
        let should_include_sources = router.should_include_sources || planned_has("source.search");
        let should_search_graph = matches!(router.intent, super::router::QueryIntent::NeedsGraph)
            || planned_has("graph.search");
        let should_run_web = request.tools.web
            && (matches!(
                router.intent,
                super::router::QueryIntent::NeedsExternalSearch
            ) || planned_has("web.search")
                || matches!(request.mode, AgentMode::Deep));
        let should_run_anytxt = request.tools.anytxt
            && (should_include_sources
                || planned_has("anytxt.search")
                || matches!(request.mode, AgentMode::Deep));
        let deep_research = matches!(request.mode, AgentMode::Deep)
            && (should_run_web || should_run_anytxt || should_include_sources);
        let shell_call = if skills.is_empty() {
            None
        } else if let Some(command) = request
            .shell_command
            .as_deref()
            .map(str::trim)
            .filter(|command| !command.is_empty())
        {
            Some((command, None))
        } else {
            model_plan
                .tool_calls
                .iter()
                .find(|call| call.tool.trim() == "shell.exec")
                .and_then(|call| {
                    shell_command_from_call(call).map(|command| (command, call.timeout_seconds))
                })
        };

        if let Some(write_call) = model_plan
            .tool_calls
            .iter()
            .find(|call| call.tool.trim() == "wiki.write_page")
        {
            check_cancel(cancellation.as_ref())?;
            permission_policy.require(AgentCapability::WriteWiki)?;
            let path = write_call
                .path
                .as_deref()
                .map(str::trim)
                .filter(|path| !path.is_empty())
                .ok_or_else(|| "wiki.write_page requires path".to_string())?;
            let content = write_call
                .content
                .as_deref()
                .map(str::trim)
                .filter(|content| !content.is_empty())
                .ok_or_else(|| "wiki.write_page requires content".to_string())?;
            tool_emit_event(
                &mut tool_events,
                &mut events,
                &event_sink,
                AgentToolEvent {
                    tool: "wiki.write_page".to_string(),
                    status: "started".to_string(),
                    detail: Some(path.to_string()),
                },
            );
            emit_event(
                &mut events,
                &event_sink,
                AgentEvent::tool_start("wiki.write_page", Some(path.to_string())),
            );
            let tool_context = self.tool_context();
            match execute_tool_with_cancellation(
                tool_registry.execute(
                    "wiki.write_page",
                    serde_json::json!({
                        "path": path,
                        "content": content,
                        "allowOverwrite": write_call.allow_overwrite.unwrap_or(false),
                    }),
                    tool_context,
                ),
                cancellation.as_ref(),
            )
            .await
            .and_then(|value| {
                serde_json::from_value::<tools::WikiWriteOutput>(value)
                    .map_err(|err| format!("Invalid wiki.write_page result: {err}"))
            }) {
                Ok(output) => {
                    emit_event(
                        &mut events,
                        &event_sink,
                        AgentEvent::FileChanged {
                            path: output.reference.path.clone(),
                            tool: "wiki.write_page".to_string(),
                            existed_before: output.existed_before,
                            previous_content: output.previous_content,
                        },
                    );
                    let reference = output.reference;
                    emit_event(
                        &mut events,
                        &event_sink,
                        AgentEvent::ReferenceAdded {
                            reference: reference.clone(),
                        },
                    );
                    references.push(reference);
                    tool_emit_event(
                        &mut tool_events,
                        &mut events,
                        &event_sink,
                        AgentToolEvent {
                            tool: "wiki.write_page".to_string(),
                            status: "completed".to_string(),
                            detail: Some(path.to_string()),
                        },
                    );
                    emit_event(
                        &mut events,
                        &event_sink,
                        AgentEvent::tool_end("wiki.write_page", Some(path.to_string())),
                    );
                    retrieval_parts.push(format!("wiki.write_page wrote {path}."));
                }
                Err(err) => {
                    tool_emit_event(
                        &mut tool_events,
                        &mut events,
                        &event_sink,
                        AgentToolEvent {
                            tool: "wiki.write_page".to_string(),
                            status: "failed".to_string(),
                            detail: Some(err.clone()),
                        },
                    );
                    emit_event(
                        &mut events,
                        &event_sink,
                        AgentEvent::tool_end("wiki.write_page", Some(format!("failed: {err}"))),
                    );
                }
            }
        }

        if let Some((command, timeout_seconds)) = shell_call {
            check_cancel(cancellation.as_ref())?;
            if is_skill_preference_probe_command(command) {
                let detail = skipped_skill_preference_probe_summary(command);
                tool_emit_event(
                    &mut tool_events,
                    &mut events,
                    &event_sink,
                    AgentToolEvent {
                        tool: "shell.exec".to_string(),
                        status: "completed".to_string(),
                        detail: Some("skipped optional skill preference probe".to_string()),
                    },
                );
                emit_event(
                    &mut events,
                    &event_sink,
                    AgentEvent::tool_start("shell.exec", Some(command.to_string())),
                );
                emit_event(
                    &mut events,
                    &event_sink,
                    AgentEvent::tool_end("shell.exec", Some(detail.clone())),
                );
                retrieval_parts.push(detail);
            } else {
                permission_policy.require(AgentCapability::Process)?;
                if !is_shell_command_approved(command, &request.approved_shell_commands) {
                    let detail = format!("approval required: {command}");
                    emit_event(
                        &mut events,
                        &event_sink,
                        AgentEvent::tool_start("shell.exec", Some(command.to_string())),
                    );
                    tool_emit_event(
                        &mut tool_events,
                        &mut events,
                        &event_sink,
                        AgentToolEvent {
                            tool: "shell.exec".to_string(),
                            status: "available".to_string(),
                            detail: Some(detail.clone()),
                        },
                    );
                    emit_event(
                        &mut events,
                        &event_sink,
                        AgentEvent::tool_end("shell.exec", Some(detail.clone())),
                    );
                    retrieval_parts.push(format!(
                    "shell.exec was requested by an active skill but was not run because the command has not been approved: `{command}`."
                ));
                } else {
                    tool_emit_event(
                        &mut tool_events,
                        &mut events,
                        &event_sink,
                        AgentToolEvent {
                            tool: "shell.exec".to_string(),
                            status: "started".to_string(),
                            detail: Some(command.to_string()),
                        },
                    );
                    emit_event(
                        &mut events,
                        &event_sink,
                        AgentEvent::tool_start("shell.exec", Some(command.to_string())),
                    );
                    match execute_tool_with_cancellation(
                        tool_registry.execute(
                            "shell.exec",
                            serde_json::json!({
                                "command": command,
                                "timeoutSeconds": timeout_seconds,
                            }),
                            self.tool_context(),
                        ),
                        cancellation.as_ref(),
                    )
                    .await
                    .and_then(|value| {
                        serde_json::from_value::<tools::ShellExecToolOutput>(value)
                            .map_err(|err| format!("Invalid shell.exec result: {err}"))
                    }) {
                        Ok(output) => {
                            check_cancel(cancellation.as_ref())?;
                            let summary = format!(
                                "shell.exec `{}` exit={:?} timedOut={}\nstdout:\n{}\nstderr:\n{}",
                                output.command,
                                output.exit_code,
                                output.timed_out,
                                output.stdout,
                                output.stderr
                            );
                            retrieval_parts.push(summary);
                            tool_emit_event(
                                &mut tool_events,
                                &mut events,
                                &event_sink,
                                AgentToolEvent {
                                    tool: "shell.exec".to_string(),
                                    status: "completed".to_string(),
                                    detail: Some(format!("exit={:?}", output.exit_code)),
                                },
                            );
                            emit_event(
                                &mut events,
                                &event_sink,
                                AgentEvent::tool_end(
                                    "shell.exec",
                                    Some(format!("exit={:?}", output.exit_code)),
                                ),
                            );
                        }
                        Err(err) => {
                            tool_emit_event(
                                &mut tool_events,
                                &mut events,
                                &event_sink,
                                AgentToolEvent {
                                    tool: "shell.exec".to_string(),
                                    status: "failed".to_string(),
                                    detail: Some(err.clone()),
                                },
                            );
                            emit_event(
                                &mut events,
                                &event_sink,
                                AgentEvent::tool_end("shell.exec", Some(format!("failed: {err}"))),
                            );
                        }
                    }
                }
            }
        }

        if deep_research {
            tool_emit_event(
                &mut tool_events,
                &mut events,
                &event_sink,
                AgentToolEvent {
                    tool: "deep_research.run".to_string(),
                    status: "started".to_string(),
                    detail: Some(message.to_string()),
                },
            );
            emit_event(
                &mut events,
                &event_sink,
                AgentEvent::tool_start("deep_research.run", Some(message.to_string())),
            );
        }

        if should_search_wiki {
            check_cancel(cancellation.as_ref())?;
            permission_policy.require(AgentCapability::SearchWiki)?;
            let wiki_query = planned_queries
                .get("wiki.search")
                .map(String::as_str)
                .unwrap_or(message);
            tool_emit_event(
                &mut tool_events,
                &mut events,
                &event_sink,
                AgentToolEvent {
                    tool: "wiki.search".to_string(),
                    status: "started".to_string(),
                    detail: Some(wiki_query.to_string()),
                },
            );
            emit_event(
                &mut events,
                &event_sink,
                AgentEvent::tool_start("wiki.search", Some(wiki_query.to_string())),
            );
            let top_k = request
                .top_k
                .unwrap_or(DEFAULT_CHAT_SEARCH_RESULTS)
                .clamp(1, MAX_CHAT_SEARCH_RESULTS);
            let wiki_search = execute_tool_with_cancellation(
                tool_registry.execute(
                    "wiki.search",
                    serde_json::json!({
                        "query": wiki_query,
                        "topK": top_k,
                        "includeContent": request.include_content.unwrap_or(false)
                    }),
                    self.tool_context(),
                ),
                cancellation.as_ref(),
            )
            .await
            .and_then(|value| {
                serde_json::from_value::<tools::WikiSearchToolOutput>(value)
                    .map_err(|err| format!("Invalid wiki.search result: {err}"))
            });
            match wiki_search {
                Ok(search) => {
                    check_cancel(cancellation.as_ref())?;
                    let search_refs = search.references;
                    for reference in &search_refs {
                        emit_event(
                            &mut events,
                            &event_sink,
                            AgentEvent::ReferenceAdded {
                                reference: reference.clone(),
                            },
                        );
                    }
                    let search_count = search_refs.len();
                    references.extend(search_refs);
                    tool_emit_event(
                        &mut tool_events,
                        &mut events,
                        &event_sink,
                        AgentToolEvent {
                            tool: "wiki.search".to_string(),
                            status: "completed".to_string(),
                            detail: Some(format!(
                                "{} result(s), mode={}, tokenHits={}, vectorHits={}, graphHits={}",
                                search_count,
                                search.mode,
                                search.token_hits,
                                search.vector_hits,
                                search.graph_hits
                            )),
                        },
                    );
                    emit_event(
                        &mut events,
                        &event_sink,
                        AgentEvent::tool_end(
                            "wiki.search",
                            Some(format!("{search_count} result(s)")),
                        ),
                    );
                    retrieval_parts.push(build_retrieval_answer(message, &references));
                }
                Err(err) => {
                    tool_emit_event(
                        &mut tool_events,
                        &mut events,
                        &event_sink,
                        AgentToolEvent {
                            tool: "wiki.search".to_string(),
                            status: "failed".to_string(),
                            detail: Some(err.clone()),
                        },
                    );
                    emit_event(
                        &mut events,
                        &event_sink,
                        AgentEvent::tool_end("wiki.search", Some(format!("failed: {err}"))),
                    );
                }
            }
            if matches!(request.mode, AgentMode::Deep) && !references.is_empty() {
                permission_policy.require(AgentCapability::ReadProject)?;
                let excerpts = references
                    .iter()
                    .filter(|reference| reference.kind == "wiki")
                    .take(2)
                    .filter_map(|reference| {
                        tools::read_wiki_page(&self.project_path, &reference.path)
                            .ok()
                            .map(|content| {
                                format!(
                                    "Excerpt from {}:\n{}",
                                    reference.path,
                                    collapse_whitespace(&content)
                                        .chars()
                                        .take(2_000)
                                        .collect::<String>()
                                )
                            })
                    })
                    .collect::<Vec<_>>();
                if !excerpts.is_empty() {
                    tool_emit_event(
                        &mut tool_events,
                        &mut events,
                        &event_sink,
                        AgentToolEvent {
                            tool: "wiki.read_page".to_string(),
                            status: "completed".to_string(),
                            detail: Some(format!("{} excerpt(s)", excerpts.len())),
                        },
                    );
                    emit_event(
                        &mut events,
                        &event_sink,
                        AgentEvent::tool_end(
                            "wiki.read_page",
                            Some(format!("{} excerpt(s)", excerpts.len())),
                        ),
                    );
                    retrieval_parts.push(excerpts.join("\n\n"));
                }
            }
        } else if request.tools.wiki {
            retrieval_parts.push(format!(
                "Router intent={} did not require immediate wiki.search for this turn.",
                intent_label(router.intent)
            ));
        }

        if should_include_sources {
            check_cancel(cancellation.as_ref())?;
            permission_policy.require(AgentCapability::ReadSource)?;
            let source_query = planned_queries
                .get("source.search")
                .map(String::as_str)
                .unwrap_or(message);
            tool_emit_event(
                &mut tool_events,
                &mut events,
                &event_sink,
                AgentToolEvent {
                    tool: "source.search".to_string(),
                    status: "started".to_string(),
                    detail: Some(source_query.to_string()),
                },
            );
            emit_event(
                &mut events,
                &event_sink,
                AgentEvent::tool_start("source.search", Some(source_query.to_string())),
            );
            match execute_tool_with_cancellation(
                tool_registry.execute(
                    "source.search",
                    serde_json::json!({
                        "query": source_query,
                        "topK": request
                            .top_k
                            .unwrap_or(DEFAULT_CHAT_SEARCH_RESULTS)
                            .clamp(1, MAX_CHAT_SEARCH_RESULTS)
                    }),
                    self.tool_context(),
                ),
                cancellation.as_ref(),
            )
            .await
            .and_then(|value| {
                serde_json::from_value::<Vec<AgentReference>>(value)
                    .map_err(|err| format!("Invalid source.search result: {err}"))
            }) {
                Ok(source_refs) => {
                    for reference in &source_refs {
                        emit_event(
                            &mut events,
                            &event_sink,
                            AgentEvent::ReferenceAdded {
                                reference: reference.clone(),
                            },
                        );
                    }
                    let count = source_refs.len();
                    references.extend(source_refs);
                    tool_emit_event(
                        &mut tool_events,
                        &mut events,
                        &event_sink,
                        AgentToolEvent {
                            tool: "source.search".to_string(),
                            status: "completed".to_string(),
                            detail: Some(format!("{count} result(s)")),
                        },
                    );
                    emit_event(
                        &mut events,
                        &event_sink,
                        AgentEvent::tool_end("source.search", Some(format!("{count} result(s)"))),
                    );
                }
                Err(err) => {
                    tool_emit_event(
                        &mut tool_events,
                        &mut events,
                        &event_sink,
                        AgentToolEvent {
                            tool: "source.search".to_string(),
                            status: "failed".to_string(),
                            detail: Some(err.clone()),
                        },
                    );
                    emit_event(
                        &mut events,
                        &event_sink,
                        AgentEvent::tool_end("source.search", Some(format!("failed: {err}"))),
                    );
                }
            }
        }

        if should_search_graph {
            check_cancel(cancellation.as_ref())?;
            permission_policy.require(AgentCapability::ReadProject)?;
            let graph_query = planned_queries
                .get("graph.search")
                .map(String::as_str)
                .unwrap_or(message);
            tool_emit_event(
                &mut tool_events,
                &mut events,
                &event_sink,
                AgentToolEvent {
                    tool: "graph.search".to_string(),
                    status: "started".to_string(),
                    detail: Some(graph_query.to_string()),
                },
            );
            emit_event(
                &mut events,
                &event_sink,
                AgentEvent::tool_start("graph.search", Some(graph_query.to_string())),
            );
            match execute_tool_with_cancellation(
                tool_registry.execute(
                    "graph.search",
                    serde_json::json!({
                        "query": graph_query,
                        "topK": request
                            .top_k
                            .unwrap_or(DEFAULT_CHAT_SEARCH_RESULTS)
                            .clamp(1, MAX_CHAT_SEARCH_RESULTS)
                    }),
                    self.tool_context(),
                ),
                cancellation.as_ref(),
            )
            .await
            .and_then(|value| {
                serde_json::from_value::<Vec<AgentReference>>(value)
                    .map_err(|err| format!("Invalid graph.search result: {err}"))
            }) {
                Ok(graph_refs) => {
                    for reference in &graph_refs {
                        emit_event(
                            &mut events,
                            &event_sink,
                            AgentEvent::ReferenceAdded {
                                reference: reference.clone(),
                            },
                        );
                    }
                    let count = graph_refs.len();
                    references.extend(graph_refs);
                    tool_emit_event(
                        &mut tool_events,
                        &mut events,
                        &event_sink,
                        AgentToolEvent {
                            tool: "graph.search".to_string(),
                            status: "completed".to_string(),
                            detail: Some(format!("{count} result(s)")),
                        },
                    );
                    emit_event(
                        &mut events,
                        &event_sink,
                        AgentEvent::tool_end("graph.search", Some(format!("{count} result(s)"))),
                    );
                }
                Err(err) => {
                    tool_emit_event(
                        &mut tool_events,
                        &mut events,
                        &event_sink,
                        AgentToolEvent {
                            tool: "graph.search".to_string(),
                            status: "failed".to_string(),
                            detail: Some(err.clone()),
                        },
                    );
                    emit_event(
                        &mut events,
                        &event_sink,
                        AgentEvent::tool_end("graph.search", Some(format!("failed: {err}"))),
                    );
                }
            }
        }

        if should_run_web {
            check_cancel(cancellation.as_ref())?;
            permission_policy.require(AgentCapability::Network)?;
            let web_query = planned_queries
                .get("web.search")
                .map(String::as_str)
                .unwrap_or(message);
            tool_emit_event(
                &mut tool_events,
                &mut events,
                &event_sink,
                AgentToolEvent {
                    tool: "web.search".to_string(),
                    status: "started".to_string(),
                    detail: Some(web_query.to_string()),
                },
            );
            emit_event(
                &mut events,
                &event_sink,
                AgentEvent::tool_start("web.search", Some(web_query.to_string())),
            );
            match execute_tool_with_cancellation(
                tool_registry.execute(
                    "web.search",
                    serde_json::json!({
                        "query": web_query,
                        "topK": request
                            .top_k
                            .unwrap_or(DEFAULT_CHAT_SEARCH_RESULTS)
                            .clamp(1, MAX_CHAT_SEARCH_RESULTS)
                    }),
                    self.tool_context(),
                ),
                cancellation.as_ref(),
            )
            .await
            .and_then(|value| {
                serde_json::from_value::<Vec<AgentReference>>(value)
                    .map_err(|err| format!("Invalid web.search result: {err}"))
            }) {
                Ok(web_refs) => {
                    check_cancel(cancellation.as_ref())?;
                    for reference in &web_refs {
                        emit_event(
                            &mut events,
                            &event_sink,
                            AgentEvent::ReferenceAdded {
                                reference: reference.clone(),
                            },
                        );
                    }
                    let count = web_refs.len();
                    references.extend(web_refs);
                    tool_emit_event(
                        &mut tool_events,
                        &mut events,
                        &event_sink,
                        AgentToolEvent {
                            tool: "web.search".to_string(),
                            status: "completed".to_string(),
                            detail: Some(format!("{count} result(s)")),
                        },
                    );
                    emit_event(
                        &mut events,
                        &event_sink,
                        AgentEvent::tool_end("web.search", Some(format!("{count} result(s)"))),
                    );
                }
                Err(err) => {
                    tool_emit_event(
                        &mut tool_events,
                        &mut events,
                        &event_sink,
                        AgentToolEvent {
                            tool: "web.search".to_string(),
                            status: "failed".to_string(),
                            detail: Some(err.clone()),
                        },
                    );
                    emit_event(
                        &mut events,
                        &event_sink,
                        AgentEvent::tool_end("web.search", Some(format!("failed: {err}"))),
                    );
                }
            }
        }

        if should_run_anytxt {
            check_cancel(cancellation.as_ref())?;
            permission_policy.require(AgentCapability::Network)?;
            let anytxt_query = planned_queries
                .get("anytxt.search")
                .map(String::as_str)
                .unwrap_or(message);
            tool_emit_event(
                &mut tool_events,
                &mut events,
                &event_sink,
                AgentToolEvent {
                    tool: "anytxt.search".to_string(),
                    status: "started".to_string(),
                    detail: Some(anytxt_query.to_string()),
                },
            );
            emit_event(
                &mut events,
                &event_sink,
                AgentEvent::tool_start("anytxt.search", Some(anytxt_query.to_string())),
            );
            match execute_tool_with_cancellation(
                tool_registry.execute(
                    "anytxt.search",
                    serde_json::json!({
                        "query": anytxt_query,
                        "topK": request
                            .top_k
                            .unwrap_or(DEFAULT_CHAT_SEARCH_RESULTS)
                            .clamp(1, MAX_CHAT_SEARCH_RESULTS)
                    }),
                    self.tool_context(),
                ),
                cancellation.as_ref(),
            )
            .await
            .and_then(|value| {
                serde_json::from_value::<Vec<AgentReference>>(value)
                    .map_err(|err| format!("Invalid anytxt.search result: {err}"))
            }) {
                Ok(anytxt_refs) => {
                    check_cancel(cancellation.as_ref())?;
                    for reference in &anytxt_refs {
                        emit_event(
                            &mut events,
                            &event_sink,
                            AgentEvent::ReferenceAdded {
                                reference: reference.clone(),
                            },
                        );
                    }
                    let count = anytxt_refs.len();
                    references.extend(anytxt_refs);
                    tool_emit_event(
                        &mut tool_events,
                        &mut events,
                        &event_sink,
                        AgentToolEvent {
                            tool: "anytxt.search".to_string(),
                            status: "completed".to_string(),
                            detail: Some(format!("{count} result(s)")),
                        },
                    );
                    emit_event(
                        &mut events,
                        &event_sink,
                        AgentEvent::tool_end("anytxt.search", Some(format!("{count} result(s)"))),
                    );
                }
                Err(err) => {
                    tool_emit_event(
                        &mut tool_events,
                        &mut events,
                        &event_sink,
                        AgentToolEvent {
                            tool: "anytxt.search".to_string(),
                            status: "failed".to_string(),
                            detail: Some(err.clone()),
                        },
                    );
                    emit_event(
                        &mut events,
                        &event_sink,
                        AgentEvent::tool_end("anytxt.search", Some(format!("failed: {err}"))),
                    );
                }
            }
        }

        if deep_research {
            tool_emit_event(
                &mut tool_events,
                &mut events,
                &event_sink,
                AgentToolEvent {
                    tool: "deep_research.run".to_string(),
                    status: "completed".to_string(),
                    detail: Some(format!("{} reference(s)", references.len())),
                },
            );
            emit_event(
                &mut events,
                &event_sink,
                AgentEvent::tool_end(
                    "deep_research.run",
                    Some(format!("{} reference(s)", references.len())),
                ),
            );
        }

        if retrieval_parts.is_empty() {
            if !request.tools.wiki && !request.tools.web && !request.tools.anytxt {
                retrieval_parts.push("No Agent tools were enabled for this request. Enable wiki, web, or AnyTXT tools to let the backend Agent retrieve supporting context.".to_string());
            } else {
                retrieval_parts.push(
                    "No Agent tools ran before generation. Available tools were exposed as model hints."
                        .to_string(),
                );
            }
        }
        let retrieval_summary = retrieval_parts.join("\n\n");
        let project_context = load_project_context(&self.project_path);
        let explicit_files =
            load_explicit_context_files(&self.project_path, &request.context_files).await;
        let built_context = fit_context_to_model(
            build_agent_context(AgentContextInput {
                query: message,
                project: &project_context,
                router: &router,
                history: &request.history,
                skills: &skills,
                skill_mode: request.skill_mode,
                references: &references,
                retrieval_summary: &retrieval_summary,
                explicit_files: &explicit_files,
            }),
            self.llm_config.as_ref(),
        );

        let answer = if let Some(config) = self
            .llm_config
            .as_ref()
            .filter(|cfg| cfg.is_usable_for_backend_http())
        {
            check_cancel(cancellation.as_ref())?;
            let client = LlmClient::new(config.clone())?;
            tool_emit_event(
                &mut tool_events,
                &mut events,
                &event_sink,
                AgentToolEvent {
                    tool: "llm.generate".to_string(),
                    status: "started".to_string(),
                    detail: Some(format!(
                        "{}:{}",
                        client.provider_name(),
                        client.model_name()
                    )),
                },
            );
            let generation = if event_sink.is_some() {
                generate_with_cancellation_stream(
                    &client,
                    &built_context.system,
                    &built_context.user,
                    &request.images,
                    cancellation.as_ref(),
                    |delta| {
                        emit_event(
                            &mut events,
                            &event_sink,
                            AgentEvent::MessageDelta {
                                text: delta.to_string(),
                            },
                        );
                    },
                )
                .await
            } else {
                generate_with_cancellation(
                    &client,
                    &built_context.system,
                    &built_context.user,
                    &request.images,
                    cancellation.as_ref(),
                )
                .await
            };
            match generation {
                Ok(answer) => {
                    tool_emit_event(
                        &mut tool_events,
                        &mut events,
                        &event_sink,
                        AgentToolEvent {
                            tool: "llm.generate".to_string(),
                            status: "completed".to_string(),
                            detail: None,
                        },
                    );
                    answer
                }
                Err(err) => {
                    tool_emit_event(
                        &mut tool_events,
                        &mut events,
                        &event_sink,
                        AgentToolEvent {
                            tool: "llm.generate".to_string(),
                            status: "failed".to_string(),
                            detail: Some(err.clone()),
                        },
                    );
                    emit_event(
                        &mut events,
                        &event_sink,
                        AgentEvent::Error {
                            message: err.clone(),
                        },
                    );
                    return Err(err);
                }
            }
        } else {
            retrieval_summary
        };
        emit_event(
            &mut events,
            &event_sink,
            AgentEvent::Done {
                session_id: session_id.clone(),
            },
        );
        let usage = AgentUsage {
            prompt_chars: built_context.system.len() + built_context.user.len(),
            completion_chars: answer.len(),
            reference_count: references.len(),
            tool_event_count: tool_events.len(),
        };

        Ok(AgentChatResponse {
            ok: true,
            project_id: self.project_id.clone(),
            session_id,
            mode: request.mode,
            message: answer,
            references,
            tool_events,
            events,
            user_input_request: None,
            usage: Some(usage),
        })
    }
}

impl AgentRuntime {
    #[allow(clippy::too_many_arguments)]
    async fn run_agent_loop(
        &self,
        request: &AgentChatRequest,
        message: &str,
        session_id: String,
        router: super::router::RouterDecision,
        skills: Vec<AgentSkill>,
        permission_policy: PermissionPolicy,
        tool_registry: tools::BuiltinToolRegistry,
        mut references: Vec<AgentReference>,
        mut tool_events: Vec<AgentToolEvent>,
        mut events: Vec<AgentEvent>,
        event_sink: Option<AgentEventSink>,
        cancellation: Option<&AgentCancellationToken>,
    ) -> Result<AgentChatResponse, String> {
        let config = self
            .llm_config
            .as_ref()
            .filter(|cfg| cfg.is_usable_for_backend_http())
            .ok_or_else(|| "Backend Agent LLM is not configured".to_string())?;
        let client = LlmClient::new(config.clone())?
            .structured_task_config(agent_structured_max_tokens(!skills.is_empty()));
        let project_context = load_project_context(&self.project_path);
        let explicit_files =
            load_explicit_context_files(&self.project_path, &request.context_files).await;
        if !request.context_files.is_empty() {
            let detail = format!(
                "{} of {} selected file(s) attached",
                explicit_files.len(),
                request.context_files.len().min(8)
            );
            tool_emit_event(
                &mut tool_events,
                &mut events,
                &event_sink,
                AgentToolEvent {
                    tool: "context.attach".to_string(),
                    status: if explicit_files.is_empty() {
                        "failed".to_string()
                    } else {
                        "completed".to_string()
                    },
                    detail: Some(detail.clone()),
                },
            );
            emit_event(
                &mut events,
                &event_sink,
                AgentEvent::tool_end("context.attach", Some(detail)),
            );
        }
        let mut observations = Vec::<AgentObservation>::new();
        let mut executed_retrievals = BTreeSet::<String>::new();
        let mut retrieval_steps = 0usize;
        let mut consecutive_no_gain_retrievals = 0usize;
        let mut force_final_next = false;
        let mut last_prompt_chars = 0usize;
        let has_explicit_skills =
            request.skill_mode == AgentSkillMode::Explicit && !skills.is_empty();
        let max_iterations = agent_loop_iteration_budget(request.mode, has_explicit_skills);
        let retrieval_budget =
            agent_loop_retrieval_budget(request.mode, request.retrieval_mode, has_explicit_skills);

        if let Some(command) = request
            .shell_command
            .as_deref()
            .map(str::trim)
            .filter(|command| !command.is_empty())
        {
            if is_shell_command_allowed_without_prompt(
                command,
                &request.approved_shell_commands,
                &self.project_path,
            ) {
                let approved_action = AgentLoopAction {
                    action: "tool".to_string(),
                    tool: Some("shell.exec".to_string()),
                    command: Some(command.to_string()),
                    timeout_seconds: None,
                    ..AgentLoopAction::default()
                };
                let observation = self
                    .execute_agent_loop_tool(
                        request,
                        &approved_action,
                        &permission_policy,
                        &tool_registry,
                        &skills,
                        &mut references,
                        &mut tool_events,
                        &mut events,
                        &event_sink,
                        cancellation,
                    )
                    .await?;
                observations.push(observation);
            }
        }

        for iteration in 0..max_iterations {
            check_cancel(cancellation)?;
            let must_finalize = force_final_next || retrieval_steps >= retrieval_budget;
            let built_context = fit_context_to_model(
                build_agent_context(AgentContextInput {
                    query: message,
                    project: &project_context,
                    router: &router,
                    history: &request.history,
                    skills: &skills,
                    skill_mode: request.skill_mode,
                    references: &references,
                    // Loop observations are appended below in the loop-specific
                    // user block. Passing them through the generic retrieval
                    // summary as well would duplicate large tool outputs on
                    // every iteration.
                    retrieval_summary: "",
                    explicit_files: &explicit_files,
                }),
                self.llm_config.as_ref(),
            );
            let (system, user) = if must_finalize {
                (
                    build_agent_final_system(&built_context.system),
                    build_agent_final_user(&built_context.user, &observations),
                )
            } else {
                (
                    build_agent_loop_system(&built_context.system, request.retrieval_mode),
                    build_agent_loop_user(
                        &built_context.user,
                        request,
                        &skills,
                        &observations,
                        iteration,
                        max_iterations,
                        references
                            .iter()
                            .any(|reference| reference.kind == "workspace"),
                    ),
                )
            };
            last_prompt_chars = system.chars().count() + user.chars().count();
            tool_emit_event(
                &mut tool_events,
                &mut events,
                &event_sink,
                AgentToolEvent {
                    tool: "llm.generate".to_string(),
                    status: "started".to_string(),
                    detail: Some(format!(
                        "{}:{}",
                        client.provider_name(),
                        client.model_name()
                    )),
                },
            );
            // Images are only sent on the first model turn. Tool observations
            // after that contain text results; resending large base64 images
            // on each loop iteration would multiply cost and latency.
            let images = if iteration == 0 {
                request.images.as_slice()
            } else {
                &[]
            };
            let raw =
                match generate_with_cancellation(&client, &system, &user, images, cancellation)
                    .await
                {
                    Ok(raw) => {
                        tool_emit_event(
                            &mut tool_events,
                            &mut events,
                            &event_sink,
                            AgentToolEvent {
                                tool: "llm.generate".to_string(),
                                status: "completed".to_string(),
                                detail: None,
                            },
                        );
                        raw
                    }
                    Err(err) => {
                        tool_emit_event(
                            &mut tool_events,
                            &mut events,
                            &event_sink,
                            AgentToolEvent {
                                tool: "llm.generate".to_string(),
                                status: "failed".to_string(),
                                detail: Some(err.clone()),
                            },
                        );
                        emit_event(
                            &mut events,
                            &event_sink,
                            AgentEvent::Error {
                                message: err.clone(),
                            },
                        );
                        return Err(err);
                    }
                };
            let action = parse_agent_loop_action(&raw);

            if must_finalize {
                let answer = forced_final_answer(&raw, &action, &references);
                if event_sink.is_some() {
                    emit_event(
                        &mut events,
                        &event_sink,
                        AgentEvent::MessageDelta {
                            text: answer.clone(),
                        },
                    );
                }
                emit_event(
                    &mut events,
                    &event_sink,
                    AgentEvent::Done {
                        session_id: session_id.clone(),
                    },
                );
                let reference_count = references.len();
                let tool_event_count = tool_events.len();
                return Ok(AgentChatResponse {
                    ok: true,
                    project_id: self.project_id.clone(),
                    session_id,
                    mode: request.mode,
                    message: answer.clone(),
                    references,
                    tool_events,
                    events,
                    user_input_request: None,
                    usage: Some(AgentUsage {
                        prompt_chars: last_prompt_chars,
                        completion_chars: answer.len(),
                        reference_count,
                        tool_event_count,
                    }),
                });
            }

            if action.action.eq_ignore_ascii_case("invalid_tool_json") {
                observations.push(record_loop_tool_rejection(
                    "agent.action",
                    action.answer.unwrap_or_else(|| {
                        "Invalid tool JSON. Return a corrected compact JSON action.".to_string()
                    }),
                    &mut tool_events,
                    &mut events,
                    &event_sink,
                ));
                continue;
            }

            if action.action.eq_ignore_ascii_case("final") {
                let answer = action
                    .answer
                    .filter(|value| !value.trim().is_empty())
                    .unwrap_or_else(|| raw.trim().to_string());
                if event_sink.is_some() {
                    emit_event(
                        &mut events,
                        &event_sink,
                        AgentEvent::MessageDelta {
                            text: answer.clone(),
                        },
                    );
                }
                emit_event(
                    &mut events,
                    &event_sink,
                    AgentEvent::Done {
                        session_id: session_id.clone(),
                    },
                );
                let usage = AgentUsage {
                    prompt_chars: last_prompt_chars,
                    completion_chars: answer.len(),
                    reference_count: references.len(),
                    tool_event_count: tool_events.len(),
                };
                return Ok(AgentChatResponse {
                    ok: true,
                    project_id: self.project_id.clone(),
                    session_id,
                    mode: request.mode,
                    message: answer,
                    references,
                    tool_events,
                    events,
                    user_input_request: None,
                    usage: Some(usage),
                });
            }

            if !action.action.eq_ignore_ascii_case("tool") {
                // Some smaller/local models ignore the JSON envelope and answer
                // directly. Treat non-JSON or unknown actions as final text so
                // chat does not get stuck in a repair loop.
                let answer = raw.trim().to_string();
                if event_sink.is_some() && !answer.is_empty() {
                    emit_event(
                        &mut events,
                        &event_sink,
                        AgentEvent::MessageDelta {
                            text: answer.clone(),
                        },
                    );
                }
                emit_event(
                    &mut events,
                    &event_sink,
                    AgentEvent::Done {
                        session_id: session_id.clone(),
                    },
                );
                let usage = AgentUsage {
                    prompt_chars: last_prompt_chars,
                    completion_chars: answer.len(),
                    reference_count: references.len(),
                    tool_event_count: tool_events.len(),
                };
                return Ok(AgentChatResponse {
                    ok: true,
                    project_id: self.project_id.clone(),
                    session_id,
                    mode: request.mode,
                    message: answer,
                    references,
                    tool_events,
                    events,
                    user_input_request: None,
                    usage: Some(usage),
                });
            }

            if action
                .tool
                .as_deref()
                .map(is_user_ask_tool)
                .unwrap_or(false)
            {
                let request_form = match sanitize_user_input_request(&action) {
                    Ok(request_form) => request_form,
                    Err(err) => {
                        observations.push(record_loop_tool_rejection(
                            "user.ask",
                            format!(
                                "{err}. Return a corrected user.ask schema or answer without asking."
                            ),
                            &mut tool_events,
                            &mut events,
                            &event_sink,
                        ));
                        continue;
                    }
                };
                emit_event(
                    &mut events,
                    &event_sink,
                    AgentEvent::UserInputRequired {
                        request: request_form.clone(),
                    },
                );
                emit_event(
                    &mut events,
                    &event_sink,
                    AgentEvent::Done {
                        session_id: session_id.clone(),
                    },
                );
                let answer = request_form.description.clone().unwrap_or_else(|| {
                    "Please provide the requested information to continue.".to_string()
                });
                let reference_count = references.len();
                let tool_event_count = tool_events.len();
                return Ok(AgentChatResponse {
                    ok: true,
                    project_id: self.project_id.clone(),
                    session_id,
                    mode: request.mode,
                    message: answer.clone(),
                    references,
                    tool_events,
                    events,
                    user_input_request: Some(request_form),
                    usage: Some(AgentUsage {
                        prompt_chars: last_prompt_chars,
                        completion_chars: answer.len(),
                        reference_count,
                        tool_event_count,
                    }),
                });
            }

            let retrieval_tool = action.tool.as_deref().is_some_and(is_agent_retrieval_tool);
            let evidence_count_before = smart_evidence_count(&references);
            if retrieval_tool {
                let tool = action.tool.as_deref().unwrap_or_default();
                if let Ok(input) = self.agent_loop_tool_input(request, tool, &action) {
                    let signature = retrieval_signature(tool, &input, request.retrieval_mode);
                    if !executed_retrievals.insert(signature) {
                        observations.push(record_loop_tool_rejection(
                            tool,
                            "duplicate retrieval skipped; use the existing observation and answer the user"
                                .to_string(),
                            &mut tool_events,
                            &mut events,
                            &event_sink,
                        ));
                        force_final_next = true;
                        continue;
                    }
                }
                retrieval_steps += 1;
            }

            let observation = self
                .execute_agent_loop_tool(
                    request,
                    &action,
                    &permission_policy,
                    &tool_registry,
                    &skills,
                    &mut references,
                    &mut tool_events,
                    &mut events,
                    &event_sink,
                    cancellation,
                )
                .await?;
            if is_shell_approval_required_observation(&observation) {
                let answer = observation.summary.clone();
                if event_sink.is_some() {
                    emit_event(
                        &mut events,
                        &event_sink,
                        AgentEvent::MessageDelta {
                            text: answer.clone(),
                        },
                    );
                }
                emit_event(
                    &mut events,
                    &event_sink,
                    AgentEvent::Done {
                        session_id: session_id.clone(),
                    },
                );
                let reference_count = references.len();
                let tool_event_count = tool_events.len();
                return Ok(AgentChatResponse {
                    ok: true,
                    project_id: self.project_id.clone(),
                    session_id,
                    mode: request.mode,
                    message: answer,
                    references,
                    tool_events,
                    events,
                    user_input_request: None,
                    usage: Some(AgentUsage {
                        prompt_chars: last_prompt_chars,
                        completion_chars: observation.summary.len(),
                        reference_count,
                        tool_event_count,
                    }),
                });
            }
            observations.push(observation);
            if retrieval_tool && request.retrieval_mode == AgentRetrievalMode::Smart {
                let evidence_count_after = smart_evidence_count(&references);
                let latest = observations.last().expect("observation was just appended");
                if retrieval_added_evidence(
                    &latest.tool,
                    &latest.summary,
                    evidence_count_before,
                    evidence_count_after,
                ) {
                    consecutive_no_gain_retrievals = 0;
                } else {
                    consecutive_no_gain_retrievals += 1;
                    if consecutive_no_gain_retrievals >= 2 {
                        force_final_next = true;
                    }
                }
            }
        }

        let answer = agent_iteration_limit_answer(max_iterations, observations.len(), &references);
        if event_sink.is_some() {
            emit_event(
                &mut events,
                &event_sink,
                AgentEvent::MessageDelta {
                    text: answer.clone(),
                },
            );
        }
        emit_event(
            &mut events,
            &event_sink,
            AgentEvent::Done {
                session_id: session_id.clone(),
            },
        );
        let reference_count = references.len();
        let tool_event_count = tool_events.len();
        Ok(AgentChatResponse {
            ok: true,
            project_id: self.project_id.clone(),
            session_id,
            mode: request.mode,
            message: answer.clone(),
            references,
            tool_events,
            events,
            user_input_request: None,
            usage: Some(AgentUsage {
                prompt_chars: last_prompt_chars,
                completion_chars: answer.len(),
                reference_count,
                tool_event_count,
            }),
        })
    }

    #[allow(clippy::too_many_arguments, clippy::too_many_lines)]
    async fn execute_agent_loop_tool(
        &self,
        request: &AgentChatRequest,
        action: &AgentLoopAction,
        permission_policy: &PermissionPolicy,
        tool_registry: &tools::BuiltinToolRegistry,
        skills: &[AgentSkill],
        references: &mut Vec<AgentReference>,
        tool_events: &mut Vec<AgentToolEvent>,
        events: &mut Vec<AgentEvent>,
        event_sink: &Option<AgentEventSink>,
        cancellation: Option<&AgentCancellationToken>,
    ) -> Result<AgentObservation, String> {
        let tool = match action
            .tool
            .as_deref()
            .map(str::trim)
            .filter(|tool| !tool.is_empty())
        {
            Some(tool) => tool,
            None => {
                return Ok(AgentObservation {
                    tool: "agent.action".to_string(),
                    summary: "invalid tool action: missing tool name".to_string(),
                });
            }
        };

        let input = match self.agent_loop_tool_input(request, tool, action) {
            Ok(input) => input,
            Err(err) => {
                return Ok(record_loop_tool_rejection(
                    tool,
                    err,
                    tool_events,
                    events,
                    event_sink,
                ));
            }
        };
        let input_detail = summarize_tool_input(tool, &input);

        if tool == "shell.exec" {
            if skills.is_empty() {
                return Ok(record_loop_tool_rejection(
                    tool,
                    "shell.exec is only available when at least one skill is active for this turn"
                        .to_string(),
                    tool_events,
                    events,
                    event_sink,
                ));
            }
            let command = input
                .get("command")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .trim();
            if is_skill_preference_probe_command(command) {
                let summary = skipped_skill_preference_probe_summary(command);
                tool_emit_event(
                    tool_events,
                    events,
                    event_sink,
                    AgentToolEvent {
                        tool: "shell.exec".to_string(),
                        status: "completed".to_string(),
                        detail: Some("skipped optional skill preference probe".to_string()),
                    },
                );
                emit_event(
                    events,
                    event_sink,
                    AgentEvent::tool_start("shell.exec", Some(command.to_string())),
                );
                emit_event(
                    events,
                    event_sink,
                    AgentEvent::tool_end("shell.exec", Some(summary.clone())),
                );
                return Ok(AgentObservation {
                    tool: "shell.exec.preference_probe_skipped".to_string(),
                    summary,
                });
            }
            if let Err(err) = permission_policy.require(AgentCapability::Process) {
                return Ok(record_loop_tool_rejection(
                    tool,
                    err,
                    tool_events,
                    events,
                    event_sink,
                ));
            }
            if !is_shell_command_allowed_without_prompt(
                command,
                &request.approved_shell_commands,
                &self.project_path,
            ) {
                let detail = format!("approval required: {command}");
                emit_event(
                    events,
                    event_sink,
                    AgentEvent::tool_start("shell.exec", Some(command.to_string())),
                );
                tool_emit_event(
                    tool_events,
                    events,
                    event_sink,
                    AgentToolEvent {
                        tool: "shell.exec".to_string(),
                        status: "available".to_string(),
                        detail: Some(detail.clone()),
                    },
                );
                emit_event(
                    events,
                    event_sink,
                    AgentEvent::tool_end("shell.exec", Some(detail.clone())),
                );
                return Ok(AgentObservation {
                    tool: SHELL_APPROVAL_REQUIRED_OBSERVATION.to_string(),
                    summary: format!(
                        "The Agent needs approval before it can run this command:\n\n`{command}`\n\nApprove the command if you want the Agent to continue with this skill."
                    ),
                });
            }
        }

        if tool == "skill.read_file" {
            if let Err(err) = permission_policy.require(AgentCapability::ReadProject) {
                return Ok(record_loop_tool_rejection(
                    tool,
                    err,
                    tool_events,
                    events,
                    event_sink,
                ));
            }
            tool_emit_event(
                tool_events,
                events,
                event_sink,
                AgentToolEvent {
                    tool: tool.to_string(),
                    status: "started".to_string(),
                    detail: input_detail.clone(),
                },
            );
            emit_event(
                events,
                event_sink,
                AgentEvent::tool_start(tool, input_detail),
            );
            return match read_active_skill_file(skills, &input) {
                Ok(value) => {
                    let summary =
                        self.record_loop_tool_success(tool, value, references, events, event_sink)?;
                    tool_emit_event(
                        tool_events,
                        events,
                        event_sink,
                        AgentToolEvent {
                            tool: tool.to_string(),
                            status: "completed".to_string(),
                            detail: Some(summary.clone()),
                        },
                    );
                    emit_event(
                        events,
                        event_sink,
                        AgentEvent::tool_end(tool, Some(summary.clone())),
                    );
                    Ok(AgentObservation {
                        tool: tool.to_string(),
                        summary,
                    })
                }
                Err(err) => {
                    tool_emit_event(
                        tool_events,
                        events,
                        event_sink,
                        AgentToolEvent {
                            tool: tool.to_string(),
                            status: "failed".to_string(),
                            detail: Some(err.clone()),
                        },
                    );
                    emit_event(
                        events,
                        event_sink,
                        AgentEvent::tool_end(tool, Some(format!("failed: {err}"))),
                    );
                    Ok(AgentObservation {
                        tool: tool.to_string(),
                        summary: format!("failed: {err}"),
                    })
                }
            };
        }

        if let Err(err) = require_tool_permission(tool, request, permission_policy) {
            return Ok(record_loop_tool_rejection(
                tool,
                err,
                tool_events,
                events,
                event_sink,
            ));
        }
        tool_emit_event(
            tool_events,
            events,
            event_sink,
            AgentToolEvent {
                tool: tool.to_string(),
                status: "started".to_string(),
                detail: input_detail.clone(),
            },
        );
        emit_event(
            events,
            event_sink,
            AgentEvent::tool_start(tool, input_detail),
        );

        let result = execute_tool_with_cancellation(
            tool_registry.execute(tool, input, self.tool_context()),
            cancellation,
        )
        .await;

        match result {
            Ok(value) => {
                let summary =
                    self.record_loop_tool_success(tool, value, references, events, event_sink)?;
                tool_emit_event(
                    tool_events,
                    events,
                    event_sink,
                    AgentToolEvent {
                        tool: tool.to_string(),
                        status: "completed".to_string(),
                        detail: Some(summary.clone()),
                    },
                );
                emit_event(
                    events,
                    event_sink,
                    AgentEvent::tool_end(tool, Some(summary.clone())),
                );
                Ok(AgentObservation {
                    tool: tool.to_string(),
                    summary,
                })
            }
            Err(err) => {
                tool_emit_event(
                    tool_events,
                    events,
                    event_sink,
                    AgentToolEvent {
                        tool: tool.to_string(),
                        status: "failed".to_string(),
                        detail: Some(err.clone()),
                    },
                );
                emit_event(
                    events,
                    event_sink,
                    AgentEvent::tool_end(tool, Some(format!("failed: {err}"))),
                );
                Ok(AgentObservation {
                    tool: tool.to_string(),
                    summary: format!("failed: {err}"),
                })
            }
        }
    }

    fn agent_loop_tool_input(
        &self,
        request: &AgentChatRequest,
        tool: &str,
        action: &AgentLoopAction,
    ) -> Result<Value, String> {
        let top_k = action
            .top_k
            .or(request.top_k)
            .unwrap_or(DEFAULT_CHAT_SEARCH_RESULTS)
            .clamp(1, MAX_CHAT_SEARCH_RESULTS);
        match tool {
            "wiki.search" | "source.search" | "graph.search" | "web.search" | "anytxt.search" => {
                let query = action
                    .query
                    .as_deref()
                    .map(str::trim)
                    .filter(|query| !query.is_empty())
                    .ok_or_else(|| format!("{tool} requires query"))?;
                Ok(serde_json::json!({
                    "query": query,
                    "topK": top_k,
                    "includeContent": action.include_content.or(request.include_content).unwrap_or(false),
                }))
            }
            "wiki.read_page" => {
                let path = action
                    .path
                    .as_deref()
                    .map(str::trim)
                    .filter(|path| !path.is_empty())
                    .ok_or_else(|| "wiki.read_page requires path".to_string())?;
                Ok(serde_json::json!({ "path": path }))
            }
            "skill.read_file" => {
                let path = action
                    .path
                    .as_deref()
                    .map(str::trim)
                    .filter(|path| !path.is_empty())
                    .ok_or_else(|| "skill.read_file requires path".to_string())?;
                Ok(serde_json::json!({
                    "skill": action.skill.as_deref().map(str::trim).filter(|skill| !skill.is_empty()),
                    "path": path,
                }))
            }
            "wiki.write_page" => {
                let path = action
                    .path
                    .as_deref()
                    .map(str::trim)
                    .filter(|path| !path.is_empty())
                    .ok_or_else(|| "wiki.write_page requires path".to_string())?;
                let content = action
                    .content
                    .as_deref()
                    .map(str::trim)
                    .filter(|content| !content.is_empty())
                    .ok_or_else(|| "wiki.write_page requires content".to_string())?;
                Ok(serde_json::json!({
                    "path": path,
                    "content": content,
                    "allowOverwrite": action.allow_overwrite.unwrap_or(false),
                }))
            }
            "workspace.write_file" | "workspace.append_file" => {
                let tool_name = action.tool.as_deref().unwrap_or("workspace.write_file");
                let path = action
                    .path
                    .as_deref()
                    .map(str::trim)
                    .filter(|path| !path.is_empty())
                    .ok_or_else(|| format!("{tool_name} requires path"))?;
                let content = action
                    .content
                    .as_deref()
                    .ok_or_else(|| format!("{tool_name} requires content"))?;
                Ok(serde_json::json!({
                    "path": path,
                    "content": content,
                }))
            }
            "shell.exec" => {
                let command = action
                    .command
                    .as_deref()
                    .or(action.query.as_deref())
                    .map(str::trim)
                    .filter(|command| !command.is_empty())
                    .ok_or_else(|| "shell.exec requires command".to_string())?;
                Ok(serde_json::json!({
                    "command": command,
                    "timeoutSeconds": action.timeout_seconds,
                }))
            }
            other => Err(format!("Unknown Agent tool: {other}")),
        }
    }

    fn record_loop_tool_success(
        &self,
        tool: &str,
        value: Value,
        references: &mut Vec<AgentReference>,
        events: &mut Vec<AgentEvent>,
        event_sink: &Option<AgentEventSink>,
    ) -> Result<String, String> {
        match tool {
            "wiki.search" => {
                let search: tools::WikiSearchToolOutput = serde_json::from_value(value)
                    .map_err(|err| format!("Invalid wiki.search result: {err}"))?;
                let count = search.references.len();
                let added = search
                    .references
                    .into_iter()
                    .filter(|reference| {
                        push_unique_reference(references, events, event_sink, reference.clone())
                    })
                    .count();
                Ok(format!(
                    "{count} result(s), {added} new, mode={}, tokenHits={}, vectorHits={}, graphHits={}",
                    search.mode, search.token_hits, search.vector_hits, search.graph_hits
                ))
            }
            "source.search" | "graph.search" | "web.search" | "anytxt.search" => {
                let found: Vec<AgentReference> = serde_json::from_value(value)
                    .map_err(|err| format!("Invalid {tool} result: {err}"))?;
                let count = found.len();
                let added = found
                    .into_iter()
                    .filter(|reference| {
                        push_unique_reference(references, events, event_sink, reference.clone())
                    })
                    .count();
                Ok(format!("{count} result(s), {added} new"))
            }
            "wiki.read_page" => {
                let path = value
                    .get("path")
                    .and_then(Value::as_str)
                    .unwrap_or("wiki page");
                let content = value.get("content").and_then(Value::as_str).unwrap_or("");
                let mut summary = format!(
                    "read {path}\n{}",
                    trim_chars(&collapse_whitespace(content), 4_000)
                );
                if let Some(context) = value
                    .get("knowledgeContext")
                    .filter(|value| !value.is_null())
                {
                    summary.push_str("\nKnowledge context: ");
                    summary.push_str(&trim_chars(&context.to_string(), 2_000));
                }
                Ok(summary)
            }
            "skill.read_file" => {
                let skill = value
                    .get("skill")
                    .and_then(Value::as_str)
                    .unwrap_or("skill");
                let path = value.get("path").and_then(Value::as_str).unwrap_or("file");
                let content = value.get("content").and_then(Value::as_str).unwrap_or("");
                Ok(format!(
                    "read {skill}:{path}\n{}",
                    trim_chars(&collapse_whitespace(content), 4_000)
                ))
            }
            "wiki.write_page" => {
                let output: tools::WikiWriteOutput = serde_json::from_value(value)
                    .map_err(|err| format!("Invalid wiki.write_page result: {err}"))?;
                emit_event(
                    events,
                    event_sink,
                    AgentEvent::FileChanged {
                        path: output.reference.path.clone(),
                        tool: "wiki.write_page".to_string(),
                        existed_before: output.existed_before,
                        previous_content: output.previous_content,
                    },
                );
                let reference = output.reference;
                let path = reference.path.clone();
                push_unique_reference(references, events, event_sink, reference);
                Ok(format!("wrote {path}"))
            }
            "workspace.write_file" | "workspace.append_file" => {
                let output: tools::WorkspaceWriteOutput = serde_json::from_value(value)
                    .map_err(|err| format!("Invalid {tool} result: {err}"))?;
                let path = output.path.as_str();
                let bytes = output.bytes as u64;
                let action = if tool == "workspace.append_file" {
                    "updated"
                } else {
                    "written"
                };
                emit_event(
                    events,
                    event_sink,
                    AgentEvent::FileChanged {
                        path: output.path.clone(),
                        tool: tool.to_string(),
                        existed_before: output.existed_before,
                        previous_content: output.previous_content,
                    },
                );
                let reference = AgentReference {
                    title: Path::new(path)
                        .file_name()
                        .and_then(|name| name.to_str())
                        .unwrap_or(path)
                        .to_string(),
                    path: path.to_string(),
                    kind: "workspace".to_string(),
                    snippet: Some(format!("Generated file {action} by Agent ({bytes} bytes).")),
                    score: None,
                    knowledge_context: None,
                };
                push_unique_reference(references, events, event_sink, reference);
                Ok(format!(
                    "{} {path} ({bytes} bytes)",
                    if tool == "workspace.append_file" {
                        "appended"
                    } else {
                        "wrote"
                    }
                ))
            }
            "shell.exec" => {
                let output: tools::ShellExecToolOutput = serde_json::from_value(value)
                    .map_err(|err| format!("Invalid shell.exec result: {err}"))?;
                for generated in &output.generated_files {
                    let reference = AgentReference {
                        title: Path::new(&generated.path)
                            .file_name()
                            .and_then(|name| name.to_str())
                            .unwrap_or(&generated.path)
                            .to_string(),
                        path: generated.path.clone(),
                        kind: "workspace".to_string(),
                        snippet: Some(format!(
                            "Generated file written by shell.exec ({} bytes).",
                            generated.bytes
                        )),
                        score: None,
                        knowledge_context: None,
                    };
                    push_unique_reference(references, events, event_sink, reference);
                }
                let generated_summary = if output.generated_files.is_empty() {
                    String::new()
                } else {
                    format!(
                        "\nGenerated files:\n{}",
                        output
                            .generated_files
                            .iter()
                            .map(|file| format!("- {}", file.path))
                            .collect::<Vec<_>>()
                            .join("\n")
                    )
                };
                Ok(format!(
                    "`{}` exit={:?} timedOut={}\nstdout:\n{}\nstderr:\n{}",
                    output.command,
                    output.exit_code,
                    output.timed_out,
                    trim_chars(&output.stdout, 8_000),
                    trim_chars(&output.stderr, 4_000)
                ) + &generated_summary)
            }
            _ => Ok(value.to_string()),
        }
    }

    fn tool_context(&self) -> tools::ToolContext<'_> {
        tools::ToolContext {
            project_path: &self.project_path,
            embedding_config: self.embedding_config.clone(),
            web_search_config: self.web_search_config.clone(),
            anytxt_config: self.anytxt_config.clone(),
        }
    }

    async fn plan_tools_with_model(
        &self,
        message: &str,
        mode: AgentMode,
        tools: &super::types::AgentToolOptions,
        skills: &[AgentSkill],
        skill_mode: AgentSkillMode,
        cancellation: Option<&AgentCancellationToken>,
    ) -> Result<ModelToolPlan, String> {
        let skills_enabled = !skills.is_empty();
        if !should_plan_tools_with_model(message, mode, tools, skills_enabled) {
            return Ok(ModelToolPlan::default());
        }
        let Some(config) = self
            .llm_config
            .as_ref()
            .filter(|cfg| cfg.is_usable_for_backend_http())
        else {
            return Ok(ModelToolPlan::default());
        };
        check_cancel(cancellation)?;
        let mut available = vec![
            "wiki.search",
            "source.search",
            "graph.search",
            "wiki.write_page",
        ];
        if tools.web {
            available.push("web.search");
        }
        if tools.anytxt {
            available.push("anytxt.search");
        }
        if skills_enabled {
            available.push("skill.read_file");
            available.push("workspace.write_file");
            available.push("shell.exec");
        }
        let system = "You are an agent tool planner. Return only compact JSON. Do not explain.";
        let skill_context = render_skill_planner_context(skills, skill_mode);
        let workspace = agent_workspace_display(&self.project_path);
        let user = format!(
            "User request:\n{message}\n\nSkill context:\n{skill_context}\n\nAvailable tools: {}\n\nAgent workspace for generated files: {workspace}\n\nReturn JSON exactly like {{\"toolCalls\":[{{\"tool\":\"wiki.search\",\"query\":\"short query\"}}]}}. Use an empty array when no tool is needed. The skill context and tool list above are already available to the assistant; do not call wiki.search, source.search, graph.search, web.search, anytxt.search, skill.read_file, workspace.write_file, or shell.exec merely to list, explain, or summarize the currently available skills, tools, modes, or agent capabilities. Use wiki.search for factual or topical retrieval. Prefer graph.search for relationships, dependencies, neighborhoods, backlinks, or connections between entities; pass concise entity or concept names instead of the full question. The planner may select both when the answer needs page content and graph structure. Prefer web.search only for current/external information. Prefer anytxt.search only for user files outside the wiki. Use wiki.write_page only when the user explicitly asks to create a wiki page; include path under wiki/ ending in .md and full Markdown content. Existing pages are create-only by default; include allowOverwrite:true only when the user explicitly asks to overwrite or update an existing wiki page. Use skill.read_file for Markdown/reference files inside an active skill directory. Use workspace.write_file for generated artifacts under agent-workspace; do not inline large heredocs or generated file bodies inside shell.exec. Use shell.exec only when a relevant active skill requires a command-line operation after any large files have been written. shell.exec runs from the Agent workspace; commands that generate files must write them under that workspace and must not write to home, Desktop, Downloads, system temp folders, hidden app metadata folders, or skill installation folders.",
            available.join(", "),
        );
        let client = LlmClient::new(config.clone())?
            .structured_task_config(agent_structured_max_tokens(!skills.is_empty()));
        let raw = generate_with_cancellation(&client, system, &user, &[], cancellation).await?;
        parse_model_tool_plan(&raw)
    }
}

fn agent_structured_max_tokens(has_skills: bool) -> u32 {
    if has_skills {
        AGENT_SKILL_STRUCTURED_MAX_TOKENS
    } else {
        AGENT_STRUCTURED_MAX_TOKENS
    }
}

fn is_shell_approval_required_observation(observation: &AgentObservation) -> bool {
    observation.tool == SHELL_APPROVAL_REQUIRED_OBSERVATION
}

fn is_skill_preference_probe_command(command: &str) -> bool {
    let lower = command.to_ascii_lowercase();
    (lower.contains("extend.md") || lower.contains("baoyu-skills"))
        && (lower.contains("test -f") || lower.contains("test-path"))
}

fn skipped_skill_preference_probe_summary(command: &str) -> String {
    format!(
        "Skipped optional skill preference probe instead of running shell command:\n`{command}`\nNo EXTEND.md preferences were loaded. Continue with the selected skill using its defaults, and do not retry this probe."
    )
}

fn read_active_skill_file(skills: &[AgentSkill], input: &Value) -> Result<Value, String> {
    if skills.is_empty() {
        return Err("skill.read_file requires an active skill".to_string());
    }
    let requested_path = input
        .get("path")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|path| !path.is_empty())
        .ok_or_else(|| "skill.read_file requires path".to_string())?;
    let (skill, relative_path) = resolve_skill_read_target(
        skills,
        input.get("skill").and_then(Value::as_str),
        requested_path,
    )?;
    if !is_safe_relative_skill_path(&relative_path) {
        return Err(
            "skill.read_file path must be a safe relative path inside the skill directory"
                .to_string(),
        );
    }
    let base = PathBuf::from(&skill.base_dir);
    let base_canon = base
        .canonicalize()
        .map_err(|err| format!("Failed to resolve skill directory: {err}"))?;
    let target = base.join(&relative_path);
    let target_canon = target
        .canonicalize()
        .map_err(|err| format!("Failed to resolve skill file: {err}"))?;
    if !target_canon.starts_with(&base_canon) {
        return Err("skill.read_file cannot read outside the active skill directory".to_string());
    }
    let meta = fs::symlink_metadata(&target_canon)
        .map_err(|err| format!("Failed to inspect skill file: {err}"))?;
    if meta.file_type().is_symlink() || !meta.is_file() {
        return Err("skill.read_file target is not a regular file".to_string());
    }
    if meta.len() > MAX_SKILL_REFERENCE_BYTES {
        return Err(format!(
            "skill.read_file target is too large (max {} bytes)",
            MAX_SKILL_REFERENCE_BYTES
        ));
    }
    let content = fs::read_to_string(&target_canon)
        .map_err(|err| format!("Failed to read skill file as UTF-8 text: {err}"))?;
    Ok(serde_json::json!({
        "skill": skill.name,
        "path": relative_path,
        "content": content,
    }))
}

fn resolve_skill_read_target<'a>(
    skills: &'a [AgentSkill],
    requested_skill: Option<&str>,
    requested_path: &str,
) -> Result<(&'a AgentSkill, String), String> {
    if let Some(requested) = requested_skill
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let skill = select_active_skill_for_read(skills, Some(requested))?;
        let rel = normalize_requested_path_for_skill(skill, requested_path)?;
        return Ok((skill, rel));
    }
    if let Some((skill, rel)) = resolve_absolute_skill_path(skills, requested_path)? {
        return Ok((skill, rel));
    }
    if let Some(skill) = resolve_unique_existing_skill_path(skills, requested_path)? {
        return Ok((skill, requested_path.to_string()));
    }
    if let Some((skill, rel)) = resolve_prefixed_skill_path(skills, requested_path)? {
        return Ok((skill, rel));
    }
    let skill = select_active_skill_for_read(skills, requested_skill)?;
    Ok((skill, requested_path.to_string()))
}

fn normalize_requested_path_for_skill(
    skill: &AgentSkill,
    requested_path: &str,
) -> Result<String, String> {
    let path = Path::new(requested_path);
    if path.is_absolute() {
        let target = path
            .canonicalize()
            .map_err(|err| format!("Failed to resolve skill file: {err}"))?;
        let base = Path::new(&skill.base_dir)
            .canonicalize()
            .map_err(|err| format!("Failed to resolve skill directory: {err}"))?;
        if !target.starts_with(&base) {
            return Err(
                "skill.read_file absolute path does not belong to requested skill".to_string(),
            );
        }
        return target
            .strip_prefix(&base)
            .map_err(|err| format!("Failed to normalize skill path: {err}"))
            .map(|rel| rel.to_string_lossy().replace('\\', "/"));
    }
    if let Some((prefix, rest)) = requested_path.trim().replace('\\', "/").split_once('/') {
        if skill_matches_requested_name(skill, prefix) {
            return Ok(rest.to_string());
        }
        if skill_name_like(prefix) {
            return Err("skill.read_file path prefix does not match requested skill".to_string());
        }
    }
    if let Some((prefix, rest)) = requested_path.trim().replace('\\', "/").split_once(':') {
        if skill_matches_requested_name(skill, prefix) {
            return Ok(rest.trim_start_matches('/').to_string());
        }
        if skill_name_like(prefix) {
            return Err("skill.read_file path prefix does not match requested skill".to_string());
        }
    }
    Ok(requested_path.to_string())
}

fn resolve_absolute_skill_path<'a>(
    skills: &'a [AgentSkill],
    requested_path: &str,
) -> Result<Option<(&'a AgentSkill, String)>, String> {
    let path = Path::new(requested_path);
    if !path.is_absolute() {
        return Ok(None);
    }
    let target = path
        .canonicalize()
        .map_err(|err| format!("Failed to resolve skill file: {err}"))?;
    for skill in skills {
        let base = Path::new(&skill.base_dir)
            .canonicalize()
            .map_err(|err| format!("Failed to resolve skill directory: {err}"))?;
        if target.starts_with(&base) {
            let rel = target
                .strip_prefix(&base)
                .map_err(|err| format!("Failed to normalize skill path: {err}"))?
                .to_string_lossy()
                .replace('\\', "/");
            if !rel.is_empty() {
                return Ok(Some((skill, rel)));
            }
        }
    }
    Ok(None)
}

fn resolve_prefixed_skill_path<'a>(
    skills: &'a [AgentSkill],
    requested_path: &str,
) -> Result<Option<(&'a AgentSkill, String)>, String> {
    let normalized = requested_path.trim().replace('\\', "/");
    let Some((prefix, rest)) = split_skill_path_prefix(&normalized) else {
        return Ok(None);
    };
    if rest.trim().is_empty() {
        return Ok(None);
    }
    let matched = skills
        .iter()
        .filter(|skill| skill_matches_requested_name(skill, prefix))
        .filter(|skill| Path::new(&skill.base_dir).join(rest).exists())
        .collect::<Vec<_>>();
    match matched.as_slice() {
        [skill] => Ok(Some((*skill, rest.to_string()))),
        [] => Ok(None),
        _ => Err(format!("skill.read_file prefix is ambiguous: {prefix}")),
    }
}

fn split_skill_path_prefix(path: &str) -> Option<(&str, &str)> {
    if let Some((prefix, rest)) = path.split_once(':') {
        if skill_name_like(prefix) {
            return Some((prefix, rest.trim_start_matches('/')));
        }
    }
    let (prefix, rest) = path.split_once('/')?;
    Some((prefix, rest))
}

fn resolve_unique_existing_skill_path<'a>(
    skills: &'a [AgentSkill],
    requested_path: &str,
) -> Result<Option<&'a AgentSkill>, String> {
    if !is_safe_relative_skill_path(requested_path) {
        return Ok(None);
    }
    let mut matches = Vec::new();
    for skill in skills {
        let base = Path::new(&skill.base_dir);
        let candidate = base.join(requested_path);
        if candidate.exists() {
            let base_canon = base
                .canonicalize()
                .map_err(|err| format!("Failed to resolve skill directory: {err}"))?;
            let candidate_canon = candidate
                .canonicalize()
                .map_err(|err| format!("Failed to resolve skill file: {err}"))?;
            if candidate_canon.starts_with(base_canon) {
                matches.push(skill);
            }
        }
    }
    match matches.as_slice() {
        [skill] => Ok(Some(*skill)),
        [] => Ok(None),
        _ => Err(format!(
            "skill.read_file path is ambiguous: {requested_path}"
        )),
    }
}

fn select_active_skill_for_read<'a>(
    skills: &'a [AgentSkill],
    requested: Option<&str>,
) -> Result<&'a AgentSkill, String> {
    let Some(requested) = requested.map(str::trim).filter(|value| !value.is_empty()) else {
        return if skills.len() == 1 {
            Ok(&skills[0])
        } else {
            Err("skill.read_file requires skill when multiple skills are active".to_string())
        };
    };
    skills
        .iter()
        .find(|skill| skill_matches_requested_name(skill, requested))
        .ok_or_else(|| format!("Active skill not found: {requested}"))
}

fn skill_matches_requested_name(skill: &AgentSkill, requested: &str) -> bool {
    let requested_lower = requested.to_ascii_lowercase();
    if skill.name.eq_ignore_ascii_case(requested) {
        return true;
    }
    let folder_matches = |path: &str| {
        Path::new(path)
            .file_name()
            .and_then(|name| name.to_str())
            .map(|name| {
                let name_lower = name.to_ascii_lowercase();
                name_lower == requested_lower
                    || name_lower.ends_with(&format!("-{requested_lower}"))
            })
            .unwrap_or(false)
    };
    folder_matches(&skill.base_dir)
        || Path::new(&skill.location)
            .parent()
            .and_then(|parent| parent.to_str())
            .map(folder_matches)
            .unwrap_or(false)
}

fn skill_name_like(value: &str) -> bool {
    let value = value.trim();
    !value.is_empty()
        && value.contains('-')
        && value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_')
}

fn is_safe_relative_skill_path(path: &str) -> bool {
    let path = Path::new(path);
    !path.as_os_str().is_empty()
        && !path.is_absolute()
        && path
            .components()
            .all(|component| matches!(component, Component::Normal(_) | Component::CurDir))
}

fn should_plan_tools_with_model(
    message: &str,
    mode: AgentMode,
    tools: &super::types::AgentToolOptions,
    skills_enabled: bool,
) -> bool {
    if matches!(mode, AgentMode::Fast) {
        return false;
    }
    let has_available_tool = tools.wiki || tools.web || tools.anytxt || skills_enabled;
    !message.trim().is_empty() && has_available_tool
}

fn agent_loop_iteration_budget(mode: AgentMode, has_skills: bool) -> usize {
    let base = match mode {
        AgentMode::Fast => 4,
        AgentMode::Standard | AgentMode::LocalFirst => MAX_AGENT_TOOL_ITERATIONS,
        AgentMode::Deep => 12,
    };
    if !has_skills {
        return base;
    }
    match mode {
        AgentMode::Fast => 8,
        AgentMode::Standard | AgentMode::LocalFirst => 16,
        AgentMode::Deep => 20,
    }
}

fn agent_loop_retrieval_budget(
    mode: AgentMode,
    retrieval_mode: AgentRetrievalMode,
    has_explicit_skills: bool,
) -> usize {
    if retrieval_mode == AgentRetrievalMode::Smart {
        return match mode {
            AgentMode::Fast => 3,
            AgentMode::Standard | AgentMode::LocalFirst => 4,
            AgentMode::Deep => 6,
        };
    }
    let base = match mode {
        AgentMode::Fast => 2,
        AgentMode::Standard | AgentMode::LocalFirst => 4,
        AgentMode::Deep => 8,
    };
    if has_explicit_skills {
        base + 4
    } else {
        base
    }
}

fn is_agent_retrieval_tool(tool: &str) -> bool {
    matches!(
        tool,
        "wiki.search"
            | "wiki.read_page"
            | "source.search"
            | "graph.search"
            | "web.search"
            | "anytxt.search"
    )
}

fn canonical_json(value: &Value) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| value.to_string())
}

fn retrieval_signature(tool: &str, input: &Value, mode: AgentRetrievalMode) -> String {
    if mode != AgentRetrievalMode::Smart {
        return format!("{tool}:{}", canonical_json(input));
    }
    let mut normalized = input.clone();
    if let Some(query) = normalized.get_mut("query") {
        if let Some(value) = query.as_str() {
            let compact = value
                .to_lowercase()
                .split(|character: char| {
                    character.is_whitespace() || character.is_ascii_punctuation()
                })
                .filter(|part| !part.is_empty())
                .collect::<Vec<_>>()
                .join(" ");
            *query = Value::String(compact);
        }
    }
    format!("{tool}:{}", canonical_json(&normalized))
}

fn smart_evidence_count(references: &[AgentReference]) -> usize {
    references
        .iter()
        .map(|reference| format!("{}:{}", reference.kind, reference.path))
        .collect::<BTreeSet<_>>()
        .len()
}

fn retrieval_added_evidence(
    tool: &str,
    summary: &str,
    reference_count_before: usize,
    reference_count_after: usize,
) -> bool {
    if reference_count_after > reference_count_before {
        return true;
    }
    if tool == "wiki.read_page" {
        return summary
            .split_once('\n')
            .is_some_and(|(_, content)| !content.trim().is_empty());
    }
    false
}

fn should_fallback_wiki_search(
    planner_unavailable_or_failed: bool,
    tools: &super::types::AgentToolOptions,
    skills_empty: bool,
) -> bool {
    planner_unavailable_or_failed && tools.wiki && skills_empty
}

fn build_agent_loop_system(base_system: &str, retrieval_mode: AgentRetrievalMode) -> String {
    let smart_retrieval = if retrieval_mode == AgentRetrievalMode::Smart {
        "\nSmart retrieval is enabled. Treat retrieval as a bounded evidence loop: after every observation, identify only the unresolved evidence gap, then either issue one concise revised retrieval action or answer. Prefer reading/following already discovered pages before broadening the query. Do not repeat equivalent queries. Stop as soon as the available evidence supports a cited answer; optional background is not a reason to continue."
    } else {
        ""
    };
    format!(
        "{base_system}\n\nAgent loop protocol:\n\
Return only compact JSON. Do not wrap it in markdown.\n\
Choose exactly one action per turn:\n\
1. {{\"action\":\"tool\",\"tool\":\"wiki.search\",\"query\":\"...\"}}\n\
2. {{\"action\":\"tool\",\"tool\":\"user.ask\",\"title\":\"...\",\"description\":\"...\",\"fields\":[{{\"id\":\"choice\",\"type\":\"single\",\"label\":\"...\",\"options\":[{{\"label\":\"...\",\"value\":\"...\",\"recommended\":true}}]}}]}}\n\
3. {{\"action\":\"tool\",\"tool\":\"workspace.write_file\",\"path\":\"cover-image/cover.svg\",\"content\":\"...\"}}\n\
3b. {{\"action\":\"tool\",\"tool\":\"workspace.append_file\",\"path\":\"deck/index.html\",\"content\":\"...\"}}\n\
4. {{\"action\":\"final\",\"answer\":\"...\"}}\n\
Use tools when they are useful, then wait for the observation in the next turn before deciding the next step.\n\
	Do not return natural-language plans such as \"I need to read...\" or \"Let me search...\". If you intend to read/search/write/run something, return the matching tool JSON action in this turn.\n\
	Do not merely announce that you will use a skill or tool. If a skill references a file under its own directory, call skill.read_file with a relative path. If a skill requires an actual command-line generation step, call shell.exec.\n\
	Use skill.read_file for skill Markdown/reference files. Do not use shell.exec, test, cat, or ls merely to inspect skill files or optional preference files.\n\
	Use user.ask when a skill or task needs structured user choices, text input, confirmations, or multiple fields before it can continue. Do not simulate this by writing plain-text questions when a structured form is appropriate.\n\
	Use workspace.write_file for generated artifacts such as SVG, HTML, Markdown drafts, JSON, or scripts. For large HTML/PPT files, first call workspace.write_file with an empty or small opening chunk, then call workspace.append_file with subsequent chunks, and finish only after the file contains closing tags such as </html>. Do not inline large heredocs or generated file bodies inside shell.exec JSON.\n\
	Do not claim that a generated file exists until a workspace.write_file or shell.exec observation confirms it. In the final answer, mention only observed generated file paths.\n\
	Converge quickly. Do not keep reading optional references, running optional validation, or polishing after the requested deliverable has been written. Prefer final as soon as the core user request is satisfied.\n\
	Only use shell.exec when active skill instructions or the user's explicit request require command-line work after files have been written with workspace.write_file. Generated files must be written under the Agent workspace described above. Commands whose explicit file paths stay inside the Agent workspace can run without an approval prompt; commands that mention external paths, home directories, downloads, temp folders, or network URLs require approval.\n\
Use wiki.write_page only when the user explicitly asks to create or update a wiki page. Existing pages are create-only unless allowOverwrite is explicitly justified by the user's request.{smart_retrieval}"
    )
}

fn build_agent_final_system(base_system: &str) -> String {
    format!(
        "{base_system}\n\nThe retrieval phase is complete. No tools are available now. Answer the user's latest request directly using the project context and tool observations already provided. Return only compact JSON in the form {{\"action\":\"final\",\"answer\":\"...\"}}. Do not request, announce, or simulate another search or file read."
    )
}

fn build_agent_final_user(base_user: &str, observations: &[AgentObservation]) -> String {
    let mut out = String::new();
    out.push_str(base_user);
    if !observations.is_empty() {
        out.push_str("\n\nCompleted tool observations:\n");
        out.push_str(&render_observations(observations));
    }
    out.push_str("\n\nProvide the final answer now. No further tool action is permitted.");
    out
}

fn forced_final_answer(
    raw: &str,
    action: &AgentLoopAction,
    references: &[AgentReference],
) -> String {
    if action.action.eq_ignore_ascii_case("final") {
        if let Some(answer) = action
            .answer
            .as_deref()
            .map(str::trim)
            .filter(|v| !v.is_empty())
        {
            return answer.to_string();
        }
    }
    let trimmed = raw.trim();
    if !trimmed.is_empty() && !looks_like_agent_tool_json(trimmed) {
        return trimmed.to_string();
    }
    if references.is_empty() {
        return "I could not find enough project context to answer this request reliably."
            .to_string();
    }
    let mut answer = String::from("I found the following relevant project context:\n");
    for reference in references.iter().take(8) {
        answer.push_str("- ");
        answer.push_str(&reference.title);
        answer.push_str(" (");
        answer.push_str(&reference.path);
        answer.push(')');
        if let Some(snippet) = reference.snippet.as_deref() {
            answer.push_str(": ");
            answer.push_str(&trim_chars(&collapse_whitespace(snippet), 320));
        }
        answer.push('\n');
    }
    answer
}

fn build_agent_loop_user(
    base_user: &str,
    request: &AgentChatRequest,
    skills: &[AgentSkill],
    observations: &[AgentObservation],
    iteration: usize,
    max_iterations: usize,
    has_generated_workspace_file: bool,
) -> String {
    let mut out = String::new();
    out.push_str(base_user);
    out.push_str("\n\nAvailable Agent tools for this turn:\n");
    if request.tools.wiki {
        out.push_str("- wiki.search: retrieve wiki pages for factual or topical questions.\n");
        out.push_str("- wiki.read_page: read a specific wiki markdown page by path.\n");
        out.push_str("- source.search: search raw source snippets.\n");
        out.push_str("- graph.search: retrieve relationships, neighbors, backlinks, dependencies, and connections between entities. Prefer it for relational questions and query with concise entity or concept names.\n");
        out.push_str("- wiki.write_page: create a wiki markdown page when explicitly requested.\n");
    }
    if request.tools.web {
        out.push_str("- web.search: search external web sources.\n");
    }
    if request.tools.anytxt {
        out.push_str("- anytxt.search: search files indexed by AnyTXT.\n");
    }
    if !skills.is_empty() {
        out.push_str("- skill.read_file: read a Markdown/reference file from an active skill directory by relative path. Prefer this over shell.exec for skill references.\n");
        out.push_str("- user.ask: pause and show the user a structured form with single-choice, multi-choice, text, textarea, or confirmation fields when an active skill needs user input.\n");
        out.push_str("- workspace.write_file: write generated artifacts under agent-workspace by relative path. For large HTML/PPT, initialize the file and then append chunks.\n");
        out.push_str("- workspace.append_file: append content to a generated artifact under agent-workspace. Prefer this for large HTML/PPT after workspace.write_file.\n");
        out.push_str("- shell.exec: run a command from the Agent workspace when a selected/available skill requires command-line work. Workspace-local commands can run directly; external paths or network access require approval.\n");
    }
    if observations.is_empty() {
        out.push_str("\nTool observations so far: none.\n");
    } else {
        out.push_str("\nTool observations so far:\n");
        out.push_str(&render_observations(observations));
        out.push('\n');
    }
    let step_number = iteration + 1;
    let remaining_after_this = max_iterations.saturating_sub(step_number);
    out.push_str(&format!(
        "\nIteration budget: step {step_number} of {max_iterations}. You have {remaining_after_this} step(s) after this response.\n"
    ));
    if has_generated_workspace_file {
        out.push_str("A generated workspace file has already been observed. If it satisfies the core request, return final now with the file path. Do not spend remaining steps on optional validation or extra reference reads unless the user explicitly required them.\n");
    }
    if remaining_after_this <= 2 {
        out.push_str("Budget is nearly exhausted. Return final now if any useful answer or generated file exists. Use at most one more tool only when it is strictly required to complete or close an already-started file; skip optional checks, optional reads, and style polishing.\n");
    }
    out.push_str(
        "\nReturn the next JSON action now. Prefer {\"action\":\"final\",\"answer\":\"...\"} whenever the core request is already satisfied.",
    );
    out
}

fn parse_agent_loop_action(raw: &str) -> AgentLoopAction {
    let trimmed = raw.trim();
    if let Ok(action) = serde_json::from_str::<AgentLoopAction>(trimmed) {
        return normalize_agent_loop_action(action);
    }
    if let Some(json) = extract_json_object(trimmed) {
        if let Ok(action) = serde_json::from_str::<AgentLoopAction>(json) {
            return normalize_agent_loop_action(action);
        }
    }
    if looks_like_agent_tool_json(trimmed) {
        return AgentLoopAction {
            action: "invalid_tool_json".to_string(),
            answer: Some(
                "Invalid or truncated Agent tool JSON. Return one complete compact JSON object. For large generated files, initialize with workspace.write_file and continue with workspace.append_file chunks instead of putting the whole file or heredocs in one JSON object."
                    .to_string(),
            ),
            ..AgentLoopAction::default()
        };
    }
    AgentLoopAction {
        action: "invalid_tool_json".to_string(),
        answer: Some(
            "Agent loop responses must be compact JSON. Return either a tool action like {\"action\":\"tool\",\"tool\":\"wiki.read_page\",\"path\":\"...\"} or a final action like {\"action\":\"final\",\"answer\":\"...\"}. Do not return plain text."
                .to_string(),
        ),
        ..AgentLoopAction::default()
    }
}

fn looks_like_agent_tool_json(value: &str) -> bool {
    let trimmed = value.trim_start();
    trimmed.starts_with('{')
        && (trimmed.contains("\"action\"")
            || trimmed.contains("\"tool\"")
            || trimmed.contains("\"command\""))
}

fn normalize_agent_loop_action(mut action: AgentLoopAction) -> AgentLoopAction {
    let trimmed_action = action.action.trim();
    if action.tool.is_none() && is_agent_loop_tool_name(trimmed_action) {
        action.tool = Some(trimmed_action.to_string());
        action.action = "tool".to_string();
    }
    if action.tool.as_deref().is_some_and(is_agent_loop_tool_name) {
        action.action = "tool".to_string();
    }
    if action.action.trim().is_empty() {
        action.action = if action.tool.is_some() {
            "tool".to_string()
        } else {
            "final".to_string()
        };
    }
    if let Some(tool) = action.tool.as_deref() {
        if is_user_ask_tool(tool) {
            action.tool = Some("user.ask".to_string());
        }
    }
    action
}

fn is_agent_loop_tool_name(value: &str) -> bool {
    matches!(
        value,
        "wiki.search"
            | "wiki.read_page"
            | "wiki.write_page"
            | "source.search"
            | "graph.search"
            | "web.search"
            | "anytxt.search"
            | "skill.read_file"
            | "workspace.write_file"
            | "workspace.append_file"
            | "shell.exec"
            | "deep_research.run"
    ) || is_user_ask_tool(value)
}

fn is_user_ask_tool(tool: &str) -> bool {
    matches!(
        tool.trim(),
        "user.ask" | "user_input.ask" | "askUserQuestion" | "AskUserQuestion" | "ask_user_question"
    )
}

fn sanitize_user_input_request(action: &AgentLoopAction) -> Result<AgentUserInputRequest, String> {
    let raw_fields = action
        .fields
        .as_ref()
        .or(action.questions.as_ref())
        .ok_or_else(|| "user.ask requires fields or questions".to_string())?;
    let values = raw_fields
        .as_array()
        .ok_or_else(|| "user.ask fields must be an array".to_string())?;
    let mut fields = Vec::new();
    let mut used_field_ids = BTreeSet::new();
    for (idx, value) in values.iter().take(MAX_USER_INPUT_FIELDS).enumerate() {
        if let Some(mut field) = sanitize_user_input_field(value, idx)? {
            field.id = unique_user_input_key(&mut used_field_ids, &field.id, idx);
            fields.push(field);
        }
    }
    if fields.is_empty() {
        return Err("user.ask requires at least one valid field".to_string());
    }
    Ok(AgentUserInputRequest {
        request_id: Uuid::new_v4().to_string(),
        title: clean_user_input_text(action.title.as_deref().unwrap_or("Input required"))
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| "Input required".to_string()),
        description: clean_user_input_text(
            action
                .description
                .as_deref()
                .unwrap_or("Please provide the requested information so the Agent can continue."),
        ),
        fields,
    })
}

fn sanitize_user_input_field(
    value: &Value,
    idx: usize,
) -> Result<Option<AgentUserInputField>, String> {
    let Some(obj) = value.as_object() else {
        return Ok(None);
    };
    let raw_type = obj
        .get("type")
        .or_else(|| obj.get("kind"))
        .and_then(Value::as_str)
        .unwrap_or("single");
    let Ok(field_type) = normalize_user_input_field_type(raw_type) else {
        return Ok(None);
    };
    let id = obj
        .get("id")
        .or_else(|| obj.get("name"))
        .and_then(Value::as_str)
        .and_then(clean_user_input_id)
        .unwrap_or_else(|| format!("field_{}", idx + 1));
    let label = obj
        .get("label")
        .or_else(|| obj.get("question"))
        .or_else(|| obj.get("header"))
        .and_then(Value::as_str)
        .and_then(clean_user_input_text)
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| format!("Question {}", idx + 1));
    let description = obj
        .get("description")
        .and_then(Value::as_str)
        .and_then(clean_user_input_text);
    let placeholder = obj
        .get("placeholder")
        .and_then(Value::as_str)
        .and_then(clean_user_input_text);
    let mut used_option_values = BTreeSet::new();
    let options = obj
        .get("options")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .take(MAX_USER_INPUT_OPTIONS)
                .enumerate()
                .filter_map(|(option_idx, item)| {
                    let mut option = sanitize_user_input_option(item)?;
                    option.value =
                        unique_user_input_key(&mut used_option_values, &option.value, option_idx);
                    Some(option)
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    if matches!(field_type.as_str(), "single" | "multi") && options.is_empty() {
        return Ok(None);
    }
    let default_value = obj
        .get("defaultValue")
        .or_else(|| obj.get("default"))
        .cloned()
        .filter(|value| validate_user_input_default(&field_type, value, &options));
    Ok(Some(AgentUserInputField {
        id,
        field_type,
        label,
        description,
        placeholder,
        options,
        default_value,
    }))
}

fn normalize_user_input_field_type(value: &str) -> Result<String, String> {
    match value.trim() {
        "single" | "singleChoice" | "radio" | "select" => Ok("single".to_string()),
        "multi" | "multiChoice" | "checkbox" | "checkboxes" => Ok("multi".to_string()),
        "text" | "input" => Ok("text".to_string()),
        "textarea" | "longText" => Ok("textarea".to_string()),
        "confirm" | "boolean" | "switch" => Ok("confirm".to_string()),
        other => Err(format!("Unsupported user.ask field type: {other}")),
    }
}

fn sanitize_user_input_option(value: &Value) -> Option<AgentUserInputOption> {
    let obj = value.as_object()?;
    let label = obj
        .get("label")
        .or_else(|| obj.get("title"))
        .and_then(Value::as_str)
        .and_then(clean_user_input_text)
        .filter(|value| !value.is_empty())?;
    let value_text = obj
        .get("value")
        .and_then(Value::as_str)
        .and_then(clean_user_input_text)
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| label.clone());
    let description = obj
        .get("description")
        .and_then(Value::as_str)
        .and_then(clean_user_input_text);
    let recommended = obj.get("recommended").and_then(Value::as_bool);
    Some(AgentUserInputOption {
        label,
        value: value_text,
        description,
        recommended,
    })
}

fn unique_user_input_key(used: &mut BTreeSet<String>, base: &str, idx: usize) -> String {
    if used.insert(base.to_string()) {
        return base.to_string();
    }
    for suffix in 2..=MAX_USER_INPUT_FIELDS + MAX_USER_INPUT_OPTIONS + 2 {
        let candidate = format!("{base}_{suffix}");
        if used.insert(candidate.clone()) {
            return candidate;
        }
    }
    let fallback = format!("field_{}", idx + 1);
    if used.insert(fallback.clone()) {
        fallback
    } else {
        format!("field_{}_{}", idx + 1, used.len() + 1)
    }
}

fn validate_user_input_default(
    field_type: &str,
    value: &Value,
    options: &[AgentUserInputOption],
) -> bool {
    match field_type {
        "single" => value
            .as_str()
            .map(|default| options.iter().any(|option| option.value == default))
            .unwrap_or(false),
        "multi" => value
            .as_array()
            .map(|defaults| {
                defaults.iter().all(|item| {
                    item.as_str()
                        .map(|default| options.iter().any(|option| option.value == default))
                        .unwrap_or(false)
                })
            })
            .unwrap_or(false),
        "text" | "textarea" => value.as_str().is_some(),
        "confirm" => value.as_bool().is_some(),
        _ => false,
    }
}

fn clean_user_input_text(value: &str) -> Option<String> {
    let cleaned = value
        .chars()
        .filter(|ch| !matches!(ch, '<' | '>') && !ch.is_control())
        .take(MAX_USER_INPUT_TEXT_CHARS)
        .collect::<String>()
        .trim()
        .to_string();
    if cleaned.is_empty() {
        None
    } else {
        Some(cleaned)
    }
}

fn clean_user_input_id(value: &str) -> Option<String> {
    let cleaned = value
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-'))
        .take(64)
        .collect::<String>();
    if cleaned.is_empty() {
        None
    } else {
        Some(cleaned)
    }
}

fn render_observations(observations: &[AgentObservation]) -> String {
    if observations.is_empty() {
        return String::new();
    }
    observations
        .iter()
        .enumerate()
        .map(|(idx, observation)| {
            format!(
                "{}. {}:\n{}",
                idx + 1,
                observation.tool,
                trim_chars(&observation.summary, 8_000)
            )
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}

fn summarize_tool_input(tool: &str, input: &Value) -> Option<String> {
    match tool {
        "wiki.search" | "source.search" | "graph.search" | "web.search" | "anytxt.search" => input
            .get("query")
            .and_then(Value::as_str)
            .map(str::to_string),
        "wiki.read_page" | "wiki.write_page" | "workspace.write_file" | "workspace.append_file" => {
            input
                .get("path")
                .and_then(Value::as_str)
                .map(str::to_string)
        }
        "skill.read_file" => input
            .get("path")
            .and_then(Value::as_str)
            .map(str::to_string),
        "shell.exec" => input
            .get("command")
            .and_then(Value::as_str)
            .map(str::to_string),
        _ => None,
    }
}

fn record_loop_tool_rejection(
    tool: &str,
    error: String,
    tool_events: &mut Vec<AgentToolEvent>,
    events: &mut Vec<AgentEvent>,
    event_sink: &Option<AgentEventSink>,
) -> AgentObservation {
    tool_emit_event(
        tool_events,
        events,
        event_sink,
        AgentToolEvent {
            tool: tool.to_string(),
            status: "failed".to_string(),
            detail: Some(error.clone()),
        },
    );
    emit_event(
        events,
        event_sink,
        AgentEvent::tool_end(tool, Some(format!("rejected: {error}"))),
    );
    AgentObservation {
        tool: tool.to_string(),
        summary: format!("rejected: {error}"),
    }
}

fn push_unique_reference(
    references: &mut Vec<AgentReference>,
    events: &mut Vec<AgentEvent>,
    event_sink: &Option<AgentEventSink>,
    reference: AgentReference,
) -> bool {
    if references
        .iter()
        .any(|existing| existing.kind == reference.kind && existing.path == reference.path)
    {
        return false;
    }
    emit_event(
        events,
        event_sink,
        AgentEvent::ReferenceAdded {
            reference: reference.clone(),
        },
    );
    references.push(reference);
    true
}

fn agent_iteration_limit_answer(
    max_iterations: usize,
    observation_count: usize,
    references: &[AgentReference],
) -> String {
    let mut seen_paths = BTreeSet::new();
    let workspace_paths: Vec<String> = references
        .iter()
        .filter(|reference| reference.kind == "workspace")
        .filter_map(|reference| {
            if reference.path.trim().is_empty() {
                None
            } else if seen_paths.insert(reference.path.clone()) {
                Some(reference.path.clone())
            } else {
                None
            }
        })
        .collect();

    if workspace_paths.is_empty() {
        return format!(
            "The Agent reached the tool-iteration limit after {max_iterations} step(s). It gathered {observation_count} tool observation(s), but did not produce a final answer. Please narrow the request or ask it to continue from the latest result."
        );
    }

    // Skills can successfully write deliverables and then spend the remaining
    // budget on optional validation or reference reads. Report confirmed files
    // instead of turning a completed write into a false failure.
    let mut answer = format!(
        "The Agent reached the tool-iteration budget after {max_iterations} step(s), but it did generate file(s).\n\nGenerated files:\n"
    );
    for path in workspace_paths {
        answer.push_str("- ");
        answer.push_str(&path);
        answer.push('\n');
    }
    answer.push_str(
        "\nOpen the generated file reference(s) to preview them. Some optional validation or follow-up steps may not have completed.",
    );
    answer
}

fn require_tool_permission(
    tool: &str,
    request: &AgentChatRequest,
    permission_policy: &PermissionPolicy,
) -> Result<(), String> {
    match tool {
        "wiki.search" => {
            if !request.tools.wiki {
                return Err("wiki.search is disabled for this turn".to_string());
            }
            permission_policy.require(AgentCapability::SearchWiki)
        }
        "wiki.read_page" | "graph.search" => {
            if !request.tools.wiki {
                return Err(format!("{tool} is disabled for this turn"));
            }
            permission_policy.require(AgentCapability::ReadProject)
        }
        "source.search" => {
            if !request.tools.wiki {
                return Err("source.search is disabled for this turn".to_string());
            }
            permission_policy.require(AgentCapability::ReadSource)
        }
        "wiki.write_page" => {
            if !request.tools.wiki {
                return Err("wiki.write_page is disabled for this turn".to_string());
            }
            permission_policy.require(AgentCapability::WriteWiki)
        }
        "workspace.write_file" | "workspace.append_file" => {
            permission_policy.require(AgentCapability::WriteWiki)
        }
        "web.search" => {
            if !request.tools.web {
                return Err("web.search is disabled for this turn".to_string());
            }
            permission_policy.require(AgentCapability::Network)
        }
        "anytxt.search" => {
            if !request.tools.anytxt {
                return Err("anytxt.search is disabled for this turn".to_string());
            }
            permission_policy.require(AgentCapability::Network)
        }
        "deep_research.run" => Err(
            "deep_research.run is not available in the loop executor; use web.search, anytxt.search, source.search, and wiki.search directly"
                .to_string(),
        ),
        "skill.read_file" => permission_policy.require(AgentCapability::ReadProject),
        "shell.exec" => permission_policy.require(AgentCapability::Process),
        other => Err(format!("Unknown Agent tool: {other}")),
    }
}

fn render_skill_planner_context(skills: &[AgentSkill], skill_mode: AgentSkillMode) -> String {
    if skills.is_empty() {
        return "None".to_string();
    }
    let mut out = String::new();
    match skill_mode {
        AgentSkillMode::Auto => {
            out.push_str("The following enabled skills are optional. Use them only if they match the request. Inspect a SKILL.md location only after deciding the skill is relevant.\n");
            out.push_str("<available_skills>\n");
            for skill in skills.iter().take(12) {
                out.push_str("  <skill>\n");
                out.push_str(&format!(
                    "    <name>{}</name>\n",
                    escape_planner_xml(&skill.name)
                ));
                out.push_str(&format!(
                    "    <description>{}</description>\n",
                    escape_planner_xml(skill.description.trim())
                ));
                out.push_str(&format!(
                    "    <location>{}</location>\n",
                    escape_planner_xml(&skill.location)
                ));
                out.push_str("  </skill>\n");
            }
            out.push_str("</available_skills>\n");
        }
        AgentSkillMode::Explicit => {
            out.push_str(
                "The following skills were explicitly selected by the user for this turn.\n",
            );
            for skill in skills.iter().take(8) {
                let base_dir = escape_planner_xml(&skill.base_dir);
                let instructions =
                    escape_planner_xml(&trim_chars(skill.instructions.trim(), 1_200));
                out.push_str(&format!(
                    "<skill name=\"{}\" location=\"{}\">\nReferences are relative to {}.\n\n{}\n</skill>\n",
                    escape_planner_xml(&skill.name),
                    escape_planner_xml(&skill.location),
                    base_dir,
                    instructions
                ));
            }
        }
    }
    trim_chars(&out, 8_000)
}

fn escape_planner_xml(input: &str) -> String {
    input
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

fn shell_command_from_call(call: &ModelToolCall) -> Option<&str> {
    call.command
        .as_deref()
        .or(call.query.as_deref())
        .or(call.content.as_deref())
        .map(str::trim)
        .filter(|command| !command.is_empty())
}

fn is_shell_command_approved(command: &str, approved: &[String]) -> bool {
    let command = command.trim();
    !command.is_empty() && approved.iter().any(|item| item.trim() == command)
}

fn is_shell_command_allowed_without_prompt(
    command: &str,
    approved: &[String],
    project_path: &str,
) -> bool {
    is_shell_command_approved(command, approved)
        || is_shell_command_scoped_to_agent_workspace(command, project_path)
}

fn is_shell_command_scoped_to_agent_workspace(command: &str, project_path: &str) -> bool {
    let command = command.trim();
    if command.is_empty() {
        return false;
    }
    let lower = command.to_ascii_lowercase();
    if lower.contains("http://")
        || lower.contains("https://")
        || lower.contains("ftp://")
        || lower.contains("sftp://")
        || lower.contains("curl ")
        || lower.starts_with("curl ")
        || lower.contains("wget ")
        || lower.starts_with("wget ")
        || lower.contains("scp ")
        || lower.starts_with("scp ")
        || lower.contains("ssh ")
        || lower.starts_with("ssh ")
        || lower.contains("$(")
        || command.contains('`')
    {
        return false;
    }

    let workspace = agent_workspace_display(project_path);
    let workspace_norm = normalize_shell_path_for_compare(&workspace);
    let project_norm = normalize_shell_path_for_compare(project_path);
    for token in shell_command_tokens(command) {
        if token.is_empty() {
            continue;
        }
        if shell_token_mentions_external_location(&token, &workspace_norm, &project_norm) {
            return false;
        }
    }
    true
}

fn shell_token_mentions_external_location(
    token: &str,
    workspace_norm: &str,
    project_norm: &str,
) -> bool {
    let token = token.trim_matches(|ch| matches!(ch, '"' | '\'' | ',' | ';'));
    if token.is_empty() {
        return false;
    }
    let lower = token.to_ascii_lowercase();
    if lower.starts_with('~')
        || lower.contains("$home")
        || lower.contains("${home")
        || lower.contains("%userprofile%")
        || lower.contains("%homepath%")
        || lower.contains("$xdg_")
        || lower.contains("${xdg_")
        || lower.contains("$tmp")
        || lower.contains("${tmp")
        || lower.contains("$temp")
        || lower.contains("${temp")
    {
        return true;
    }
    if token == ".." || token.starts_with("../") || token.contains("/../") || token.ends_with("/..")
    {
        return true;
    }
    let mut candidates = vec![token.to_string()];
    if let Some((_, value)) = token.split_once('=') {
        candidates.push(value.to_string());
    }
    for candidate in candidates {
        let candidate = candidate.trim_matches(|ch| matches!(ch, '"' | '\''));
        if candidate.is_empty() {
            continue;
        }
        if is_shell_absolute_path(candidate) {
            let normalized = normalize_shell_path_for_compare(candidate);
            let in_workspace = normalized == workspace_norm
                || normalized.starts_with(&format!("{workspace_norm}/"));
            let project_workspace_prefix = format!("{project_norm}/{AGENT_WORKSPACE_DIR}");
            let in_project_workspace = normalized == project_workspace_prefix
                || normalized.starts_with(&format!("{project_workspace_prefix}/"));
            if !in_workspace && !in_project_workspace {
                return true;
            }
        }
    }
    false
}

fn shell_command_tokens(command: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;
    for ch in command.chars() {
        if let Some(active) = quote {
            if ch == active {
                quote = None;
            } else {
                current.push(ch);
            }
            continue;
        }
        match ch {
            '\'' | '"' => quote = Some(ch),
            ch if ch.is_whitespace() || matches!(ch, ';' | '|' | '&' | '(' | ')' | '<' | '>') => {
                if !current.is_empty() {
                    tokens.push(std::mem::take(&mut current));
                }
            }
            _ => current.push(ch),
        }
    }
    if !current.is_empty() {
        tokens.push(current);
    }
    tokens
}

fn is_shell_absolute_path(value: &str) -> bool {
    value.starts_with('/')
        || value.starts_with("\\\\")
        || value.as_bytes().get(1).is_some_and(|byte| *byte == b':')
}

fn normalize_shell_path_for_compare(value: &str) -> String {
    value
        .trim_matches(|ch| matches!(ch, '"' | '\''))
        .replace('\\', "/")
        .trim_end_matches('/')
        .to_ascii_lowercase()
}

fn planned_tool_queries(plan: &ModelToolPlan, fallback_query: &str) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    for call in &plan.tool_calls {
        let tool = call.tool.trim();
        if !matches!(
            tool,
            "wiki.search"
                | "source.search"
                | "graph.search"
                | "web.search"
                | "anytxt.search"
                | "wiki.write_page"
        ) {
            continue;
        }
        let query = call
            .query
            .as_deref()
            .map(str::trim)
            .filter(|query| !query.is_empty())
            .unwrap_or(fallback_query);
        out.entry(tool.to_string())
            .or_insert_with(|| query.to_string());
    }
    out
}

fn parse_model_tool_plan(raw: &str) -> Result<ModelToolPlan, String> {
    let json_text = extract_json_object(raw).unwrap_or(raw).trim();
    serde_json::from_str(json_text).map_err(|err| format!("Invalid Agent tool plan JSON: {err}"))
}

fn extract_json_object(raw: &str) -> Option<&str> {
    let start = raw.find('{')?;
    let end = raw.rfind('}')?;
    if end <= start {
        return None;
    }
    Some(&raw[start..=end])
}

fn check_cancel(cancellation: Option<&AgentCancellationToken>) -> Result<(), String> {
    if let Some(token) = cancellation {
        token.check()?;
    }
    Ok(())
}

fn fit_context_to_model(
    mut context: BuiltAgentContext,
    config: Option<&LlmConfig>,
) -> BuiltAgentContext {
    let Some(max_context_size) = config.and_then(|cfg| cfg.max_context_size) else {
        return context;
    };
    let max_chars = max_context_size.clamp(8_000, 400_000);
    let total_chars = context.system.chars().count() + context.user.chars().count();
    if total_chars <= max_chars {
        return context;
    }
    let minimum_user_budget = 4_000;
    let system_budget = max_chars.saturating_sub(minimum_user_budget);
    if context.system.chars().count() > system_budget {
        context.system = trim_chars(&context.system, system_budget);
    }
    let user_budget = max_chars
        .saturating_sub(context.system.chars().count())
        .max(minimum_user_budget);
    context.user = trim_chars(&context.user, user_budget);
    context
}

// Tool futures may include network I/O or blocking-pool filesystem scans.
// Cancelling the turn should stop waiting for them immediately. A blocking task
// already running in Tokio's blocking pool cannot be force-killed, so the
// contract is "stop the Agent turn promptly", not "terminate the OS work".
async fn execute_tool_with_cancellation<F>(
    future: F,
    cancellation: Option<&AgentCancellationToken>,
) -> Result<serde_json::Value, String>
where
    F: Future<Output = Result<serde_json::Value, String>>,
{
    if let Some(token) = cancellation {
        tokio::select! {
            biased;
            _ = token.cancelled() => Err("Agent turn cancelled".to_string()),
            result = future => result,
        }
    } else {
        future.await
    }
}

fn validate_images(images: &[super::types::AgentImage]) -> Result<(), String> {
    if images.len() > MAX_IMAGES_PER_TURN {
        return Err(format!(
            "At most {MAX_IMAGES_PER_TURN} images can be attached to one Agent turn"
        ));
    }
    for image in images {
        let media_type = image.media_type.trim();
        if !matches!(
            media_type,
            "image/png" | "image/jpeg" | "image/webp" | "image/gif"
        ) {
            return Err(format!("Unsupported image media type: {media_type}"));
        }
        if image.data_base64.len() > MAX_IMAGE_BASE64_BYTES {
            return Err("Attached image is too large".to_string());
        }
        if image.data_base64.trim().is_empty() {
            return Err("Attached image is empty".to_string());
        }
    }
    Ok(())
}

fn emit_event(
    events: &mut Vec<AgentEvent>,
    event_sink: &Option<AgentEventSink>,
    event: AgentEvent,
) {
    if let Some(sink) = event_sink {
        sink(event.clone());
    }
    events.push(event);
}

fn tool_emit_event(
    tool_events: &mut Vec<AgentToolEvent>,
    _events: &mut Vec<AgentEvent>,
    _event_sink: &Option<AgentEventSink>,
    tool_event: AgentToolEvent,
) {
    tool_events.push(tool_event);
}

async fn generate_with_cancellation<P: AgentLlmProvider>(
    provider: &P,
    system: &str,
    user: &str,
    images: &[super::types::AgentImage],
    cancellation: Option<&AgentCancellationToken>,
) -> Result<String, String> {
    if let Some(token) = cancellation {
        tokio::select! {
            biased;
            _ = token.cancelled() => Err("Agent turn cancelled".to_string()),
            result = provider.generate_text(system, user, images) => result,
        }
    } else {
        provider.generate_text(system, user, images).await
    }
}

async fn generate_with_cancellation_stream<P, F>(
    provider: &P,
    system: &str,
    user: &str,
    images: &[super::types::AgentImage],
    cancellation: Option<&AgentCancellationToken>,
    on_delta: F,
) -> Result<String, String>
where
    P: AgentLlmProvider,
    F: FnMut(&str) + Send,
{
    if let Some(token) = cancellation {
        tokio::select! {
            biased;
            _ = token.cancelled() => Err("Agent turn cancelled".to_string()),
            result = provider.generate_text_stream(system, user, images, Box::new(on_delta)) => result,
        }
    } else {
        provider
            .generate_text_stream(system, user, images, Box::new(on_delta))
            .await
    }
}

fn build_retrieval_answer(query: &str, references: &[AgentReference]) -> String {
    if references.is_empty() {
        return format!(
            "I searched the current LLM Wiki project for \"{query}\" but did not find matching wiki pages."
        );
    }

    let mut out = format!(
        "I searched the current LLM Wiki project for \"{query}\" and found {} relevant page(s):",
        references.len()
    );
    for (idx, reference) in references.iter().take(MAX_CHAT_SEARCH_RESULTS).enumerate() {
        out.push_str(&format!(
            "\n{}. {} ({})",
            idx + 1,
            reference.title,
            reference.path
        ));
        if let Some(snippet) = reference.snippet.as_deref() {
            out.push_str(&format!("\n   {}", collapse_whitespace(snippet)));
        }
    }
    out
}

fn mode_label(mode: AgentMode) -> &'static str {
    match mode {
        AgentMode::Fast => "fast",
        AgentMode::Standard => "standard",
        AgentMode::Deep => "deep",
        AgentMode::LocalFirst => "local_first",
    }
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::PathBuf;

    use super::*;
    use crate::agent::types::{AgentMode, AgentToolOptions};

    fn temp_project(name: &str) -> PathBuf {
        let root =
            std::env::temp_dir().join(format!("llm-wiki-agent-test-{name}-{}", Uuid::new_v4()));
        fs::create_dir_all(root.join("wiki").join("concepts")).unwrap();
        root
    }

    #[tokio::test]
    async fn run_once_searches_wiki_and_returns_references() {
        let project = temp_project("search");
        fs::write(
            project.join("wiki").join("concepts").join("agent-runtime.md"),
            "---\ntitle: Agent Runtime\n---\n# Agent Runtime\n\nRust backend agent substrate with tool calls.",
        )
        .unwrap();

        let runtime = AgentRuntime::new(
            "project-1",
            project.to_string_lossy(),
            None,
            None,
            None,
            None,
        );
        let response = runtime
            .run_once(AgentChatRequest {
                message: "agent runtime".to_string(),
                session_id: Some("s1".to_string()),
                mode: AgentMode::Standard,
                tools: AgentToolOptions {
                    wiki: true,
                    web: false,
                    anytxt: false,
                },
                top_k: Some(3),
                include_content: Some(false),
                history: Vec::new(),
                skills: Vec::new(),
                ..Default::default()
            })
            .await
            .unwrap();

        assert!(response.ok);
        assert_eq!(response.session_id, "s1");
        assert_eq!(response.references.len(), 1);
        assert_eq!(
            response.references[0].path,
            "wiki/concepts/agent-runtime.md"
        );
        assert!(response.message.contains("Agent Runtime"));
        assert_eq!(response.tool_events[0].tool, "wiki.search");
    }

    #[tokio::test]
    async fn planner_unavailable_skill_turn_does_not_fall_back_to_wiki_search() {
        let project = temp_project("skill-no-fallback");
        fs::create_dir_all(project.join(".llm-wiki").join("skills").join("demo")).unwrap();
        fs::write(
            project
                .join(".llm-wiki")
                .join("skills")
                .join("demo")
                .join("SKILL.md"),
            "---\nname: demo\ndescription: Demo skill\n---\nUse this skill for demos.",
        )
        .unwrap();
        fs::write(
            project.join("wiki").join("concepts").join("skills.md"),
            "---\ntitle: Skills\n---\n# Skills\n\nThis page should not be retrieved.",
        )
        .unwrap();

        let runtime = AgentRuntime::new(
            "project-1",
            project.to_string_lossy(),
            None,
            None,
            None,
            None,
        );
        let response = runtime
            .run_once(AgentChatRequest {
                message: "你现在有哪些 skill 可以使用？".to_string(),
                session_id: Some("s1".to_string()),
                mode: AgentMode::Standard,
                tools: AgentToolOptions {
                    wiki: true,
                    web: false,
                    anytxt: false,
                },
                top_k: Some(3),
                include_content: Some(false),
                history: Vec::new(),
                skills: vec!["demo".to_string()],
                skill_mode: AgentSkillMode::Auto,
                ..Default::default()
            })
            .await
            .unwrap();

        assert!(response.ok);
        assert!(response.references.is_empty());
        assert!(response
            .tool_events
            .iter()
            .any(|event| event.tool == "skills.load"));
        assert!(!response
            .tool_events
            .iter()
            .any(|event| event.tool == "wiki.search"));
    }

    #[tokio::test]
    async fn run_once_rejects_empty_message() {
        let project = temp_project("empty");
        let runtime = AgentRuntime::new(
            "project-1",
            project.to_string_lossy(),
            None,
            None,
            None,
            None,
        );
        let err = runtime
            .run_once(AgentChatRequest {
                message: "   ".to_string(),
                session_id: None,
                mode: AgentMode::Fast,
                tools: AgentToolOptions::default(),
                top_k: None,
                include_content: None,
                history: Vec::new(),
                skills: Vec::new(),
                ..Default::default()
            })
            .await
            .unwrap_err();
        assert_eq!(err, "message is required");
    }

    #[test]
    fn fit_context_to_model_honors_configured_context_size() {
        let context = BuiltAgentContext {
            system: "system".repeat(100),
            user: "user".repeat(10_000),
        };
        let config = LlmConfig {
            provider: "custom".to_string(),
            api_key: String::new(),
            model: "local".to_string(),
            ollama_url: String::new(),
            custom_endpoint: "http://127.0.0.1:11434/v1".to_string(),
            azure_api_version: None,
            api_mode: None,
            reasoning: None,
            max_tokens: None,
            max_context_size: Some(8_000),
        };
        let fitted = fit_context_to_model(context, Some(&config));
        assert!(fitted.system.contains("system"));
        assert!(fitted.user.chars().count() <= 7_400);
        assert!(fitted.user.ends_with("..."));
    }

    #[test]
    fn fit_context_to_model_trims_oversized_system_context() {
        let context = BuiltAgentContext {
            system: "系统".repeat(10_000),
            user: "用户".repeat(10_000),
        };
        let config = LlmConfig {
            provider: "custom".to_string(),
            api_key: String::new(),
            model: "local".to_string(),
            ollama_url: String::new(),
            custom_endpoint: "http://127.0.0.1:11434/v1".to_string(),
            azure_api_version: None,
            api_mode: None,
            reasoning: None,
            max_tokens: None,
            max_context_size: Some(8_000),
        };

        let fitted = fit_context_to_model(context, Some(&config));

        assert!(fitted.system.ends_with("..."));
        assert!(fitted.user.ends_with("..."));
        assert!(fitted.system.chars().count() + fitted.user.chars().count() <= 8_000);
    }

    #[tokio::test]
    async fn run_once_can_disable_wiki_tool() {
        let project = temp_project("disabled");
        let runtime = AgentRuntime::new(
            "project-1",
            project.to_string_lossy(),
            None,
            None,
            None,
            None,
        );
        let response = runtime
            .run_once(AgentChatRequest {
                message: "anything".to_string(),
                session_id: None,
                mode: AgentMode::LocalFirst,
                tools: AgentToolOptions {
                    wiki: false,
                    web: false,
                    anytxt: false,
                },
                top_k: None,
                include_content: None,
                history: Vec::new(),
                skills: Vec::new(),
                ..Default::default()
            })
            .await
            .unwrap();

        assert!(response.references.is_empty());
        assert!(response.tool_events.is_empty());
        assert!(response.message.contains("No Agent tools were enabled"));
    }

    #[tokio::test]
    async fn run_once_in_fast_mode_exposes_tools_without_presearching() {
        let project = temp_project("fast");
        fs::write(
            project.join("overview.md"),
            "This project covers search routing.",
        )
        .unwrap();
        fs::write(
            project.join("wiki").join("concepts").join("routing.md"),
            "# Routing\n\nThis should not be searched in fast mode.",
        )
        .unwrap();

        let runtime = AgentRuntime::new(
            "project-1",
            project.to_string_lossy(),
            None,
            None,
            None,
            None,
        );
        let response = runtime
            .run_once(AgentChatRequest {
                message: "routing details?".to_string(),
                session_id: None,
                mode: AgentMode::Fast,
                tools: AgentToolOptions {
                    wiki: true,
                    web: true,
                    anytxt: false,
                },
                top_k: Some(3),
                include_content: Some(false),
                history: Vec::new(),
                skills: Vec::new(),
                ..Default::default()
            })
            .await
            .unwrap();

        assert!(response.references.is_empty());
        assert!(response
            .tool_events
            .iter()
            .any(|event| event.tool == "web.search" && event.status == "available"));
        assert!(response.message.contains("Router intent"));
    }

    #[tokio::test]
    async fn optional_tool_failure_does_not_abort_turn() {
        let project = temp_project("web-fail");
        let runtime = AgentRuntime::new(
            "project-1",
            project.to_string_lossy(),
            None,
            None,
            None,
            None,
        );
        let response = runtime
            .run_once(AgentChatRequest {
                message: "latest external update".to_string(),
                session_id: None,
                mode: AgentMode::Standard,
                tools: AgentToolOptions {
                    wiki: false,
                    web: true,
                    anytxt: false,
                },
                top_k: Some(3),
                include_content: Some(false),
                history: Vec::new(),
                skills: Vec::new(),
                ..Default::default()
            })
            .await
            .unwrap();

        assert!(response.ok);
        assert!(response
            .tool_events
            .iter()
            .any(|event| event.tool == "web.search" && event.status == "failed"));
        assert!(!response
            .events
            .iter()
            .any(|event| matches!(event, AgentEvent::Error { .. })));
    }

    #[tokio::test]
    async fn run_once_can_include_raw_source_search_for_source_questions() {
        let project = temp_project("source");
        let source_dir = project.join("raw").join("sources");
        fs::create_dir_all(&source_dir).unwrap();
        fs::write(source_dir.join("coal.txt"), "煤矿安全治理 source details.").unwrap();

        let runtime = AgentRuntime::new(
            "project-1",
            project.to_string_lossy(),
            None,
            None,
            None,
            None,
        );
        let response = runtime
            .run_once(AgentChatRequest {
                message: "原始资料 煤矿安全".to_string(),
                session_id: None,
                mode: AgentMode::Deep,
                tools: AgentToolOptions::default(),
                top_k: Some(3),
                include_content: Some(false),
                history: Vec::new(),
                skills: Vec::new(),
                ..Default::default()
            })
            .await
            .unwrap();

        assert!(response
            .references
            .iter()
            .any(|reference| reference.kind == "source"));
        assert!(response
            .tool_events
            .iter()
            .any(|event| event.tool == "source.search"));
    }

    #[tokio::test]
    async fn deep_mode_reads_top_wiki_pages_after_search() {
        let project = temp_project("deep-read");
        fs::write(
            project.join("wiki").join("concepts").join("deep-agent.md"),
            "---\ntitle: Deep Agent\n---\n# Deep Agent\n\nDetailed evidence that should be read in deep mode.",
        )
        .unwrap();

        let runtime = AgentRuntime::new(
            "project-1",
            project.to_string_lossy(),
            None,
            None,
            None,
            None,
        );
        let response = runtime
            .run_once(AgentChatRequest {
                message: "deep agent evidence".to_string(),
                session_id: None,
                mode: AgentMode::Deep,
                tools: AgentToolOptions::default(),
                top_k: Some(3),
                include_content: Some(false),
                history: Vec::new(),
                skills: Vec::new(),
                ..Default::default()
            })
            .await
            .unwrap();

        assert!(response
            .tool_events
            .iter()
            .any(|event| event.tool == "wiki.read_page" && event.status == "completed"));
        assert!(response.message.contains("Detailed evidence"));
    }

    #[tokio::test]
    async fn turn_start_event_uses_api_mode_label() {
        let project = temp_project("mode-label");
        let runtime = AgentRuntime::new(
            "project-1",
            project.to_string_lossy(),
            None,
            None,
            None,
            None,
        );
        let response = runtime
            .run_once(AgentChatRequest {
                message: "hello".to_string(),
                session_id: None,
                mode: AgentMode::LocalFirst,
                tools: AgentToolOptions {
                    wiki: false,
                    web: false,
                    anytxt: false,
                },
                top_k: None,
                include_content: None,
                history: Vec::new(),
                skills: Vec::new(),
                ..Default::default()
            })
            .await
            .unwrap();

        assert!(response
            .events
            .iter()
            .any(|event| matches!(event, AgentEvent::TurnStart { mode } if mode == "local_first")));
    }

    #[tokio::test]
    async fn graph_questions_run_graph_search_tool() {
        let project = temp_project("graph");
        fs::write(
            project.join("wiki").join("concepts").join("graph.md"),
            "---\ntitle: Graph Relations\n---\n# Graph Relations\n\n[[A]] links to [[B]].",
        )
        .unwrap();

        let runtime = AgentRuntime::new(
            "project-1",
            project.to_string_lossy(),
            None,
            None,
            None,
            None,
        );
        let response = runtime
            .run_once(AgentChatRequest {
                message: "知识图谱 Graph Relations".to_string(),
                session_id: None,
                mode: AgentMode::Standard,
                tools: AgentToolOptions::default(),
                top_k: Some(3),
                include_content: None,
                history: Vec::new(),
                skills: Vec::new(),
                ..Default::default()
            })
            .await
            .unwrap();

        assert!(response
            .tool_events
            .iter()
            .any(|event| event.tool == "graph.search" && event.status == "completed"));
        assert!(response
            .references
            .iter()
            .any(|reference| reference.kind == "graph"));
    }

    #[test]
    fn parses_model_tool_plan_from_wrapped_json() {
        let plan = parse_model_tool_plan(
            "```json\n{\"toolCalls\":[{\"tool\":\"web.search\",\"query\":\"llm wiki release\"}]}\n```",
        )
        .unwrap();
        let queries = planned_tool_queries(&plan, "fallback");
        assert_eq!(
            queries.get("web.search").map(String::as_str),
            Some("llm wiki release")
        );
    }

    #[test]
    fn planned_tool_queries_ignore_non_query_tool_names() {
        let plan = parse_model_tool_plan(
            "{\"toolCalls\":[{\"tool\":\"shell.exec\",\"query\":\"rm -rf\"},{\"tool\":\"wiki.search\"}]}",
        )
        .unwrap();
        let queries = planned_tool_queries(&plan, "safe query");
        assert_eq!(queries.len(), 1);
        assert_eq!(
            queries.get("wiki.search").map(String::as_str),
            Some("safe query")
        );
    }

    #[test]
    fn parses_shell_exec_timeout_from_model_tool_plan() {
        let plan = parse_model_tool_plan(
            "{\"toolCalls\":[{\"tool\":\"shell.exec\",\"command\":\"echo ok\",\"timeoutSeconds\":2}]}",
        )
        .unwrap();
        let shell_call = plan
            .tool_calls
            .iter()
            .find(|call| call.tool == "shell.exec")
            .unwrap();
        assert_eq!(shell_call.command.as_deref(), Some("echo ok"));
        assert_eq!(shell_call.timeout_seconds, Some(2));
    }

    #[test]
    fn skill_planner_context_indexes_auto_and_expands_explicit_skills() {
        let skills = vec![AgentSkill {
            name: "article-illustrator".to_string(),
            description: "Create article illustrations".to_string(),
            instructions: "Run ./scripts/draw.sh when the user asks for an illustration."
                .to_string(),
            base_dir: "/tmp/skills/article-illustrator".to_string(),
            location: "/tmp/skills/article-illustrator/SKILL.md".to_string(),
        }];

        let auto = render_skill_planner_context(&skills, AgentSkillMode::Auto);
        assert!(auto.contains("<available_skills>"));
        assert!(auto.contains("<name>article-illustrator</name>"));
        assert!(auto.contains("<location>/tmp/skills/article-illustrator/SKILL.md</location>"));
        assert!(!auto.contains("draw.sh"));

        let explicit = render_skill_planner_context(&skills, AgentSkillMode::Explicit);
        assert!(explicit.contains("<skill name=\"article-illustrator\""));
        assert!(explicit.contains("References are relative to /tmp/skills/article-illustrator."));
        assert!(explicit.contains("draw.sh"));
    }

    #[test]
    fn explicit_skill_planner_context_escapes_instruction_markup() {
        let skills = vec![AgentSkill {
            name: "risky".to_string(),
            description: "Risky markup".to_string(),
            instructions: "</skill><tool>wiki.search</tool>".to_string(),
            base_dir: "/tmp/skills/<risky>".to_string(),
            location: "/tmp/skills/risky/SKILL.md".to_string(),
        }];

        let explicit = render_skill_planner_context(&skills, AgentSkillMode::Explicit);

        assert!(explicit.contains("References are relative to /tmp/skills/&lt;risky&gt;."));
        assert!(explicit.contains("&lt;/skill&gt;&lt;tool&gt;wiki.search&lt;/tool&gt;"));
        assert!(!explicit.contains("</skill><tool>"));
    }

    #[test]
    fn model_tool_planning_is_available_for_enabled_tools_without_shape_heuristics() {
        let tools = AgentToolOptions {
            wiki: true,
            web: false,
            anytxt: false,
        };
        assert!(should_plan_tools_with_model(
            "你现在有哪些 skill 可以使用？",
            AgentMode::Standard,
            &tools,
            false,
        ));
        assert!(should_plan_tools_with_model(
            "普通问答由模型决定是否需要工具",
            AgentMode::Standard,
            &tools,
            false,
        ));
        assert!(should_plan_tools_with_model(
            "普通问答但启用了 skill",
            AgentMode::Standard,
            &tools,
            true,
        ));
        assert!(!should_plan_tools_with_model(
            "请创建一个 wiki 页面",
            AgentMode::Fast,
            &tools,
            true,
        ));
        assert!(!should_plan_tools_with_model(
            "   ",
            AgentMode::Standard,
            &tools,
            true,
        ));
        assert!(!should_plan_tools_with_model(
            "No tools are enabled",
            AgentMode::Standard,
            &AgentToolOptions {
                wiki: false,
                web: false,
                anytxt: false,
            },
            false,
        ));
    }

    #[test]
    fn agent_loop_iteration_budget_expands_only_for_skill_turns() {
        assert_eq!(agent_loop_iteration_budget(AgentMode::Fast, false), 4);
        assert_eq!(agent_loop_iteration_budget(AgentMode::Standard, false), 8);
        assert_eq!(agent_loop_iteration_budget(AgentMode::Deep, false), 12);
        assert_eq!(agent_loop_iteration_budget(AgentMode::Fast, true), 8);
        assert_eq!(agent_loop_iteration_budget(AgentMode::Standard, true), 16);
        assert_eq!(agent_loop_iteration_budget(AgentMode::LocalFirst, true), 16);
        assert_eq!(agent_loop_iteration_budget(AgentMode::Deep, true), 20);
    }

    #[test]
    fn retrieval_budget_expands_only_for_explicit_skill_turns() {
        assert_eq!(
            agent_loop_retrieval_budget(AgentMode::Fast, AgentRetrievalMode::Standard, false),
            2
        );
        assert_eq!(
            agent_loop_retrieval_budget(AgentMode::Standard, AgentRetrievalMode::Standard, false),
            4
        );
        assert_eq!(
            agent_loop_retrieval_budget(AgentMode::LocalFirst, AgentRetrievalMode::Standard, false),
            4
        );
        assert_eq!(
            agent_loop_retrieval_budget(AgentMode::Deep, AgentRetrievalMode::Standard, false),
            8
        );
        assert_eq!(
            agent_loop_retrieval_budget(AgentMode::Standard, AgentRetrievalMode::Standard, true),
            8
        );
        assert_eq!(
            agent_loop_retrieval_budget(AgentMode::Deep, AgentRetrievalMode::Standard, true),
            12
        );
        assert_eq!(
            agent_loop_retrieval_budget(AgentMode::Standard, AgentRetrievalMode::Smart, false),
            4
        );
        assert_eq!(
            agent_loop_retrieval_budget(AgentMode::Deep, AgentRetrievalMode::Smart, true),
            6
        );
    }

    #[test]
    fn smart_retrieval_normalizes_equivalent_query_signatures() {
        let left = serde_json::json!({"query": "Agent,   Runtime!", "topK": 5});
        let right = serde_json::json!({"query": "agent runtime", "topK": 5});
        assert_eq!(
            retrieval_signature("wiki.search", &left, AgentRetrievalMode::Smart),
            retrieval_signature("wiki.search", &right, AgentRetrievalMode::Smart),
        );
        assert_ne!(
            retrieval_signature("wiki.search", &left, AgentRetrievalMode::Standard),
            retrieval_signature("wiki.search", &right, AgentRetrievalMode::Standard),
        );
    }

    #[test]
    fn smart_retrieval_prompt_explains_bounded_evidence_loop() {
        let prompt = build_agent_loop_system("base", AgentRetrievalMode::Smart);
        assert!(prompt.contains("bounded evidence loop"));
        assert!(prompt.contains("Do not repeat equivalent queries"));
        assert!(
            !build_agent_loop_system("base", AgentRetrievalMode::Standard)
                .contains("bounded evidence loop")
        );
    }

    #[test]
    fn smart_retrieval_counts_page_reads_but_not_repeated_searches_as_new_evidence() {
        assert!(retrieval_added_evidence(
            "wiki.search",
            "1 result(s), 1 new",
            0,
            1
        ));
        assert!(!retrieval_added_evidence(
            "wiki.search",
            "1 result(s), 0 new",
            1,
            1
        ));
        assert!(retrieval_added_evidence(
            "wiki.read_page",
            "read wiki/a.md\npage content",
            1,
            1
        ));
        assert!(!retrieval_added_evidence(
            "wiki.read_page",
            "read wiki/a.md\n",
            1,
            1
        ));
    }

    #[test]
    fn forced_final_answer_prefers_model_final_content() {
        let raw = r#"{"action":"final","answer":"grounded answer"}"#;
        let action = parse_agent_loop_action(raw);
        assert_eq!(forced_final_answer(raw, &action, &[]), "grounded answer");
    }

    #[test]
    fn finalization_prompt_removes_tool_choice() {
        let system = build_agent_final_system("base");
        let user = build_agent_final_user(
            "question",
            &[AgentObservation {
                tool: "wiki.search".to_string(),
                summary: "2 results".to_string(),
            }],
        );
        assert!(system.contains("No tools are available"));
        assert!(system.contains(r#"{"action":"final""#));
        assert!(user.contains("No further tool action is permitted"));
        assert!(user.contains("wiki.search"));
    }

    #[test]
    fn agent_loop_user_prompt_warns_before_iteration_budget_is_exhausted() {
        let prompt = build_agent_loop_user(
            "Base user",
            &AgentChatRequest::default(),
            &[],
            &[AgentObservation {
                tool: "workspace.write_file".to_string(),
                summary: "wrote agent-workspace/article.md (1024 bytes)".to_string(),
            }],
            14,
            16,
            true,
        );

        assert!(prompt.contains("step 15 of 16"));
        assert!(prompt.contains("A generated workspace file has already been observed"));
        assert!(prompt.contains("Budget is nearly exhausted"));
        assert!(prompt.contains(r#"{"action":"final","answer":"..."}"#));
    }

    #[test]
    fn agent_structured_output_budget_expands_for_skill_turns() {
        assert_eq!(agent_structured_max_tokens(false), 8192);
        assert_eq!(agent_structured_max_tokens(true), 16384);
    }

    #[test]
    fn empty_model_plan_does_not_request_wiki_search() {
        let plan = parse_model_tool_plan("{\"toolCalls\":[]}").unwrap();
        let queries = planned_tool_queries(&plan, "fallback query");
        assert!(!queries.contains_key("wiki.search"));
    }

    #[test]
    fn agent_loop_action_parses_wrapped_tool_json() {
        let action = parse_agent_loop_action(
            "```json\n{\"action\":\"tool\",\"tool\":\"wiki.search\",\"query\":\"alpha\"}\n```",
        );

        assert_eq!(action.action, "tool");
        assert_eq!(action.tool.as_deref(), Some("wiki.search"));
        assert_eq!(action.query.as_deref(), Some("alpha"));
    }

    #[test]
    fn agent_loop_action_parses_workspace_write_file_json() {
        let action = parse_agent_loop_action(
            r####"{
              "action": "workspace.write_file",
              "path": "cover-image/xin-wu-ran-wu-zhi-li/prompts/cover.md",
              "content": "## Cover Image Prompt\n\nTopic: 新污染物治理 · 新化学物质环境管理登记\n\nDimensions:\n- Type: conceptual\n- Palette: cool (blue-green tones)\n- Rendering: flat-vector\n- Text: title-only\n- Mood: balanced\n- Font: clean (sans-serif)\n- Aspect: 16:9\n\nComposition:\n- Background: deep blue gradient (#0b3d6b → #1a5a7a) with geometric hexagonal grid pattern (transparent white lines)\n- Center-left visual anchor: a stylized document icon with a chemical structure (benzene ring) partially overlaid, representing regulation + chemistry\n- Title text: \"新污染物治理 · 新化学物质环境管理登记\" — centered-bottom, white, clean sans-serif, subtle text shadow"
            }"####,
        );

        assert_eq!(action.action, "tool");
        assert_eq!(action.tool.as_deref(), Some("workspace.write_file"));
        assert_eq!(
            action.path.as_deref(),
            Some("cover-image/xin-wu-ran-wu-zhi-li/prompts/cover.md"),
        );
        assert!(action.content.as_deref().unwrap().contains("新污染物治理"));
    }

    #[test]
    fn agent_loop_action_parses_workspace_append_file_json() {
        let action = parse_agent_loop_action(
            r#"{"action":"tool","tool":"workspace.append_file","path":"ppt/index.html","content":"</html>"}"#,
        );

        assert_eq!(action.action, "tool");
        assert_eq!(action.tool.as_deref(), Some("workspace.append_file"));
        assert_eq!(action.path.as_deref(), Some("ppt/index.html"));
        assert_eq!(action.content.as_deref(), Some("</html>"));
    }

    #[test]
    fn agent_loop_action_treats_valid_tool_field_as_tool_action() {
        let action = parse_agent_loop_action(
            r#"{"action":"skill","tool":"skill.read_file","path":"references/themes.md"}"#,
        );

        assert_eq!(action.action, "tool");
        assert_eq!(action.tool.as_deref(), Some("skill.read_file"));
        assert_eq!(action.path.as_deref(), Some("references/themes.md"));
    }

    #[test]
    fn workspace_write_tool_input_allows_empty_initializer_content() {
        let project = tempdir_for_agent_runtime_test();
        let runtime = AgentRuntime::new(
            "project-1",
            project.to_string_lossy(),
            None,
            None,
            None,
            None,
        );
        let action = AgentLoopAction {
            action: "tool".to_string(),
            tool: Some("workspace.write_file".to_string()),
            path: Some("ppt/index.html".to_string()),
            content: Some(String::new()),
            ..AgentLoopAction::default()
        };

        let input = runtime
            .agent_loop_tool_input(
                &AgentChatRequest::default(),
                "workspace.write_file",
                &action,
            )
            .unwrap();

        assert_eq!(input["path"], "ppt/index.html");
        assert_eq!(input["content"], "");
        let _ = std::fs::remove_dir_all(project);
    }

    #[test]
    fn malformed_tool_json_is_not_treated_as_final_answer() {
        let action = parse_agent_loop_action(
            "{\"action\":\"tool\",\"tool\":\"shell.exec\",\"command\":\"cat > cover.svg << 'EOF'\n<svg>",
        );

        assert_eq!(action.action, "invalid_tool_json");
        assert!(action
            .answer
            .as_deref()
            .unwrap()
            .contains("workspace.append_file"));
    }

    #[test]
    fn agent_loop_action_normalizes_user_ask_alias() {
        let action = parse_agent_loop_action(
            "{\"action\":\"tool\",\"tool\":\"AskUserQuestion\",\"questions\":[{\"id\":\"palette\",\"question\":\"Palette?\",\"options\":[{\"label\":\"Auto\",\"value\":\"auto\"}]}]}",
        );

        assert_eq!(action.tool.as_deref(), Some("user.ask"));
        let request = sanitize_user_input_request(&action).unwrap();
        assert_eq!(request.fields[0].id, "palette");
        assert_eq!(request.fields[0].field_type, "single");
    }

    #[test]
    fn user_ask_sanitizes_generic_field_schema() {
        let action = parse_agent_loop_action(
            r#"{
                "action":"tool",
                "tool":"user.ask",
                "title":"Cover setup",
                "fields":[
                    {"type":"text","id":"watermark","label":"Watermark","placeholder":"Optional"},
                    {"type":"multiChoice","id":"channels","label":"Channels","options":[{"label":"Web","value":"web"},{"label":"Print","value":"print"}]}
                ]
            }"#,
        );

        let request = sanitize_user_input_request(&action).unwrap();
        assert_eq!(request.title, "Cover setup");
        assert_eq!(request.fields.len(), 2);
        assert_eq!(request.fields[0].field_type, "text");
        assert_eq!(request.fields[1].field_type, "multi");
        assert_eq!(request.fields[1].options.len(), 2);
    }

    #[test]
    fn user_ask_drops_unknown_field_types_without_failing_valid_fields() {
        let action = parse_agent_loop_action(
            r#"{
                "action":"tool",
                "tool":"user.ask",
                "fields":[
                    {"type":"date","id":"deadline","label":"Deadline"},
                    {"type":"text","id":"topic","label":"Topic"}
                ]
            }"#,
        );

        let request = sanitize_user_input_request(&action).unwrap();
        assert_eq!(request.fields.len(), 1);
        assert_eq!(request.fields[0].id, "topic");
        assert_eq!(request.fields[0].field_type, "text");
    }

    #[test]
    fn user_ask_deduplicates_field_ids_and_option_values() {
        let action = parse_agent_loop_action(
            r#"{
                "action":"tool",
                "tool":"user.ask",
                "fields":[
                    {
                        "type":"single",
                        "id":"choice",
                        "label":"Primary",
                        "options":[
                            {"label":"Auto","value":"auto"},
                            {"label":"Auto again","value":"auto"}
                        ]
                    },
                    {
                        "type":"text",
                        "id":"choice",
                        "label":"Notes"
                    }
                ]
            }"#,
        );

        let request = sanitize_user_input_request(&action).unwrap();
        assert_eq!(request.fields[0].id, "choice");
        assert_eq!(request.fields[1].id, "choice_2");
        assert_eq!(request.fields[0].options[0].value, "auto");
        assert_eq!(request.fields[0].options[1].value, "auto_2");
    }

    #[test]
    fn user_ask_rejects_invalid_choice_defaults() {
        let action = parse_agent_loop_action(
            r#"{
                "action":"tool",
                "tool":"user.ask",
                "fields":[
                    {
                        "type":"single",
                        "id":"palette",
                        "label":"Palette",
                        "defaultValue":"missing",
                        "options":[{"label":"Auto","value":"auto"}]
                    }
                ]
            }"#,
        );

        let request = sanitize_user_input_request(&action).unwrap();
        assert!(request.fields[0].default_value.is_none());
    }

    #[test]
    fn user_ask_preserves_valid_choice_defaults() {
        let action = parse_agent_loop_action(
            r#"{
                "action":"tool",
                "tool":"user.ask",
                "fields":[
                    {
                        "type":"single",
                        "id":"palette",
                        "label":"Palette",
                        "defaultValue":"auto",
                        "options":[{"label":"Auto","value":"auto"}]
                    },
                    {
                        "type":"multi",
                        "id":"channels",
                        "label":"Channels",
                        "defaultValue":["web"],
                        "options":[{"label":"Web","value":"web"}]
                    }
                ]
            }"#,
        );

        let request = sanitize_user_input_request(&action).unwrap();
        assert_eq!(
            request.fields[0].default_value,
            Some(serde_json::json!("auto"))
        );
        assert_eq!(
            request.fields[1].default_value,
            Some(serde_json::json!(["web"]))
        );
    }

    #[test]
    fn user_ask_empty_or_all_invalid_fields_return_schema_error() {
        let empty = parse_agent_loop_action(r#"{"action":"tool","tool":"user.ask","fields":[]}"#);
        let invalid = parse_agent_loop_action(
            r#"{"action":"tool","tool":"user.ask","fields":[{"type":"date","label":"When?"}]}"#,
        );

        assert!(sanitize_user_input_request(&empty)
            .unwrap_err()
            .contains("at least one valid field"));
        assert!(sanitize_user_input_request(&invalid)
            .unwrap_err()
            .contains("at least one valid field"));
    }

    #[test]
    fn agent_loop_action_rejects_plain_text_so_protocol_stays_language_agnostic() {
        let action = parse_agent_loop_action("plain answer");

        assert_eq!(action.action, "invalid_tool_json");
        assert!(action
            .answer
            .as_deref()
            .unwrap_or_default()
            .contains("must be compact JSON"));
    }

    #[test]
    fn agent_loop_action_rejects_natural_language_tool_plan_without_language_heuristics() {
        let action = parse_agent_loop_action(
            "I need to read a few key wiki pages to understand the material well enough before crafting the article.",
        );

        assert_eq!(action.action, "invalid_tool_json");
        assert!(action
            .answer
            .as_deref()
            .unwrap_or_default()
            .contains("must be compact JSON"));
    }

    #[test]
    fn agent_loop_permission_respects_disabled_external_tools() {
        let request = AgentChatRequest {
            tools: AgentToolOptions {
                wiki: true,
                web: false,
                anytxt: false,
            },
            ..AgentChatRequest::default()
        };
        let policy = PermissionPolicy::api_default();

        assert!(require_tool_permission("wiki.search", &request, &policy).is_ok());
        assert!(require_tool_permission("web.search", &request, &policy)
            .unwrap_err()
            .contains("disabled"));
        assert!(require_tool_permission("anytxt.search", &request, &policy)
            .unwrap_err()
            .contains("disabled"));
    }

    #[test]
    fn agent_loop_observations_include_tool_names() {
        let text = render_observations(&[AgentObservation {
            tool: "shell.exec".to_string(),
            summary: "created report.html".to_string(),
        }]);

        assert!(text.contains("shell.exec"));
        assert!(text.contains("created report.html"));
    }

    #[test]
    fn agent_loop_rejection_is_returned_as_observation() {
        let mut tool_events = Vec::new();
        let mut events = Vec::new();
        let observation = record_loop_tool_rejection(
            "web.search",
            "web.search is disabled for this turn".to_string(),
            &mut tool_events,
            &mut events,
            &None,
        );

        assert_eq!(observation.tool, "web.search");
        assert!(observation.summary.contains("disabled"));
        assert_eq!(tool_events[0].status, "failed");
    }

    #[test]
    fn shell_approval_observation_ends_current_loop_turn() {
        let observation = AgentObservation {
            tool: SHELL_APPROVAL_REQUIRED_OBSERVATION.to_string(),
            summary: "The Agent needs approval before it can run this command".to_string(),
        };

        assert!(is_shell_approval_required_observation(&observation));
    }

    #[test]
    fn skill_preference_probe_commands_are_not_sent_to_shell_approval() {
        let command = "test -f .baoyu-skills/baoyu-cover-image/EXTEND.md && echo 'project'; test -f \"${XDG_CONFIG_HOME:-$HOME/.config}/baoyu-skills/baoyu-cover-image/EXTEND.md\" && echo 'xdg'";

        assert!(is_skill_preference_probe_command(command));
        assert!(skipped_skill_preference_probe_summary(command).contains("do not retry"));
    }

    #[test]
    fn skill_read_file_reads_only_active_skill_relative_files() {
        let temp = tempdir_for_agent_runtime_test();
        let skill_dir = temp.join("baoyu-cover-image");
        std::fs::create_dir_all(skill_dir.join("references")).unwrap();
        std::fs::write(skill_dir.join("references/types.md"), "type guide").unwrap();
        let skill = AgentSkill {
            name: "baoyu-cover-image".to_string(),
            description: "cover".to_string(),
            instructions: "Use references/types.md when needed.".to_string(),
            base_dir: skill_dir.to_string_lossy().to_string(),
            location: skill_dir.join("SKILL.md").to_string_lossy().to_string(),
        };

        let value = read_active_skill_file(
            &[skill],
            &serde_json::json!({ "path": "references/types.md" }),
        )
        .unwrap();

        assert_eq!(
            value.get("skill").and_then(Value::as_str),
            Some("baoyu-cover-image")
        );
        assert_eq!(
            value.get("content").and_then(Value::as_str),
            Some("type guide")
        );
    }

    #[test]
    fn skill_read_file_resolves_prefixed_and_absolute_paths_with_multiple_skills() {
        let temp = tempdir_for_agent_runtime_test();
        let cover_dir = temp.join("baoyu-cover-image");
        let other_dir = temp.join("other-skill");
        std::fs::create_dir_all(cover_dir.join("references")).unwrap();
        std::fs::create_dir_all(&other_dir).unwrap();
        std::fs::write(cover_dir.join("SKILL.md"), "cover skill").unwrap();
        std::fs::write(cover_dir.join("references/types.md"), "type guide").unwrap();
        std::fs::write(other_dir.join("SKILL.md"), "other").unwrap();
        let cover = AgentSkill {
            name: "baoyu-cover-image".to_string(),
            description: "cover".to_string(),
            instructions: "Use refs lazily.".to_string(),
            base_dir: cover_dir.to_string_lossy().to_string(),
            location: cover_dir.join("SKILL.md").to_string_lossy().to_string(),
        };
        let other = AgentSkill {
            name: "other-skill".to_string(),
            description: "other".to_string(),
            instructions: "Other.".to_string(),
            base_dir: other_dir.to_string_lossy().to_string(),
            location: other_dir.join("SKILL.md").to_string_lossy().to_string(),
        };
        let skills = vec![cover, other];

        let prefixed = read_active_skill_file(
            &skills,
            &serde_json::json!({ "path": "baoyu-cover-image/references/types.md" }),
        )
        .unwrap();
        let colon_prefixed = read_active_skill_file(
            &skills,
            &serde_json::json!({ "path": "baoyu-cover-image:references/types.md" }),
        )
        .unwrap();
        let explicit_colon_prefixed = read_active_skill_file(
            &skills,
            &serde_json::json!({
                "skill": "baoyu-cover-image",
                "path": "baoyu-cover-image:references/types.md"
            }),
        )
        .unwrap();
        let unique_relative = read_active_skill_file(
            &skills,
            &serde_json::json!({ "path": "references/types.md" }),
        )
        .unwrap();
        let suffix_prefixed = read_active_skill_file(
            &skills,
            &serde_json::json!({ "path": "cover-image/SKILL.md" }),
        )
        .unwrap();
        let absolute = read_active_skill_file(
            &skills,
            &serde_json::json!({ "path": cover_dir.join("SKILL.md").to_string_lossy() }),
        )
        .unwrap();

        assert_eq!(
            prefixed.get("content").and_then(Value::as_str),
            Some("type guide")
        );
        assert_eq!(
            colon_prefixed.get("path").and_then(Value::as_str),
            Some("references/types.md")
        );
        assert_eq!(
            colon_prefixed.get("content").and_then(Value::as_str),
            Some("type guide")
        );
        assert_eq!(
            explicit_colon_prefixed.get("path").and_then(Value::as_str),
            Some("references/types.md")
        );
        assert_eq!(
            unique_relative.get("skill").and_then(Value::as_str),
            Some("baoyu-cover-image")
        );
        assert_eq!(
            suffix_prefixed.get("path").and_then(Value::as_str),
            Some("SKILL.md")
        );
        assert_eq!(
            suffix_prefixed.get("skill").and_then(Value::as_str),
            Some("baoyu-cover-image")
        );
        assert_eq!(
            suffix_prefixed.get("content").and_then(Value::as_str),
            Some("cover skill")
        );
        assert_eq!(
            absolute.get("skill").and_then(Value::as_str),
            Some("baoyu-cover-image")
        );
    }

    #[test]
    fn skill_read_file_prefers_existing_relative_path_before_skill_prefix() {
        let temp = tempdir_for_agent_runtime_test();
        let three_dir = temp.join("three");
        let cover_dir = temp.join("baoyu-cover-image");
        std::fs::create_dir_all(&three_dir).unwrap();
        std::fs::create_dir_all(cover_dir.join("three")).unwrap();
        std::fs::write(three_dir.join("foo.md"), "wrong").unwrap();
        std::fs::write(cover_dir.join("three/foo.md"), "right").unwrap();
        let three = AgentSkill {
            name: "three".to_string(),
            description: "three".to_string(),
            instructions: "Three.".to_string(),
            base_dir: three_dir.to_string_lossy().to_string(),
            location: three_dir.join("SKILL.md").to_string_lossy().to_string(),
        };
        let cover = AgentSkill {
            name: "baoyu-cover-image".to_string(),
            description: "cover".to_string(),
            instructions: "Use refs lazily.".to_string(),
            base_dir: cover_dir.to_string_lossy().to_string(),
            location: cover_dir.join("SKILL.md").to_string_lossy().to_string(),
        };

        let value = read_active_skill_file(
            &[three, cover],
            &serde_json::json!({ "path": "three/foo.md" }),
        )
        .unwrap();

        assert_eq!(
            value.get("skill").and_then(Value::as_str),
            Some("baoyu-cover-image")
        );
        assert_eq!(value.get("content").and_then(Value::as_str), Some("right"));
    }

    #[test]
    fn skill_read_file_rejects_explicit_skill_path_mismatch() {
        let temp = tempdir_for_agent_runtime_test();
        let cover_dir = temp.join("baoyu-cover-image");
        let other_dir = temp.join("other-skill");
        std::fs::create_dir_all(cover_dir.join("references")).unwrap();
        std::fs::create_dir_all(&other_dir).unwrap();
        std::fs::write(cover_dir.join("references/types.md"), "type guide").unwrap();
        let cover = AgentSkill {
            name: "baoyu-cover-image".to_string(),
            description: "cover".to_string(),
            instructions: "Use refs lazily.".to_string(),
            base_dir: cover_dir.to_string_lossy().to_string(),
            location: cover_dir.join("SKILL.md").to_string_lossy().to_string(),
        };
        let other = AgentSkill {
            name: "other-skill".to_string(),
            description: "other".to_string(),
            instructions: "Other.".to_string(),
            base_dir: other_dir.to_string_lossy().to_string(),
            location: other_dir.join("SKILL.md").to_string_lossy().to_string(),
        };

        let err = read_active_skill_file(
            &[cover, other],
            &serde_json::json!({
                "skill": "other-skill",
                "path": "baoyu-cover-image/references/types.md"
            }),
        )
        .unwrap_err();

        assert!(err.contains("does not match requested skill"));
    }

    #[test]
    fn skill_read_file_rejects_path_escape() {
        let temp = tempdir_for_agent_runtime_test();
        let skill_dir = temp.join("skill");
        std::fs::create_dir_all(&skill_dir).unwrap();
        let skill = AgentSkill {
            name: "skill".to_string(),
            description: "skill".to_string(),
            instructions: "Read refs lazily.".to_string(),
            base_dir: skill_dir.to_string_lossy().to_string(),
            location: skill_dir.join("SKILL.md").to_string_lossy().to_string(),
        };

        let err = read_active_skill_file(&[skill], &serde_json::json!({ "path": "../secret.md" }))
            .unwrap_err();

        assert!(err.contains("safe relative path"));
    }

    fn tempdir_for_agent_runtime_test() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("llm-wiki-agent-runtime-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn agent_loop_references_are_deduped_by_kind_and_path() {
        let mut references = Vec::new();
        let mut events = Vec::new();
        let reference = AgentReference {
            title: "Alpha".to_string(),
            path: "wiki/entities/alpha.md".to_string(),
            kind: "wiki".to_string(),
            snippet: None,
            score: None,
            knowledge_context: None,
        };

        assert!(push_unique_reference(
            &mut references,
            &mut events,
            &None,
            reference.clone()
        ));
        assert!(!push_unique_reference(
            &mut references,
            &mut events,
            &None,
            reference
        ));
        assert_eq!(references.len(), 1);
        assert_eq!(events.len(), 1);
    }

    #[test]
    fn workspace_write_file_success_is_added_as_reference() {
        let project = tempdir_for_agent_runtime_test();
        let runtime = AgentRuntime::new(
            "project-1",
            project.to_string_lossy(),
            None,
            None,
            None,
            None,
        );
        let mut references = Vec::new();
        let mut events = Vec::new();

        let summary = runtime
            .record_loop_tool_success(
                "workspace.write_file",
                serde_json::json!({
                    "path": "agent-workspace/deck/index.html",
                    "bytes": 1234,
                }),
                &mut references,
                &mut events,
                &None,
            )
            .unwrap();

        assert_eq!(
            summary,
            "wrote agent-workspace/deck/index.html (1234 bytes)"
        );
        assert_eq!(references.len(), 1);
        assert_eq!(references[0].kind, "workspace");
        assert_eq!(references[0].path, "agent-workspace/deck/index.html");
        assert_eq!(events.len(), 2);
        assert!(matches!(
            &events[0],
            AgentEvent::FileChanged { path, tool, existed_before: false, previous_content: None }
                if path == "agent-workspace/deck/index.html" && tool == "workspace.write_file"
        ));
    }

    #[test]
    fn shell_exec_generated_files_are_added_as_references() {
        let project = tempdir_for_agent_runtime_test();
        let runtime = AgentRuntime::new(
            "project-1",
            project.to_string_lossy(),
            None,
            None,
            None,
            None,
        );
        let mut references = Vec::new();
        let mut events = Vec::new();

        let summary = runtime
            .record_loop_tool_success(
                "shell.exec",
                serde_json::json!({
                    "command": "printf image > images/cover.png",
                    "exitCode": 0,
                    "stdout": "",
                    "stderr": "",
                    "timedOut": false,
                    "generatedFiles": [
                        {
                            "path": "agent-workspace/images/cover.png",
                            "bytes": 5
                        }
                    ]
                }),
                &mut references,
                &mut events,
                &None,
            )
            .unwrap();

        assert!(summary.contains("Generated files:"));
        assert!(summary.contains("agent-workspace/images/cover.png"));
        assert_eq!(references.len(), 1);
        assert_eq!(references[0].kind, "workspace");
        assert_eq!(references[0].path, "agent-workspace/images/cover.png");
        assert_eq!(events.len(), 1);
    }

    #[test]
    fn iteration_limit_answer_reports_generated_workspace_files() {
        let references = vec![
            AgentReference {
                title: "index.html".to_string(),
                path: "agent-workspace/ppt-swiss/index.html".to_string(),
                kind: "workspace".to_string(),
                snippet: None,
                score: None,
                knowledge_context: None,
            },
            AgentReference {
                title: "index.html duplicate".to_string(),
                path: "agent-workspace/ppt-swiss/index.html".to_string(),
                kind: "workspace".to_string(),
                snippet: None,
                score: None,
                knowledge_context: None,
            },
            AgentReference {
                title: "Wiki".to_string(),
                path: "wiki/index.md".to_string(),
                kind: "wiki".to_string(),
                snippet: None,
                score: None,
                knowledge_context: None,
            },
        ];

        let answer = agent_iteration_limit_answer(16, 17, &references);

        assert!(answer.contains("did generate file"));
        assert!(answer.contains("agent-workspace/ppt-swiss/index.html"));
        assert_eq!(
            answer
                .matches("agent-workspace/ppt-swiss/index.html")
                .count(),
            1
        );
        assert!(!answer.contains("Please narrow"));
        assert!(!answer.contains("wiki/index.md"));
    }

    #[test]
    fn iteration_limit_answer_preserves_plain_limit_without_workspace_files() {
        let references = vec![AgentReference {
            title: "Wiki".to_string(),
            path: "wiki/index.md".to_string(),
            kind: "wiki".to_string(),
            snippet: None,
            score: None,
            knowledge_context: None,
        }];

        let answer = agent_iteration_limit_answer(8, 9, &references);

        assert!(answer.contains("tool-iteration limit"));
        assert!(answer.contains("9 tool observation"));
        assert!(answer.contains("Please narrow"));
    }

    #[test]
    fn fallback_wiki_search_is_only_for_plain_non_skill_turns() {
        let tools = AgentToolOptions {
            wiki: true,
            web: false,
            anytxt: false,
        };
        assert!(should_fallback_wiki_search(true, &tools, true));
        assert!(!should_fallback_wiki_search(false, &tools, true));
        assert!(!should_fallback_wiki_search(true, &tools, false));
        assert!(!should_fallback_wiki_search(
            true,
            &AgentToolOptions {
                wiki: false,
                web: false,
                anytxt: false,
            },
            true,
        ));
    }

    #[test]
    fn shell_commands_require_exact_approval() {
        assert!(!is_shell_command_approved("echo unsafe", &[]));
        assert!(!is_shell_command_approved(
            "echo unsafe",
            &["echo other".to_string()]
        ));
        assert!(is_shell_command_approved(
            "echo safe",
            &["  echo safe  ".to_string()]
        ));
    }

    #[test]
    fn workspace_local_shell_commands_do_not_require_manual_approval() {
        let project = "/Users/test/Project";

        assert!(is_shell_command_allowed_without_prompt(
            "cat ppt/index.html | head -100",
            &[],
            project,
        ));
        assert!(is_shell_command_allowed_without_prompt(
            "grep -n data-layout /Users/test/Project/agent-workspace/ppt/index.html | head -30",
            &[],
            project,
        ));
        assert!(is_shell_command_allowed_without_prompt(
            "mkdir -p deck && node scripts/validate.js deck/index.html",
            &[],
            project,
        ));
        assert!(is_shell_command_allowed_without_prompt(
            "echo safe",
            &["echo safe".to_string()],
            project,
        ));
    }

    #[test]
    fn external_shell_commands_still_require_manual_approval() {
        let project = "/Users/test/Project";

        assert!(!is_shell_command_allowed_without_prompt(
            "cat /Users/test/.agents/skills/skill/SKILL.md",
            &[],
            project,
        ));
        assert!(!is_shell_command_allowed_without_prompt(
            "cp ~/Desktop/file.png images/file.png",
            &[],
            project,
        ));
        assert!(!is_shell_command_allowed_without_prompt(
            "cat ../raw/secrets.txt",
            &[],
            project,
        ));
        assert!(!is_shell_command_allowed_without_prompt(
            "curl https://example.com/file",
            &[],
            project,
        ));
        assert!(!is_shell_command_allowed_without_prompt(
            "OUT=/tmp/file.html echo x",
            &[],
            project,
        ));
    }

    #[test]
    fn validates_agent_image_limits() {
        let valid = super::super::types::AgentImage {
            media_type: "image/png".to_string(),
            data_base64: "abcd".to_string(),
        };
        assert!(validate_images(std::slice::from_ref(&valid)).is_ok());

        let invalid = super::super::types::AgentImage {
            media_type: "image/bmp".to_string(),
            data_base64: "abcd".to_string(),
        };
        assert!(validate_images(&[invalid]).is_err());

        let too_many = vec![valid; MAX_IMAGES_PER_TURN + 1];
        assert!(validate_images(&too_many).is_err());
    }
}

import { useRef, useEffect, useCallback, useState, type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { BookOpen, Bot, MessageSquare, Plus, Trash2, Upload } from "lucide-react"
import { Button } from "@/components/ui/button"
import { ChatMessage, StreamingMessage, useSourceFiles } from "./chat-message"
import { ChatInput, type ChatSendOptions } from "./chat-input"
import { AgentPermissionDialogHost } from "./agent-permission-dialog"
import { useChatStore, chatMessagesToLLM, type MessageReference } from "@/stores/chat-store"
import { useWikiStore } from "@/stores/wiki-store"
import { streamChat, type ChatMessage as LLMMessage } from "@/lib/llm-client"
import { streamAgent } from "@/lib/agent/agent-transport"
import type { AgentTransportOptions } from "@/lib/agent/agent-types"
import { executeIngestWrites } from "@/lib/ingest"
import { listDirectory, readFile, deleteFile } from "@/commands/fs"
import { searchWiki } from "@/lib/search"
import { buildRetrievalGraph, getRelatedNodes } from "@/lib/graph-relevance"
import { normalizePath, getFileName, getRelativePath } from "@/lib/path-utils"
import { getOutputLanguage, buildLanguageReminder } from "@/lib/output-language"
import { isGreeting } from "@/lib/greeting-detector"
import { computeContextBudget } from "@/lib/context-budget"
import { anyTxtSearchSmart, hasConfiguredAnyTxt } from "@/lib/anytxt-search"
import { resolveSearchConfig, webSearch, type WebSearchResult } from "@/lib/web-search"
import { API_SERVER_PORT } from "@/lib/api-server-constants"
import { markConversationDirty, flushQaForConversation, flushAllPendingQa, unmarkConversation, loadPendingQa } from "@/lib/agent/agent-qa-hook"
import {
	agentResultToStats,
	agentToolBatchToRecords,
	agentToolEventToRecord,
	isSdkAssistantMessage,
} from "./agent-stream-integration"
 // Store the page mapping from the last query so SourceFilesBar can show which pages were cited
export let lastQueryPages: { title: string; path: string }[] = []
 function formatExternalSearchContext(results: WebSearchResult[]): string {
	if (results.length === 0) return ""
	return results
		.map((result, index) => [
			`### [E${index + 1}] ${result.title}`,
			`Source: ${result.source}`,
			`URL: ${result.url}`,
			"",
			result.snippet,
		].join("\n"))
		.join("\n\n---\n\n")
}
function formatDate(timestamp: number): string {
	const d = new Date(timestamp)
	const now = new Date()
	const isToday = d.toDateString() === now.toDateString()
	if (isToday) {
		return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
	}
	return d.toLocaleDateString([], { month: "short", day: "numeric" })
}

function agentBaseUrl(config: ReturnType<typeof useWikiStore.getState>["llmConfig"]): string | undefined {
	if (config.provider === "custom") return config.customEndpoint || undefined
	if (config.provider === "ollama") return config.ollamaUrl || undefined
	return undefined
}

function agentApiServerBaseUrl(): string {
	return `http://127.0.0.1:${API_SERVER_PORT}`
}

function buildAgentTransportOptions(): AgentTransportOptions | null {
	const wikiState = useWikiStore.getState()
	const chatState = useChatStore.getState()
	const project = wikiState.project
	if (!project) return null
	const activeConversation = chatState.conversations.find(
		(conversation) => conversation.id === chatState.activeConversationId,
	)
	const agentSessionId = activeConversation?.agentSessionId

	return {
		cwd: project.path,
		projectId: project.id,
		projectPath: project.path,
		model: wikiState.llmConfig.model || undefined,
		apiKey: wikiState.llmConfig.apiKey || undefined,
		baseUrl: agentBaseUrl(wikiState.llmConfig),
		resume: agentSessionId,
		persistSession: true,
		permissionPolicy: "default",
		enableWikiTools: true,
		enableWriteTools: true,
		apiServerBaseUrl: agentApiServerBaseUrl(),
		apiToken: wikiState.apiConfig.token || undefined,
	}
}

function ModeButton({
	active,
	children,
	disabled = false,
	onClick,
}: {
	active: boolean
	children: ReactNode
	disabled?: boolean
	onClick: () => void
}) {
	return (
		<button
			type="button"
			aria-pressed={active}
			disabled={disabled}
			onClick={onClick}
			className={`inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium transition-colors ${
				active
					? "bg-background text-foreground shadow-sm"
					: "text-muted-foreground hover:bg-background/70 hover:text-foreground"
			} disabled:pointer-events-none disabled:opacity-50`}
		>
			{children}
		</button>
	)
}
 function ConversationSidebar() {
	const { t } = useTranslation()
	const conversations = useChatStore((s) => s.conversations)
	const activeConversationId = useChatStore((s) => s.activeConversationId)
	const messages = useChatStore((s) => s.messages)
	const createConversation = useChatStore((s) => s.createConversation)
	const deleteConversation = useChatStore((s) => s.deleteConversation)
	const setActiveConversation = useChatStore((s) => s.setActiveConversation)
 	const [hoveredId, setHoveredId] = useState<string | null>(null)
 	const sorted = [...conversations].sort((a, b) => b.updatedAt - a.updatedAt)
 	function getMessageCount(convId: string): number {
		return messages.filter((m) => m.conversationId === convId).length
	}
 	return (
		<div className="flex h-full w-[200px] flex-shrink-0 flex-col border-r bg-muted/30">
			<div className="border-b p-2">
				<Button
					variant="outline"
					size="sm"
					className="w-full gap-2"
					onClick={() => createConversation()}
				>
					<Plus className="h-3.5 w-3.5" />
					{t("chat.newChat")}
				</Button>
			</div>
 			<div className="flex-1 overflow-y-auto py-1">
				{sorted.length === 0 ? (
					<p className="px-3 py-4 text-xs text-muted-foreground text-center">
						{t("chat.noConversationsYet")}
					</p>
				) : (
					sorted.map((conv) => {
						const isActive = conv.id === activeConversationId
						const msgCount = getMessageCount(conv.id)
						return (
							<div
								key={conv.id}
								className={`group relative mx-1 my-0.5 flex cursor-pointer flex-col rounded-md px-2 py-1.5 text-sm transition-colors ${
									isActive
										? "bg-primary/10 text-primary"
										: "hover:bg-accent text-foreground"
								}`}
								onClick={() => {
									const prevId = useChatStore.getState().activeConversationId;
									if (prevId && prevId !== conv.id) {
										const msgs = useChatStore.getState().messages;
										const s = useWikiStore.getState();
										if (s.project) flushQaForConversation(prevId, msgs, s.project.path, s.llmConfig, s.searchApiConfig).catch(() => {});
									}
									setActiveConversation(conv.id);
								}}
								onMouseEnter={() => setHoveredId(conv.id)}
								onMouseLeave={() => setHoveredId(null)}
							>
								<div className="flex items-start justify-between gap-1">
									<span className="line-clamp-2 flex-1 text-xs font-medium leading-snug">
										{conv.title}
									</span>
									{hoveredId === conv.id && (
										<button
											className="flex-shrink-0 rounded p-0.5 text-muted-foreground hover:text-destructive"
											onClick={(e) => {
												e.stopPropagation()
												unmarkConversation(conv.id)
											deleteConversation(conv.id)
												// Delete persisted chat file
												const proj = useWikiStore.getState().project
												if (proj) {
													deleteFile(`${proj.path}/.llm-wiki/chats/${conv.id}.json`).catch(() => {})
												}
											}}
										>
											<Trash2 className="h-3 w-3" />
										</button>
									)}
								</div>
								<div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-muted-foreground">
									<span>{formatDate(conv.updatedAt)}</span>
									{msgCount > 0 && (
										<>
											<span>·</span>
											<span>{msgCount} {t("chat.msgCount")}</span>
										</>
									)}
								</div>
							</div>
						)
					})
				)}
			</div>
		</div>
	)
}
 export function ChatPanel() {
	const { t } = useTranslation()
	useSourceFiles() // Keep source file cache warm
	const activeConversationId = useChatStore((s) => s.activeConversationId)
	const isStreaming = useChatStore((s) => s.isStreaming)
	const streamingContent = useChatStore((s) => s.streamingContent)
	const mode = useChatStore((s) => s.mode)
	const addMessage = useChatStore((s) => s.addMessage)
	const setStreaming = useChatStore((s) => s.setStreaming)
	const setMode = useChatStore((s) => s.setMode)
	const appendStreamToken = useChatStore((s) => s.appendStreamToken)
	const finalizeStream = useChatStore((s) => s.finalizeStream)
	const createConversation = useChatStore((s) => s.createConversation)
	const removeLastAssistantMessage = useChatStore((s) => s.removeLastAssistantMessage)
	const maxHistoryMessages = useChatStore((s) => s.maxHistoryMessages)
	const startAgentStreamMessage = useChatStore((s) => s.startAgentStreamMessage)
	const updateAgentStreamMessage = useChatStore((s) => s.updateAgentStreamMessage)
	const finishAgentStreamMessage = useChatStore((s) => s.finishAgentStreamMessage)
	const setAgentToolCalls = useChatStore((s) => s.setAgentToolCalls)
	const updateAgentProgress = useChatStore((s) => s.updateAgentProgress)
	const requestAgentPermission = useChatStore((s) => s.requestAgentPermission)
	const clearAgentPermissionRequests = useChatStore((s) => s.clearAgentPermissionRequests)
 	// Derive active messages via selector to re-render on message changes
	const allMessages = useChatStore((s) => s.messages)
	const activeMessages = activeConversationId
		? allMessages.filter((m) => m.conversationId === activeConversationId)
		: []
 	const project = useWikiStore((s) => s.project)
	const llmConfig = useWikiStore((s) => s.llmConfig)
	const searchApiConfig = useWikiStore((s) => s.searchApiConfig)
	const anyTxtAvailable = hasConfiguredAnyTxt(searchApiConfig.anyTxt)
	const setFileTree = useWikiStore((s) => s.setFileTree)
	const bumpDataVersion = useWikiStore((s) => s.bumpDataVersion)
 	const abortRef = useRef<AbortController | null>(null)
	const scrollContainerRef = useRef<HTMLDivElement>(null)
	const bottomRef = useRef<HTMLDivElement>(null)
 	// Auto-scroll to bottom when messages change or streaming content updates
	useEffect(() => {
		const container = scrollContainerRef.current
		if (container) {
			container.scrollTop = container.scrollHeight
		}
	}, [activeMessages, streamingContent])

	// Startup: flush any QA pending from last session
	useEffect(() => {
		const pendingIds = loadPendingQa();
		if (pendingIds.length > 0) {
			const msgs = useChatStore.getState().messages;
			const s = useWikiStore.getState();
			if (s.project && msgs.length > 0) {
				flushAllPendingQa(msgs, s.project.path, s.llmConfig, s.searchApiConfig)
					.catch((err: unknown) => console.warn("[QA Hook] startup flush failed:", err));
			}
		}
	}, []);

	const handleAgentSend = useCallback(
		async (text: string) => {
			let convId = useChatStore.getState().activeConversationId
			if (!convId) {
				convId = createConversation()
			}

			const activeConversation = useChatStore.getState().conversations.find(
				(conversation) => conversation.id === convId,
			)
			const agentSessionId = activeConversation?.agentSessionId
			addMessage("user", text, {
				mode: "agent",
				agentSessionId,
			})

			const messageId = startAgentStreamMessage({ agentSessionId })
			if (!messageId) return

			const options = buildAgentTransportOptions()
			if (!options) {
				finishAgentStreamMessage(messageId, t("agent.error.unavailable"))
				return
			}

			const controller = new AbortController()
			abortRef.current = controller
			let accumulated = ""
			let settled = false
			const finishAgentMessage = (content: string, stats = agentResultToStats(null)) => {
				if (settled) return
				settled = true
				finishAgentStreamMessage(messageId, content, stats)
				abortRef.current = null
			}

			try {
				await streamAgent(
					text,
					options,
					{
						onToken: (token) => {
							accumulated += token
							updateAgentStreamMessage(messageId, { content: accumulated })
						},
						onMessage: (message) => {
							if (!isSdkAssistantMessage(message)) return
							updateAgentStreamMessage(messageId, {
								agentBlocks: message.message.content,
							})
						},
						onDone: (result) => {
							const stats = agentResultToStats(result)
							const finalContent = accumulated || result?.result || ""
							finishAgentMessage(finalContent, stats)
						},
						onError: (err) => {
							finishAgentMessage(t("agent.error.failed", { error: err.message }))
						},
						onToolEvent: (event) => {
							if (event.phase === "batch") {
								const records = agentToolBatchToRecords(event)
								if (records.length > 0) setAgentToolCalls(messageId, records)
								return
							}
							updateAgentProgress(messageId, agentToolEventToRecord(event))
						},
						onPermissionRequest: (payload) => requestAgentPermission(payload),
						onWikiChanged: (payload) => {
							const key =
								payload.operation === "create"
									? "agent.wikiChanged.created"
									: payload.operation === "delete"
										? "agent.wikiChanged.deleted"
										: "agent.wikiChanged.updated"
							console.info(t(key, { path: payload.path }))
							listDirectory(options.projectPath ?? options.cwd ?? project?.path ?? "")
								.then((tree) => {
									setFileTree(tree)
									bumpDataVersion()
								})
								.catch((err) => {
									console.warn("[agent] failed to refresh file tree:", err)
								})
						},
						onAgentSummary: (payload) => {
							console.debug("[agent] summary:", payload)
						},
						onActionRequired: (payload) => {
							console.debug("[agent] action required:", payload)
						},
					},
					controller.signal,
				)
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err)
				finishAgentMessage(t("agent.error.failed", { error: message }))
			}
		},
		[
			addMessage,
			bumpDataVersion,
			createConversation,
			finishAgentStreamMessage,
			project?.path,
			requestAgentPermission,
			setAgentToolCalls,
			setFileTree,
			startAgentStreamMessage,
			t,
			updateAgentProgress,
			updateAgentStreamMessage,
		],
	)

 	const handleSend = useCallback(
		async (text: string, options: ChatSendOptions = { useWebSearch: false, useAnyTxtSearch: false }) => {
			if (mode === "agent") {
				await handleAgentSend(text)
				return
			}

			// Auto-create a conversation if none is active
			let convId = useChatStore.getState().activeConversationId
			if (!convId) {
				convId = createConversation()
			}
 			addMessage("user", text)
			setStreaming(true)
 			// Build system prompt with wiki context using graph-enhanced retrieval
			const systemMessages: LLMMessage[] = []
			let queryRefs: MessageReference[] = []
			let langReminder: string | undefined
			// Pure greetings ("hi", "你好", "嗨") don't warrant running the whole
			// retrieval pipeline — it's slow, costs context, and drags in random
			// wiki pages the user clearly didn't ask about. Short-circuit with a
			// minimal system prompt and let the model reply conversationally.
			const greetingOnly = isGreeting(text)
			if (project && greetingOnly) {
				const outLang = getOutputLanguage(text)
				systemMessages.push({
					role: "system",
					content: [
						`You are a wiki assistant for the project "${project.name}".`,
						"The user sent a casual greeting — reply briefly and naturally, in one or two sentences.",
						"Do NOT invent wiki content or pretend to have retrieved pages. Invite the user to ask a concrete question if they want information from the wiki.",
						"",
						`Respond in ${outLang}.`,
					].join("\n"),
				})
				// Skip retrieval; queryRefs stays empty so no "Sources" chip is shown.
			} else if (project) {
				const pp = normalizePath(project.path)
				const dataVersion = useWikiStore.getState().dataVersion
 				// ── Budget allocation (see context-budget.ts) ─────────
				// Page budget scales with the LLM's context window; we now
				// also reserve ~15% as headroom for the response so the
				// model isn't truncated mid-sentence on a packed prompt.
				const {
					indexBudget: INDEX_BUDGET,
					pageBudget: PAGE_BUDGET,
					maxPageSize: MAX_PAGE_SIZE,
				} = computeContextBudget(llmConfig.maxContextSize)
 				const [rawIndex, purpose] = await Promise.all([
					readFile(`${pp}/wiki/index.md`).catch(() => ""),
					readFile(`${pp}/purpose.md`).catch(() => ""),
				])
 				// ── Phase 1: Tokenized search → top 10 ────────────────
				const searchResults = await searchWiki(pp, text)
				const topSearchResults = searchResults.slice(0, 10)
 				const resolvedExternalSearchConfig = resolveSearchConfig(searchApiConfig)
				const externalSearchResults: WebSearchResult[] = []
				const externalSearchErrors: string[] = []
				const externalCalls: Promise<WebSearchResult[]>[] = []
 				if (options.useWebSearch) {
					externalCalls.push(
						webSearch(text, resolvedExternalSearchConfig, 5).catch((err) => {
							externalSearchErrors.push(
								`Web Search: ${err instanceof Error ? err.message : String(err)}`,
							)
							return []
						}),
					)
				}
 				if (options.useAnyTxtSearch) {
					externalCalls.push(
						anyTxtSearchSmart(text, resolvedExternalSearchConfig.anyTxt, llmConfig, 5, pp).catch((err) => {
							externalSearchErrors.push(
								`AnyTXT: ${err instanceof Error ? err.message : String(err)}`,
							)
							return []
						}),
					)
				}
 				if (externalCalls.length > 0) {
					const batches = await Promise.all(externalCalls)
					const seenExternal = new Set<string>()
					for (const result of batches.flat()) {
						const key = result.url || `${result.source}:${result.title}:${result.snippet}`
						if (seenExternal.has(key)) continue
						seenExternal.add(key)
						externalSearchResults.push(result)
						if (externalSearchResults.length >= 10) break
					}
				}
 				// ── Trim index by relevance if over budget ─────────────
				let index = rawIndex
				if (rawIndex.length > INDEX_BUDGET) {
					const { tokenizeQuery } = await import("@/lib/search")
					const tokens = tokenizeQuery(text)
					const lines = rawIndex.split("\n")
					const keptLines: string[] = []
					let keptSize = 0
 					for (const line of lines) {
						const isHeader = line.startsWith("##")
						const lower = line.toLowerCase()
						const isRelevant = tokens.some((t) => lower.includes(t))
 						if (isHeader || isRelevant) {
							if (keptSize + line.length + 1 <= INDEX_BUDGET) {
								keptLines.push(line)
								keptSize += line.length + 1
							}
						}
					}
					index = keptLines.join("\n")
					if (index.length < rawIndex.length) {
						index += "\n\n[...index trimmed to relevant entries...]"
					}
				}
 				// ── Phase 2: Graph 1-level expansion ───────────────────
				// Note: Vector search (if enabled) is already merged into searchResults
				// by searchWiki() in search.ts — no duplicate code needed here.
				const graph = await buildRetrievalGraph(pp, dataVersion)
				const expandedIds = new Set<string>()
				const searchHitPaths = new Set(topSearchResults.map((r) => r.path))
				const graphExpansions: { title: string; path: string; relevance: number }[] = []
 				for (const result of topSearchResults) {
					const fileName = getFileName(result.path)
					const nodeId = fileName.replace(/\.md$/, "")
					const related = getRelatedNodes(nodeId, graph, 3)
					for (const { node, relevance } of related) {
						if (relevance < 2.0) continue
						if (searchHitPaths.has(node.path)) continue
						if (expandedIds.has(node.id)) continue
						expandedIds.add(node.id)
						graphExpansions.push({ title: node.title, path: node.path, relevance })
					}
				}
				graphExpansions.sort((a, b) => b.relevance - a.relevance)
 				// ── Phase 3 & 4: Page budget control ───────────────────
				let usedChars = 0
				type PageEntry = { title: string; path: string; content: string; priority: number }
				const relevantPages: PageEntry[] = []
 				const tryAddPage = async (title: string, filePath: string, priority: number): Promise<boolean> => {
					if (usedChars >= PAGE_BUDGET) return false
					try {
						const raw = await readFile(filePath)
						const relativePath = getRelativePath(filePath, pp)
						const truncated = raw.length > MAX_PAGE_SIZE
							? raw.slice(0, MAX_PAGE_SIZE) + "\n\n[...truncated...]"
							: raw
						if (usedChars + truncated.length > PAGE_BUDGET) return false
						usedChars += truncated.length
						relevantPages.push({ title, path: relativePath, content: truncated, priority })
						return true
					} catch { return false }
				}
 				// P0: Title matches
				for (const r of topSearchResults.filter((r) => r.titleMatch)) {
					await tryAddPage(r.title, r.path, 0)
				}
				// P1: Content matches
				for (const r of topSearchResults.filter((r) => !r.titleMatch)) {
					await tryAddPage(r.title, r.path, 1)
				}
				// P2: Graph expansions
				for (const exp of graphExpansions) {
					await tryAddPage(exp.title, exp.path, 2)
				}
				// P3: Overview fallback
				if (relevantPages.length === 0) {
					await tryAddPage("Overview", `${pp}/wiki/overview.md`, 3)
				}
 				const pagesContext = relevantPages.length > 0
					? relevantPages.map((p, i) =>
							`### [${i + 1}] ${p.title}\nPath: ${p.path}\n\n${p.content}`
						).join("\n\n---\n\n")
					: "(No wiki pages found)"
 				const pageList = relevantPages.map((p, i) =>
					`[${i + 1}] ${p.title} (${p.path})`
				).join("\n")
				const externalContext = formatExternalSearchContext(externalSearchResults)
 				const outLang = getOutputLanguage(text)
 				systemMessages.push({
					role: "system",
					content: [
						"You are a knowledgeable wiki assistant. Answer questions based on the wiki content provided below.",
						"",
						"## Rules",
						externalContext
							? "- Answer based ONLY on the numbered wiki pages and external sources provided below."
							: "- Answer based ONLY on the numbered wiki pages provided below.",
						"- If the provided pages don't contain enough information, say so honestly.",
						"- Use [[wikilink]] syntax to reference wiki pages.",
						externalContext
							? "- When citing wiki information, use page numbers like [1], [2]. When citing external information, use external source IDs like [E1], [E2]."
							: "- When citing information, use the page number in brackets, e.g. [1], [2].",
						"- At the VERY END of your response, add a hidden comment listing which page numbers you used:",
						"  <!-- cited: 1, 3, 5 -->",
						"",
						"Use markdown formatting for clarity.",
						"",
						purpose ? `## Wiki Purpose\n${purpose}` : "",
						index ? `## Wiki Index\n${index}` : "",
						relevantPages.length > 0 ? `## Page List\n${pageList}` : "",
						`## Wiki Pages\n\n${pagesContext}`,
						externalContext ? `## External Sources\n\n${externalContext}` : "",
						externalSearchErrors.length > 0
							? `## External Source Errors\n${externalSearchErrors.map((err) => `- ${err}`).join("\n")}`
							: "",
						"",
						"---",
						"",
						`## ⚠️ MANDATORY OUTPUT LANGUAGE: ${outLang}`,
						"",
						`You MUST write your entire response in **${outLang}**.`,
						`The wiki content above may be in a different language, but this is IRRELEVANT to your output language.`,
						`Ignore the language of the wiki content. Write in ${outLang} only.`,
						`Even proper nouns should use standard ${outLang} transliteration when appropriate.`,
						`DO NOT use any other language. This overrides all other instructions.`,
					].filter(Boolean).join("\n"),
				})
 				// Reminder injected later, right before the user's current message
				// (after history so it's the last system instruction the LLM sees).
				langReminder = buildLanguageReminder(text)
 				lastQueryPages = relevantPages.map((p) => ({ title: p.title, path: p.path }))
				const externalRefs: MessageReference[] = externalSearchResults.map((result) => ({
					title: result.title,
					path: result.url,
					kind: "external",
					source: result.source,
					url: result.url,
					snippet: result.snippet,
				}))
				queryRefs = [...lastQueryPages.map((page) => ({ ...page, kind: "wiki" as const })), ...externalRefs]
			}
 			// ── Conversation history with count limit ────────────────
			// Only include messages from the active conversation, last N messages
			const activeConvMessages = useChatStore.getState().getActiveMessages()
				.filter((m) => m.role === "user" || m.role === "assistant")
				.slice(-maxHistoryMessages)
 			// Prepend the language reminder onto the final user turn rather than
			// inserting a second {role:"system"} between history and the final
			// user message. vLLM / llama.cpp / Ollama drive their chat templates
			// from HF Jinja, and Qwen3-family templates enforce "system only at
			// index 0" — a mid-conversation system message gets rejected with
			// "System message must be at the beginning." (HTTP 400). OpenAI and
			// Anthropic are more lenient, but keeping a single system at the top
			// is the safest shape across every OpenAI-compatible backend.
			const historyMessages = chatMessagesToLLM(activeConvMessages)
			let llmMessages: LLMMessage[] = [...systemMessages, ...historyMessages]
			if (langReminder && historyMessages.length > 0) {
				const lastIdx = llmMessages.length - 1
				const last = llmMessages[lastIdx]
				if (last && last.role === "user") {
					llmMessages = [
						...llmMessages.slice(0, lastIdx),
						{ role: "user", content: `[${langReminder}]\n\n${last.content}` },
					]
				}
			}
 			const controller = new AbortController()
			abortRef.current = controller
 			let accumulated = ""
			let thinkingOpen = false
 			const appendReasoning = (token: string) => {
				if (!token) return
				if (!thinkingOpen) {
					thinkingOpen = true
					accumulated += "<think>"
					appendStreamToken("<think>")
				}
				accumulated += token
				appendStreamToken(token)
			}
 			const closeReasoning = () => {
				if (!thinkingOpen) return
				thinkingOpen = false
				accumulated += "</think>"
				appendStreamToken("</think>")
			}
 			await streamChat(
				llmConfig,
				llmMessages,
				{
					onToken: (token) => {
						closeReasoning()
						accumulated += token
						appendStreamToken(token)
					},
					onReasoningToken: appendReasoning,
					onDone: () => {
						closeReasoning()
						finalizeStream(accumulated, queryRefs)
						// QA Hook: mark conversation dirty (defer extraction to conversation switch)
						const qaConvId = useChatStore.getState().activeConversationId;
						if (qaConvId) markConversationDirty(qaConvId);
						abortRef.current = null
						// save-worthy detection removed — user has direct "Save to Wiki" button on each message
					},
					onError: (err) => {
						finalizeStream(`Error: ${err.message}`, undefined)
						abortRef.current = null
					},
				},
				controller.signal,
			)
		},
		[mode, handleAgentSend, llmConfig, searchApiConfig, project, addMessage, setStreaming, appendStreamToken, finalizeStream, createConversation, maxHistoryMessages],
	)
 	const handleStop = useCallback(() => {
		abortRef.current?.abort()
		abortRef.current = null
		clearAgentPermissionRequests({
			behavior: "deny",
			interrupt: true,
			message: t("agent.permission.stopped"),
			decisionClassification: "user_reject",
		})
	}, [clearAgentPermissionRequests, t])
 	const handleRegenerate = useCallback(async () => {
		if (isStreaming) return
		// Find the last user message in active conversation
		const active = useChatStore.getState().getActiveMessages()
		const lastUserMsg = [...active].reverse().find((m) => m.role === "user")
		if (!lastUserMsg) return
		// Remove the last assistant reply, then re-send
		removeLastAssistantMessage()
		// Small delay to let state update
		await new Promise((r) => setTimeout(r, 50))
		// Trigger send with the same text (handleSend will add a new user message,
		// so also remove the original to avoid duplication)
		// Actually: just call handleSend — but it adds a user message. To avoid dupe,
		// we remove the last user message too and let handleSend re-add it.
		const store = useChatStore.getState()
		const updatedActive = store.getActiveMessages()
		const lastUser = [...updatedActive].reverse().find((m) => m.role === "user")
		if (lastUser) {
			useChatStore.setState((s) => ({
				messages: s.messages.filter((m) => m.id !== lastUser.id),
			}))
		}
		handleSend(lastUserMsg.content)
	}, [isStreaming, removeLastAssistantMessage, handleSend])
 	const handleWriteToWiki = useCallback(async () => {
		if (!project) return
		const pp = normalizePath(project.path)
		try {
			await executeIngestWrites(pp, llmConfig, undefined, undefined)
			try {
				const tree = await listDirectory(pp)
				setFileTree(tree)
			} catch {
				// ignore
			}
		} catch (err) {
			console.error("Failed to write to wiki:", err)
		}
	}, [project, llmConfig, setFileTree])
 	const hasAssistantMessages = activeMessages.some((m) => m.role === "assistant")
	const showWriteButton = mode === "ingest" && !isStreaming && hasAssistantMessages
 	return (
		<div className="flex h-full flex-row overflow-hidden">
			<AgentPermissionDialogHost />
			<ConversationSidebar />
 			<div className="flex flex-1 flex-col overflow-hidden">
				{!activeConversationId ? (
					<div className="flex flex-1 items-center justify-center text-muted-foreground">
						<div className="text-center">
							<MessageSquare className="mx-auto mb-3 h-8 w-8 opacity-30" />
							<p className="text-sm">{t("chat.startNewConversation")}</p>
							<p className="mt-1 text-xs opacity-60">{t("chat.clickNewChatToBegin")}</p>
						</div>
					</div>
				) : (
					<>
						<div
							ref={scrollContainerRef}
							className="flex-1 overflow-y-auto px-3 py-2"
						>
							<div className="flex flex-col gap-3">
								{activeMessages.map((msg, idx) => {
									// Check if this is the last assistant message
									const isLastAssistant = msg.role === "assistant" &&
										!activeMessages.slice(idx + 1).some((m) => m.role === "assistant")
									return (
										<ChatMessage
											key={msg.id}
											message={msg}
											isLastAssistant={isLastAssistant && !isStreaming}
											onRegenerate={isLastAssistant ? handleRegenerate : undefined}
										/>
									)
								})}
								{isStreaming && mode !== "agent" && <StreamingMessage content={streamingContent} />}
								<div ref={bottomRef} />
							</div>
						</div>
 						{showWriteButton && (
							<div className="border-t px-3 py-2">
								<Button
									variant="outline"
									size="sm"
									onClick={handleWriteToWiki}
									className="w-full gap-2"
								>
									<BookOpen className="h-4 w-4" />
									{t("chat.writeToWiki")}
								</Button>
							</div>
						)}
					</>
				)}
				<div className="border-t bg-muted/20 px-3 py-2">
					<div className="flex flex-wrap items-center justify-between gap-2">
						<div className="inline-flex rounded-lg bg-muted p-0.5">
							<ModeButton
								active={mode === "chat"}
								disabled={isStreaming}
								onClick={() => setMode("chat")}
							>
								<MessageSquare className="h-3.5 w-3.5" />
								{t("agent.mode.chat")}
							</ModeButton>
							<ModeButton
								active={mode === "agent"}
								disabled={isStreaming}
								onClick={() => setMode("agent")}
							>
								<Bot className="h-3.5 w-3.5" />
								{t("agent.mode.agent")}
							</ModeButton>
							<ModeButton
								active={mode === "ingest"}
								disabled={isStreaming}
								onClick={() => setMode("ingest")}
							>
								<Upload className="h-3.5 w-3.5" />
								{t("agent.mode.ingest")}
							</ModeButton>
						</div>
						{mode === "agent" && (
							<div className="flex min-w-0 flex-wrap items-center gap-2 text-xs text-muted-foreground">
								{project ? (
									<>
										<span className="truncate">
											{t("agent.config.model")}: {llmConfig.model || "-"}
										</span>
										<span className="hidden sm:inline">·</span>
										<span>
											{t("agent.config.permissionPolicy")}: {t("agent.config.defaultPolicy")}
										</span>
									</>
								) : (
									<span>{t("agent.config.noProject")}</span>
								)}
							</div>
						)}
					</div>
				</div>
 				<ChatInput
					onSend={handleSend}
					onStop={handleStop}
					isStreaming={isStreaming}
					anyTxtAvailable={anyTxtAvailable}
					showSearchToggles={mode === "chat"}
					placeholder={
						mode === "agent"
							? t("agent.placeholder")
							: mode === "ingest"
							? t("chat.ingestPlaceholder")
							: t("chat.typeAMessage")
					}
				/>
			</div>
		</div>
	)
}

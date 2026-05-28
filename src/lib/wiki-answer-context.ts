import { readFile } from "@/commands/fs";
import { computeContextBudget } from "@/lib/context-budget";
import { buildRetrievalGraph, getRelatedNodes } from "@/lib/graph-relevance";
import { isGreeting } from "@/lib/greeting-detector";
import type { ChatMessage as LLMMessage } from "@/lib/llm-client";
import {
	buildLanguageReminder,
	getOutputLanguage,
} from "@/lib/output-language";
import { getFileName, getRelativePath, normalizePath } from "@/lib/path-utils";
import { searchWiki, tokenizeQuery } from "@/lib/search";

export interface WikiAnswerProject {
	name: string;
	path: string;
}

export interface WikiAnswerPageRef {
	title: string;
	path: string;
}

export interface BuildWikiAnswerContextArgs {
	project: WikiAnswerProject;
	query: string;
	maxContextSize?: number;
	dataVersion: number;
}

export interface BuildWikiAnswerContextResult {
	systemMessages: LLMMessage[];
	queryRefs: WikiAnswerPageRef[];
	languageReminder?: string;
}

/**
 * Builds the same deterministic Wiki RAG context used by normal chat.
 * Agent tools can call this later so Agent answers do not drift from Chat behavior.
 */
export async function buildWikiAnswerContext({
	project,
	query,
	maxContextSize,
	dataVersion,
}: BuildWikiAnswerContextArgs): Promise<BuildWikiAnswerContextResult> {
	const systemMessages: LLMMessage[] = [];
	let queryRefs: WikiAnswerPageRef[] = [];
	let languageReminder: string | undefined;

	if (isGreeting(query)) {
		const outLang = getOutputLanguage(query);
		systemMessages.push({
			role: "system",
			content: [
				`You are a wiki assistant for the project "${project.name}".`,
				"The user sent a casual greeting — reply briefly and naturally, in one or two sentences.",
				"Do NOT invent wiki content or pretend to have retrieved pages. Invite the user to ask a concrete question if they want information from the wiki.",
				"",
				`Respond in ${outLang}.`,
			].join("\n"),
		});
		return { systemMessages, queryRefs };
	}

	const pp = normalizePath(project.path);
	const {
		indexBudget: INDEX_BUDGET,
		pageBudget: PAGE_BUDGET,
		maxPageSize: MAX_PAGE_SIZE,
	} = computeContextBudget(maxContextSize);

	const [rawIndex, purpose] = await Promise.all([
		readFile(`${pp}/wiki/index.md`).catch(() => ""),
		readFile(`${pp}/purpose.md`).catch(() => ""),
	]);

	const searchResults = await searchWiki(pp, query);
	const topSearchResults = searchResults.slice(0, 10);

	let index = rawIndex;
	if (rawIndex.length > INDEX_BUDGET) {
		const tokens = tokenizeQuery(query);
		const lines = rawIndex.split("\n");
		const keptLines: string[] = [];
		let keptSize = 0;

		for (const line of lines) {
			const isHeader = line.startsWith("##");
			const lower = line.toLowerCase();
			const isRelevant = tokens.some((t) => lower.includes(t));

			if (isHeader || isRelevant) {
				if (keptSize + line.length + 1 <= INDEX_BUDGET) {
					keptLines.push(line);
					keptSize += line.length + 1;
				}
			}
		}
		index = keptLines.join("\n");
		if (index.length < rawIndex.length) {
			index += "\n\n[...index trimmed to relevant entries...]";
		}
	}

	const graph = await buildRetrievalGraph(pp, dataVersion);
	const expandedIds = new Set<string>();
	const searchHitPaths = new Set(topSearchResults.map((r) => r.path));
	const graphExpansions: {
		title: string;
		path: string;
		relevance: number;
	}[] = [];

	for (const result of topSearchResults) {
		const fileName = getFileName(result.path);
		const nodeId = fileName.replace(/\.md$/, "");
		const related = getRelatedNodes(nodeId, graph, 3);
		for (const { node, relevance } of related) {
			if (relevance < 2.0) continue;
			if (searchHitPaths.has(node.path)) continue;
			if (expandedIds.has(node.id)) continue;
			expandedIds.add(node.id);
			graphExpansions.push({
				title: node.title,
				path: node.path,
				relevance,
			});
		}
	}
	graphExpansions.sort((a, b) => b.relevance - a.relevance);

	let usedChars = 0;
	type PageEntry = {
		title: string;
		path: string;
		content: string;
		priority: number;
	};
	const relevantPages: PageEntry[] = [];

	const tryAddPage = async (
		title: string,
		filePath: string,
		priority: number,
	): Promise<boolean> => {
		if (usedChars >= PAGE_BUDGET) return false;
		try {
			const raw = await readFile(filePath);
			const relativePath = getRelativePath(filePath, pp);
			const truncated =
				raw.length > MAX_PAGE_SIZE
					? raw.slice(0, MAX_PAGE_SIZE) + "\n\n[...truncated...]"
					: raw;
			if (usedChars + truncated.length > PAGE_BUDGET) return false;
			usedChars += truncated.length;
			relevantPages.push({
				title,
				path: relativePath,
				content: truncated,
				priority,
			});
			return true;
		} catch {
			return false;
		}
	};

	for (const r of topSearchResults.filter((r) => r.titleMatch)) {
		await tryAddPage(r.title, r.path, 0);
	}
	for (const r of topSearchResults.filter((r) => !r.titleMatch)) {
		await tryAddPage(r.title, r.path, 1);
	}
	for (const exp of graphExpansions) {
		await tryAddPage(exp.title, exp.path, 2);
	}
	if (relevantPages.length === 0) {
		await tryAddPage("Overview", `${pp}/wiki/overview.md`, 3);
	}

	const pagesContext =
		relevantPages.length > 0
			? relevantPages
					.map(
						(p, i) => `### [${i + 1}] ${p.title}\nPath: ${p.path}\n\n${p.content}`,
					)
					.join("\n\n---\n\n")
			: "(No wiki pages found)";

	const pageList = relevantPages
		.map((p, i) => `[${i + 1}] ${p.title} (${p.path})`)
		.join("\n");

	const outLang = getOutputLanguage(query);

	systemMessages.push({
		role: "system",
		content: [
			"You are a knowledgeable wiki assistant. Answer questions based on the wiki content provided below.",
			"",
			"## Rules",
			"- Answer based ONLY on the numbered wiki pages provided below.",
			"- If the provided pages don't contain enough information, say so honestly.",
			"- Use [[wikilink]] syntax to reference wiki pages.",
			"- When citing information, use the page number in brackets, e.g. [1], [2].",
			"- At the VERY END of your response, add a hidden comment listing which page numbers you used:",
			"  <!-- cited: 1, 3, 5 -->",
			"",
			"Use markdown formatting for clarity.",
			"",
			purpose ? `## Wiki Purpose\n${purpose}` : "",
			index ? `## Wiki Index\n${index}` : "",
			relevantPages.length > 0 ? `## Page List\n${pageList}` : "",
			`## Wiki Pages\n\n${pagesContext}`,
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
		]
			.filter(Boolean)
			.join("\n"),
	});

	languageReminder = buildLanguageReminder(query);
	queryRefs = relevantPages.map((p) => ({
		title: p.title,
		path: p.path,
	}));

	return { systemMessages, queryRefs, languageReminder };
}

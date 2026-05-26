import { listDirectory, readFile, writeFile } from "@/commands/fs";
import { sanitizeIngestedFileContent } from "@/lib/ingest-sanitize";
import type { LintResult } from "@/lib/lint";
import { streamChat } from "@/lib/llm-client";
import { buildLanguageDirective } from "@/lib/output-language";
import { getRelativePath, normalizePath } from "@/lib/path-utils";
import { useActivityStore } from "@/stores/activity-store";
import type { LlmConfig } from "@/stores/wiki-store";
import type { FileNode } from "@/types/wiki";

// ── Types ──────────────────────────────────────────────────────────────────────

export interface FixResult {
	success: boolean;
	detail: string;
	filesWritten: string[];
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function flattenMdFiles(nodes: FileNode[]): FileNode[] {
	const files: FileNode[] = [];
	for (const node of nodes) {
		if (node.is_dir && node.children) {
			files.push(...flattenMdFiles(node.children));
		} else if (!node.is_dir && node.name.endsWith(".md")) {
			files.push(node);
		}
	}
	return files;
}

async function tryReadFile(path: string): Promise<string | null> {
	try {
		return await readFile(path);
	} catch {
		return null;
	}
}

async function getWikiPageList(projectPath: string): Promise<string[]> {
	const wikiRoot = `${normalizePath(projectPath)}/wiki`;
	try {
		const tree = await listDirectory(wikiRoot);
		const files = flattenMdFiles(tree);
		return files.map((f) =>
			getRelativePath(f.path, wikiRoot).replace(/\.md$/, ""),
		);
	} catch {
		return [];
	}
}

function isFixable(result: LintResult): boolean {
	if (
		result.type === "orphan" ||
		result.type === "broken-link" ||
		result.type === "no-outlinks"
	) {
		return true;
	}
	if (result.type === "semantic") {
		const subType = getSemanticSubType(result.detail);
		return subType !== "suggestion";
	}
	return false;
}

export { isFixable };

function getSemanticSubType(detail: string): string {
	const m = detail.match(/^\[([^\]]+)\]/);
	return m ? m[1].toLowerCase() : "";
}

// ── Orphan fix (structural, no LLM) ───────────────────────────────────────────

async function fixOrphan(
	projectPath: string,
	result: LintResult,
): Promise<FixResult> {
	const pp = normalizePath(projectPath);
	const indexPath = `${pp}/wiki/index.md`;
	let indexContent = (await tryReadFile(indexPath)) ?? "# Wiki Index\n";

	const pageName = result.page.replace(/\.md$/, "").replace(/^.*\//, "");
	const entry = `- [[${pageName}]]`;
	if (!indexContent.includes(entry)) {
		indexContent = indexContent.trimEnd() + "\n" + entry + "\n";
		await writeFile(indexPath, indexContent);
	}

	return {
		success: true,
		detail: `Linked [[${pageName}]] in index.md`,
		filesWritten: [indexPath],
	};
}

// ── Broken link fix (LLM) ──────────────────────────────────────────────────────

async function fixBrokenLink(
	projectPath: string,
	result: LintResult,
	llmConfig: LlmConfig,
): Promise<FixResult> {
	const pp = normalizePath(projectPath);
	const wikiRoot = `${pp}/wiki`;
	const pagePath = `${wikiRoot}/${result.page}`;
	const content = await tryReadFile(pagePath);
	if (!content)
		return { success: false, detail: "Cannot read page", filesWritten: [] };

	const brokenTarget = result.detail.match(/\[\[([^\]]+)\]\]/)?.[1] ?? "";
	const pageList = await getWikiPageList(pp);

	const prompt = [
		"You are a wiki fixer. The following page contains a broken wikilink that points to a non-existent page.",
		"",
		`Broken link: [[${brokenTarget}]]`,
		"",
		"Options:",
		"- Remove the broken [[wikilink]] entirely (keep the surrounding text)",
		"- Replace it with a link to an existing page if one is clearly the intended target",
		"",
		"Existing pages in the wiki:",
		pageList.map((p) => `  - ${p}`).join("\n"),
		"",
		"Current page content:",
		content,
		"",
		"Output the FULL corrected page. Preserve ALL frontmatter exactly as-is. Only change the broken wikilink.",
	].join("\n");

	const activity = useActivityStore.getState();
	const activityId = activity.addItem({
		type: "lint",
		title: `Fix: broken link in ${result.page}`,
		status: "running",
		detail: "Asking LLM to fix broken link...",
		filesWritten: [],
	});

	let raw = "";
	let hadError = false;

	await streamChat(llmConfig, [{ role: "user", content: prompt }], {
		onToken: (token) => {
			raw += token;
		},
		onDone: () => {},
		onError: (err) => {
			hadError = true;
			activity.updateItem(activityId, {
				status: "error",
				detail: `LLM error: ${err.message}`,
			});
		},
	});

	if (hadError || !raw.trim()) {
		return {
			success: false,
			detail: "LLM did not produce output",
			filesWritten: [],
		};
	}

	const fixed = sanitizeIngestedFileContent(raw.trim());
	await writeFile(pagePath, fixed);
	activity.updateItem(activityId, {
		status: "done",
		detail: "Fixed broken link",
		filesWritten: [pagePath],
	});

	return {
		success: true,
		detail: "Broken link fixed",
		filesWritten: [pagePath],
	};
}

// ── No-outlinks fix (LLM) ──────────────────────────────────────────────────────

async function fixNoOutlinks(
	projectPath: string,
	result: LintResult,
	llmConfig: LlmConfig,
): Promise<FixResult> {
	const pp = normalizePath(projectPath);
	const wikiRoot = `${pp}/wiki`;
	const pagePath = `${wikiRoot}/${result.page}`;
	const content = await tryReadFile(pagePath);
	if (!content)
		return { success: false, detail: "Cannot read page", filesWritten: [] };

	const pageList = await getWikiPageList(pp);

	const prompt = [
		"You are a wiki fixer. The following page has no cross-references ([[wikilinks]]) to other wiki pages.",
		"Add appropriate [[wikilinks]] to existing pages where the content naturally references related concepts or entities.",
		"",
		"Existing pages in the wiki:",
		pageList.map((p) => `  - ${p}`).join("\n"),
		"",
		"Current page content:",
		content,
		"",
		"Rules:",
		"- Only ADD [[wikilinks]] around existing text that references another topic. Do NOT change any other content.",
		"- Only link to pages that exist in the list above.",
		"- Preserve ALL frontmatter exactly as-is.",
		"- Output the FULL corrected page.",
	].join("\n");

	const activity = useActivityStore.getState();
	const activityId = activity.addItem({
		type: "lint",
		title: `Fix: add links to ${result.page}`,
		status: "running",
		detail: "Asking LLM to add cross-references...",
		filesWritten: [],
	});

	let raw = "";
	let hadError = false;

	await streamChat(llmConfig, [{ role: "user", content: prompt }], {
		onToken: (token) => {
			raw += token;
		},
		onDone: () => {},
		onError: (err) => {
			hadError = true;
			activity.updateItem(activityId, {
				status: "error",
				detail: `LLM error: ${err.message}`,
			});
		},
	});

	if (hadError || !raw.trim()) {
		return {
			success: false,
			detail: "LLM did not produce output",
			filesWritten: [],
		};
	}

	const fixed = sanitizeIngestedFileContent(raw.trim());
	await writeFile(pagePath, fixed);
	activity.updateItem(activityId, {
		status: "done",
		detail: "Added cross-references",
		filesWritten: [pagePath],
	});

	return {
		success: true,
		detail: "Added cross-references",
		filesWritten: [pagePath],
	};
}

// ── Semantic fix: contradiction (LLM) ──────────────────────────────────────────

async function fixContradiction(
	projectPath: string,
	result: LintResult,
	llmConfig: LlmConfig,
): Promise<FixResult> {
	const pp = normalizePath(projectPath);
	const wikiRoot = `${pp}/wiki`;
	const affectedPages = result.affectedPages ?? [result.page];

	const pagesContent: string[] = [];
	for (const page of affectedPages) {
		const content = await tryReadFile(`${wikiRoot}/${page}`);
		if (content) {
			pagesContent.push(`### ${page}\n${content}`);
		}
	}

	if (pagesContent.length === 0) {
		return {
			success: false,
			detail: "Cannot read affected pages",
			filesWritten: [],
		};
	}

	const langDirective = buildLanguageDirective(
		pagesContent.join("\n").slice(0, 2000),
	);

	const prompt = [
		"You are a wiki fixer. The following wiki pages contain contradictory information:",
		"",
		langDirective,
		"",
		...pagesContent,
		"",
		"Problem: " + result.detail,
		"",
		"Resolve the contradiction. Preserve all CORRECT information from both pages. Remove or correct only the conflicting claims.",
		"Output each corrected page using this exact format:",
		"",
		"---FILE: path/to/page.md---",
		"(full corrected page content with frontmatter)",
		"---END FILE---",
	].join("\n");

	const activity = useActivityStore.getState();
	const activityId = activity.addItem({
		type: "lint",
		title: "Fix: contradiction",
		status: "running",
		detail: "Resolving contradiction across pages...",
		filesWritten: [],
	});

	let raw = "";
	let hadError = false;

	await streamChat(llmConfig, [{ role: "user", content: prompt }], {
		onToken: (token) => {
			raw += token;
		},
		onDone: () => {},
		onError: (err) => {
			hadError = true;
			activity.updateItem(activityId, {
				status: "error",
				detail: `LLM error: ${err.message}`,
			});
		},
	});

	if (hadError || !raw.trim()) {
		return {
			success: false,
			detail: "LLM did not produce output",
			filesWritten: [],
		};
	}

	const written = await writeFileBlocks(pp, raw);
	activity.updateItem(activityId, {
		status: "done",
		detail: `Resolved contradiction, wrote ${written.length} page(s)`,
		filesWritten: written,
	});

	return {
		success: true,
		detail: "Contradiction resolved",
		filesWritten: written,
	};
}

// ── Semantic fix: stale (LLM) ──────────────────────────────────────────────────

async function fixStale(
	projectPath: string,
	result: LintResult,
	llmConfig: LlmConfig,
): Promise<FixResult> {
	const pp = normalizePath(projectPath);
	const wikiRoot = `${pp}/wiki`;
	const pagePath = `${wikiRoot}/${result.page}`;
	const content = await tryReadFile(pagePath);
	if (!content)
		return { success: false, detail: "Cannot read page", filesWritten: [] };

	const langDirective = buildLanguageDirective(content.slice(0, 2000));

	const prompt = [
		"You are a wiki fixer. The following wiki page may contain outdated or superseded information.",
		"",
		langDirective,
		"",
		"Problem: " + result.detail,
		"",
		"Page content:",
		content,
		"",
		"Review and update any claims that appear stale or superseded.",
		"If you cannot verify whether a claim is still current, add a note:",
		"> ⚠️ This section may need updating.",
		"",
		"Preserve ALL frontmatter exactly as-is. Output the FULL corrected page.",
	].join("\n");

	const activity = useActivityStore.getState();
	const activityId = activity.addItem({
		type: "lint",
		title: `Fix: stale content in ${result.page}`,
		status: "running",
		detail: "Reviewing and updating stale content...",
		filesWritten: [],
	});

	let raw = "";
	let hadError = false;

	await streamChat(llmConfig, [{ role: "user", content: prompt }], {
		onToken: (token) => {
			raw += token;
		},
		onDone: () => {},
		onError: (err) => {
			hadError = true;
			activity.updateItem(activityId, {
				status: "error",
				detail: `LLM error: ${err.message}`,
			});
		},
	});

	if (hadError || !raw.trim()) {
		return {
			success: false,
			detail: "LLM did not produce output",
			filesWritten: [],
		};
	}

	const fixed = sanitizeIngestedFileContent(raw.trim());
	await writeFile(pagePath, fixed);
	activity.updateItem(activityId, {
		status: "done",
		detail: "Updated stale content",
		filesWritten: [pagePath],
	});

	return {
		success: true,
		detail: "Stale content updated",
		filesWritten: [pagePath],
	};
}

// ── Semantic fix: missing-page (LLM) ───────────────────────────────────────────

async function fixMissingPage(
	projectPath: string,
	result: LintResult,
	llmConfig: LlmConfig,
): Promise<FixResult> {
	const pp = normalizePath(projectPath);
	const wikiRoot = `${pp}/wiki`;
	const conceptName = result.page;
	const pageList = await getWikiPageList(pp);

	// Collect excerpts from pages that reference this concept
	const refs: string[] = [];
	const affectedPages = result.affectedPages ?? [];
	for (const page of affectedPages) {
		const content = await tryReadFile(`${wikiRoot}/${page}`);
		if (content) {
			refs.push(`### ${page}\n${content.slice(0, 1500)}`);
		}
	}

	const slug = conceptName
		.toLowerCase()
		.replace(/[^a-z0-9一-鿿]+/g, "-")
		.replace(/^-|-$/g, "");

	const langDirective = buildLanguageDirective(refs.join("\n").slice(0, 2000));

	const prompt = [
		"You are a wiki fixer. The concept or entity below is referenced by multiple wiki pages but has no dedicated page.",
		"Create a new wiki page that consolidates the references into a coherent article.",
		"",
		langDirective,
		"",
		`Concept: ${conceptName}`,
		"",
		"References from existing pages:",
		...refs,
		"",
		"Existing pages in the wiki:",
		pageList.map((p) => `  - ${p}`).join("\n"),
		"",
		`Output the new page using this exact format:`,
		"",
		`---FILE: entities/${slug}.md---`,
		"---",
		`type: entity`,
		`title: "${conceptName}"`,
		`sources: []`,
		`created: ${new Date().toISOString().slice(0, 10)}`,
		`updated: ${new Date().toISOString().slice(0, 10)}`,
		"---",
		"(page body with [[wikilinks]] to existing pages where appropriate)",
		"---END FILE---",
	].join("\n");

	const activity = useActivityStore.getState();
	const activityId = activity.addItem({
		type: "lint",
		title: `Fix: create missing page "${conceptName}"`,
		status: "running",
		detail: "Creating missing page...",
		filesWritten: [],
	});

	let raw = "";
	let hadError = false;

	await streamChat(llmConfig, [{ role: "user", content: prompt }], {
		onToken: (token) => {
			raw += token;
		},
		onDone: () => {},
		onError: (err) => {
			hadError = true;
			activity.updateItem(activityId, {
				status: "error",
				detail: `LLM error: ${err.message}`,
			});
		},
	});

	if (hadError || !raw.trim()) {
		return {
			success: false,
			detail: "LLM did not produce output",
			filesWritten: [],
		};
	}

	const written = await writeFileBlocks(pp, raw);
	activity.updateItem(activityId, {
		status: "done",
		detail: `Created page for "${conceptName}"`,
		filesWritten: written,
	});

	return {
		success: true,
		detail: `Created page for "${conceptName}"`,
		filesWritten: written,
	};
}

// ── FILE block parser + writer (reused from ingest pattern) ────────────────────

async function writeFileBlocks(
	projectPath: string,
	raw: string,
): Promise<string[]> {
	const blocks = parseFileBlocks(raw);
	const pp = normalizePath(projectPath);
	const wikiRoot = `${pp}/wiki`;
	const written: string[] = [];

	for (const block of blocks) {
		const fullPath = `${wikiRoot}/${block.path}`;
		const content = sanitizeIngestedFileContent(block.content.trim());
		await writeFile(fullPath, content);
		written.push(fullPath);
	}

	return written;
}

interface ParsedFileBlock {
	path: string;
	content: string;
}

function parseFileBlocks(raw: string): ParsedFileBlock[] {
	const blocks: ParsedFileBlock[] = [];
	const normalized = raw.replace(/\r\n/g, "\n");
	const regex = /---FILE:\s*([^\n-]+?)\s*---\n([\s\S]*?)---END FILE---/g;
	let match: RegExpExecArray | null;

	while ((match = regex.exec(normalized)) !== null) {
		const path = match[1].trim();
		const content = match[2];
		// Basic safety: reject paths that escape wiki/
		if (path.startsWith("..") || path.startsWith("/")) continue;
		blocks.push({ path, content });
	}

	return blocks;
}

// ── Public API ─────────────────────────────────────────────────────────────────

export async function fixLintResult(
	projectPath: string,
	result: LintResult,
	llmConfig: LlmConfig,
): Promise<FixResult> {
	switch (result.type) {
		case "orphan":
			return fixOrphan(projectPath, result);

		case "broken-link":
			return fixBrokenLink(projectPath, result, llmConfig);

		case "no-outlinks":
			return fixNoOutlinks(projectPath, result, llmConfig);

		case "semantic": {
			const subType = getSemanticSubType(result.detail);
			switch (subType) {
				case "contradiction":
					return fixContradiction(projectPath, result, llmConfig);
				case "stale":
					return fixStale(projectPath, result, llmConfig);
				case "missing-page":
					return fixMissingPage(projectPath, result, llmConfig);
				default:
					return {
						success: false,
						detail: "Cannot auto-fix this suggestion",
						filesWritten: [],
					};
			}
		}

		default:
			return {
				success: false,
				detail: `Unknown type: ${result.type}`,
				filesWritten: [],
			};
	}
}

export async function fixAllLintResults(
	projectPath: string,
	results: readonly LintResult[],
	llmConfig: LlmConfig,
): Promise<FixResult[]> {
	const fixable = results.filter(isFixable);
	const fixResults: FixResult[] = [];

	for (const result of fixable) {
		const fixResult = await fixLintResult(projectPath, result, llmConfig);
		fixResults.push(fixResult);
	}

	return fixResults;
}

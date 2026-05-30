import { listDirectory, readFile, writeFile } from "@/commands/fs";
import { hasUsableLlm } from "@/lib/has-usable-llm";
import { parseFileBlocks } from "@/lib/ingest";
import { sanitizeIngestedFileContent } from "@/lib/ingest-sanitize";
import { type LintResult, runStructuralLint, runSemanticLint, generateLintReport, lintReportToMarkdown, type LintReport } from "@/lib/lint";
import { streamChat } from "@/lib/llm-client";
import { buildLanguageDirective } from "@/lib/output-language";
import { getRelativePath, normalizePath } from "@/lib/path-utils";
import { cascadeDeleteWikiPagesWithRefs } from "@/lib/wiki-page-delete";
import { useActivityStore } from "@/stores/activity-store";
import type { LlmConfig } from "@/stores/wiki-store";

/**
 * Can this lint result be auto-fixed?
 * All types except "suggestion" (too vague) are fixable.
 */
export function isFixable(result: LintResult): boolean {
	if (result.type === "orphan") return true;
	if (result.type === "broken-link") return true;
	if (result.type === "no-outlinks") return true;
	if (result.type === "semantic") {
		const detail = result.detail.toLowerCase();
		// suggestion sub-type is too vague to auto-fix
		if (detail.startsWith("[suggestion]")) return false;
		return true;
	}
	return false;
}

/**
 * Fix a single lint result. Returns true if the fix was applied.
 */
export async function fixLintResult(
	projectPath: string,
	result: LintResult,
	llmConfig: LlmConfig,
): Promise<boolean> {
	const pp = normalizePath(projectPath);

	switch (result.type) {
		case "orphan":
			return fixOrphan(pp, result);
		case "broken-link":
			return fixBrokenLink(pp, result, llmConfig);
		case "no-outlinks":
			return fixNoOutlinks(pp, result, llmConfig);
		case "semantic":
			return fixSemantic(pp, result, llmConfig);
		default:
			return false;
	}
}

/**
 * Fix all fixable lint results sequentially.
 * Returns the number of successfully fixed results and the remaining unfixed.
 */
export async function fixAllLintResults(
	projectPath: string,
	results: readonly LintResult[],
	llmConfig: LlmConfig,
	onProgress?: (fixed: number, total: number) => void,
): Promise<{ fixed: LintResult[]; failed: LintResult[] }> {
	const fixable = results.filter((r) => isFixable(r) && r.type !== "orphan");
	const fixed: LintResult[] = [];
	const failed: LintResult[] = [];

	for (let i = 0; i < fixable.length; i++) {
		try {
			const ok = await fixLintResult(projectPath, fixable[i], llmConfig);
			if (ok) {
				fixed.push(fixable[i]);
			} else {
				failed.push(fixable[i]);
			}
		} catch {
			failed.push(fixable[i]);
		}
		onProgress?.(i + 1, fixable.length);
	}

	return { fixed, failed };
}

// ── Fix strategies ──────────────────────────────────────────────────────────

async function fixOrphan(pp: string, result: LintResult): Promise<boolean> {
	// Strategy: delete the orphan page (user can undo via git)
	const pagePath = `${pp}/wiki/${result.page}`;
	try {
		await cascadeDeleteWikiPagesWithRefs(pp, [pagePath]);
		return true;
	} catch {
		return false;
	}
}

async function fixBrokenLink(
	pp: string,
	result: LintResult,
	llmConfig: LlmConfig,
): Promise<boolean> {
	if (!hasUsableLlm(llmConfig)) return false;

	const activity = useActivityStore.getState();
	const activityId = activity.addItem({
		type: "lint",
		title: `Fix broken link: ${result.page}`,
		status: "running",
		detail: "Reading page content...",
		filesWritten: [],
	});

	try {
		const pagePath = `${pp}/wiki/${result.page}`;
		let content = "";
		try {
			content = await readFile(pagePath);
		} catch {
			activity.updateItem(activityId, {
				status: "error",
				detail: "Cannot read page.",
			});
			return false;
		}

		// Extract the broken link target from detail: "Broken link: [[Foo]] — ..."
		const linkMatch = result.detail.match(/\[\[([^\]]+)\]\]/);
		if (!linkMatch) {
			activity.updateItem(activityId, {
				status: "error",
				detail: "Cannot identify broken link.",
			});
			return false;
		}
		const brokenTarget = linkMatch[1];

		// Collect available wiki page paths for link matching
		activity.updateItem(activityId, { detail: "Scanning wiki pages..." });
		let pageList = "";
		try {
			const tree = await listDirectory(pp);
			const pages: string[] = [];
			(function collect(
				nodes: readonly {
					name: string;
					path: string;
					children?: readonly {
						name: string;
						path: string;
						children?: unknown[];
					}[];
				}[],
			) {
				for (const node of nodes) {
					if (node.path.endsWith(".md") && node.path.includes("/wiki/")) {
						pages.push(
							node.path.replace(/.*\/wiki\//, "").replace(/\.md$/, ""),
						);
					}
					if (node.children)
						collect(node.children as Parameters<typeof collect>[0]);
				}
			})(tree);
			pageList = pages.join("\n");
		} catch {
			pageList = "";
		}

		activity.updateItem(activityId, { detail: "Asking LLM to fix..." });

		const prompt = [
			"You are a wiki editor. The following wiki page has a broken wikilink that points to a page that doesn't exist.",
			"",
			buildLanguageDirective(content),
			"",
			"Broken link: [[{target}]]",
			"",
			pageList
				? `## Available wiki pages (use these to fix the link):\n\n${pageList}\n`
				: "",
			"Fix strategy (in order of preference):",
			"1. BEST: If a page with a similar name exists, fix the wikilink to point to it (e.g. [[page-path|Display Text]]).",
			"2. OK: If the concept is genuinely missing and no similar page exists, create a brief mention inline and remove the wikilink.",
			"3. LAST RESORT: If the link is irrelevant, remove it.",
			"",
			"Output the FULL corrected page below. Do NOT wrap in code fences.",
			"",
			"## Original page:",
			"",
			content,
		]
			.join("\n")
			.replace("{target}", brokenTarget);

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

		if (hadError || !raw.trim()) return false;

		const sanitized = sanitizeIngestedFileContent(raw);
		await writeFile(pagePath, sanitized);
		activity.updateItem(activityId, {
			status: "done",
			detail: `Fixed broken link in ${result.page}`,
			filesWritten: [`wiki/${result.page}`],
		});
		return true;
	} catch (err) {
		activity.updateItem(activityId, { status: "error", detail: String(err) });
		return false;
	}
}

async function fixNoOutlinks(
	pp: string,
	result: LintResult,
	llmConfig: LlmConfig,
): Promise<boolean> {
	if (!hasUsableLlm(llmConfig)) return false;

	const activity = useActivityStore.getState();
	const activityId = activity.addItem({
		type: "lint",
		title: `Add cross-refs: ${result.page}`,
		status: "running",
		detail: "Reading page and wiki index...",
		filesWritten: [],
	});

	try {
		const pagePath = `${pp}/wiki/${result.page}`;
		let content = "";
		try {
			content = await readFile(pagePath);
		} catch {
			activity.updateItem(activityId, {
				status: "error",
				detail: "Cannot read page.",
			});
			return false;
		}

		// Read index to find related pages
		let indexContent = "";
		try {
			indexContent = await readFile(`${pp}/wiki/index.md`);
		} catch {
			indexContent = "";
		}

		activity.updateItem(activityId, {
			detail: "Asking LLM to add cross-references...",
		});

		const prompt = [
			"You are a wiki editor. The following wiki page has NO outbound wikilinks to other pages.",
			"Add appropriate [[wikilinks]] to related concepts, entities, or topics mentioned in the text.",
			"",
			buildLanguageDirective(content),
			"",
			"## Available wiki pages (from index):",
			"",
			indexContent.slice(0, 2000) || "(no index available)",
			"",
			"Rules:",
			"- Add wikilinks for key terms: [[Term]]",
			"- Only link to pages that likely exist or should exist",
			"- Don't over-link — only important concepts deserve links",
			"- Output the FULL corrected page. Do NOT wrap in code fences.",
			"",
			"## Original page:",
			"",
			content,
		].join("\n");

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

		if (hadError || !raw.trim()) return false;

		const sanitized = sanitizeIngestedFileContent(raw);
		await writeFile(pagePath, sanitized);
		activity.updateItem(activityId, {
			status: "done",
			detail: `Added cross-refs to ${result.page}`,
			filesWritten: [`wiki/${result.page}`],
		});
		return true;
	} catch (err) {
		activity.updateItem(activityId, { status: "error", detail: String(err) });
		return false;
	}
}

async function fixSemantic(
	pp: string,
	result: LintResult,
	llmConfig: LlmConfig,
): Promise<boolean> {
	if (!hasUsableLlm(llmConfig)) return false;

	// Parse sub-type from "[subtype] description"
	const subMatch = result.detail.match(/^\[([^\]]+)\]/);
	const subType = subMatch ? subMatch[1] : "";

	if (subType === "contradiction")
		return fixContradiction(pp, result, llmConfig);
	if (subType === "stale") return fixStale(pp, result, llmConfig);
	if (subType === "missing-page") return fixMissingPage(pp, result, llmConfig);
	if (subType === "suggestion") return false;

	// Generic semantic fix — best-effort LLM repair
	return fixGenericSemantic(pp, result, llmConfig);
}

async function fixContradiction(
	pp: string,
	result: LintResult,
	llmConfig: LlmConfig,
): Promise<boolean> {
	if (!result.affectedPages || result.affectedPages.length < 2) return false;

	const activity = useActivityStore.getState();
	const activityId = activity.addItem({
		type: "lint",
		title: `Fix contradiction: ${result.page}`,
		status: "running",
		detail: "Reading conflicting pages...",
		filesWritten: [],
	});

	try {
		const pages: Record<string, string> = {};
		for (const page of result.affectedPages) {
			try {
				pages[page] = await readFile(`${pp}/wiki/${page}`);
			} catch {
				// skip unreadable pages
			}
		}

		if (Object.keys(pages).length < 2) {
			activity.updateItem(activityId, {
				status: "error",
				detail: "Cannot read enough pages.",
			});
			return false;
		}

		activity.updateItem(activityId, {
			detail: "Asking LLM to resolve contradiction...",
		});

		const pagesSection = Object.entries(pages)
			.map(([name, content]) => `### ${name}\n${content.slice(0, 1500)}`)
			.join("\n\n");

		const prompt = [
			"You are a wiki editor. A contradiction was detected between wiki pages.",
			"Review the pages below and fix the contradiction by editing the pages to be consistent.",
			"",
			buildLanguageDirective(Object.values(pages).join("\n")),
			"",
			"Issue: {detail}",
			"",
			"## Pages:",
			"",
			pagesSection,
			"",
			"For each page that needs editing, output in this format:",
			"---FILE: page/path.md---",
			"(full corrected content)",
			"---END FILE---",
			"",
			"Only output pages you actually changed. Do NOT wrap in code fences.",
		]
			.join("\n")
			.replace("{detail}", result.detail);

		return await applyLlmFix(
			pp,
			prompt,
			llmConfig,
			activity,
			activityId,
			result,
		);
	} catch (err) {
		activity.updateItem(activityId, { status: "error", detail: String(err) });
		return false;
	}
}

async function fixStale(
	pp: string,
	result: LintResult,
	llmConfig: LlmConfig,
): Promise<boolean> {
	const activity = useActivityStore.getState();
	const activityId = activity.addItem({
		type: "lint",
		title: `Fix stale info: ${result.page}`,
		status: "running",
		detail: "Reading page...",
		filesWritten: [],
	});

	try {
		const targetPages = result.affectedPages ?? [result.page];
		const pages: Record<string, string> = {};
		for (const page of targetPages) {
			try {
				pages[page] = await readFile(`${pp}/wiki/${page}`);
			} catch {
				// skip
			}
		}

		if (Object.keys(pages).length === 0) {
			activity.updateItem(activityId, {
				status: "error",
				detail: "Cannot read pages.",
			});
			return false;
		}

		activity.updateItem(activityId, {
			detail: "Asking LLM to update stale info...",
		});

		const pagesSection = Object.entries(pages)
			.map(([name, content]) => `### ${name}\n${content.slice(0, 1500)}`)
			.join("\n\n");

		const prompt = [
			"You are a wiki editor. The following pages contain stale or outdated information.",
			"Update the content to reflect current knowledge. Mark uncertain claims with [needs verification].",
			"",
			buildLanguageDirective(Object.values(pages).join("\n")),
			"",
			"Issue: {detail}",
			"",
			"## Pages:",
			"",
			pagesSection,
			"",
			"For each page that needs editing, output in this format:",
			"---FILE: page/path.md---",
			"(full corrected content)",
			"---END FILE---",
			"",
			"Only output pages you actually changed. Do NOT wrap in code fences.",
		]
			.join("\n")
			.replace("{detail}", result.detail);

		return await applyLlmFix(
			pp,
			prompt,
			llmConfig,
			activity,
			activityId,
			result,
		);
	} catch (err) {
		activity.updateItem(activityId, { status: "error", detail: String(err) });
		return false;
	}
}

async function fixMissingPage(
	pp: string,
	result: LintResult,
	llmConfig: LlmConfig,
): Promise<boolean> {
	const activity = useActivityStore.getState();
	const activityId = activity.addItem({
		type: "lint",
		title: `Create missing page: ${result.page}`,
		status: "running",
		detail: "Reading related pages for context...",
		filesWritten: [],
	});

	try {
		// Read pages that reference the missing concept
		const relatedPages: string[] = [];
		for (const page of result.affectedPages ?? []) {
			try {
				const c = await readFile(`${pp}/wiki/${page}`);
				relatedPages.push(`### ${page}\n${c.slice(0, 800)}`);
			} catch {
				// skip
			}
		}

		activity.updateItem(activityId, { detail: "Asking LLM to create page..." });

		const pageName = result.page.replace(/\.md$/, "");

		const prompt = [
			"You are a wiki editor. An important concept is heavily referenced but has no dedicated page.",
			"Create a new wiki page for this concept based on how it's referenced in existing pages.",
			"",
			buildLanguageDirective(relatedPages.join("\n")),
			"",
			`Missing concept: ${pageName}`,
			"Issue: {detail}",
			"",
			"## References from other pages:",
			"",
			relatedPages.join("\n\n") || "(no references available)",
			"",
			"Output the new page in this format:",
			`---FILE: ${pageName}.md---`,
			"(full page content with YAML frontmatter, including type and tags)",
			"---END FILE---",
			"",
			"Do NOT wrap in code fences.",
		]
			.join("\n")
			.replace("{detail}", result.detail);

		return await applyLlmFix(
			pp,
			prompt,
			llmConfig,
			activity,
			activityId,
			result,
		);
	} catch (err) {
		activity.updateItem(activityId, { status: "error", detail: String(err) });
		return false;
	}
}

async function fixGenericSemantic(
	pp: string,
	result: LintResult,
	llmConfig: LlmConfig,
): Promise<boolean> {
	const activity = useActivityStore.getState();
	const activityId = activity.addItem({
		type: "lint",
		title: `Fix semantic issue: ${result.page}`,
		status: "running",
		detail: "Reading pages...",
		filesWritten: [],
	});

	try {
		const targetPages = result.affectedPages ?? [result.page];
		const pages: Record<string, string> = {};
		for (const page of targetPages) {
			try {
				pages[page] = await readFile(`${pp}/wiki/${page}`);
			} catch {
				// skip
			}
		}

		if (Object.keys(pages).length === 0) {
			activity.updateItem(activityId, {
				status: "error",
				detail: "Cannot read pages.",
			});
			return false;
		}

		activity.updateItem(activityId, { detail: "Asking LLM to fix..." });

		const pagesSection = Object.entries(pages)
			.map(([name, content]) => `### ${name}\n${content.slice(0, 1500)}`)
			.join("\n\n");

		const prompt = [
			"You are a wiki editor. A semantic issue was detected in the wiki.",
			"Review the pages and fix the issue.",
			"",
			buildLanguageDirective(Object.values(pages).join("\n")),
			"",
			"Issue: {detail}",
			"",
			"## Pages:",
			"",
			pagesSection,
			"",
			"For each page that needs editing, output in this format:",
			"---FILE: page/path.md---",
			"(full corrected content)",
			"---END FILE---",
			"",
			"Only output pages you actually changed. Do NOT wrap in code fences.",
		]
			.join("\n")
			.replace("{detail}", result.detail);

		return await applyLlmFix(
			pp,
			prompt,
			llmConfig,
			activity,
			activityId,
			result,
		);
	} catch (err) {
		activity.updateItem(activityId, { status: "error", detail: String(err) });
		return false;
	}
}

// ── Shared LLM output parser ────────────────────────────────────────────────

async function applyLlmFix(
	pp: string,
	prompt: string,
	llmConfig: LlmConfig,
	activity: ReturnType<typeof useActivityStore.getState>,
	activityId: string,
	result: LintResult,
): Promise<boolean> {
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

	if (hadError || !raw.trim()) return false;

	const parsed = parseFileBlocks(raw);
	if (parsed.blocks.length === 0) {
		activity.updateItem(activityId, {
			status: "error",
			detail: "LLM did not output valid file blocks.",
		});
		return false;
	}

	const filesWritten: string[] = [];
	for (const block of parsed.blocks) {
		const targetPath = block.path.startsWith(pp)
			? block.path
			: `${pp}/wiki/${block.path.replace(/^\/+/, "")}`;
		const sanitized = sanitizeIngestedFileContent(block.content);
		await writeFile(targetPath, sanitized);
		filesWritten.push(getRelativePath(targetPath, pp));
	}

	activity.updateItem(activityId, {
		status: "done",
		detail: `Fixed: ${result.page} (${filesWritten.length} file(s) updated)`,
		filesWritten,
	});
	return true;
}

// ── Batch report-driven fix (Phase 3.65-B) ───────────────────────────────────


export interface FixLintReportResult {
  report: LintReport
  reportPath: string
}

/**
 * Fix all auto-fix items in a lint report and append a repair log.
 * Writes the updated report back to the same wiki page.
 */
export async function fixLintReport(
  projectPath: string,
  report: LintReport,
  reportPath: string,
  llmConfig: LlmConfig,
): Promise<FixLintReportResult> {
  const pp = normalizePath(projectPath)
  const activity = useActivityStore.getState()

  const fixed: string[] = []
  const failed: string[] = []
  const skipped: string[] = []

  for (const item of report.autoFixItems) {
    try {
      const ok = await fixLintResult(pp, item, llmConfig)
      if (ok) {
        fixed.push(`[${item.type}] ${item.page}: ${item.detail.slice(0, 80)}`)
      } else {
        failed.push(`[${item.type}] ${item.page}: fix returned false`)
      }
    } catch (err) {
      failed.push(
        `[${item.type}] ${item.page}: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  for (const item of report.humanItems) {
    skipped.push(`[${item.type}] ${item.page}: requires human judgment`)
  }

  report = { ...report, repairLog: { fixed, failed, skipped } }

  const runId =
    reportPath.match(/lint-report-([a-zA-Z0-9]+)\.md$/)?.[1] ??
    new Date().toISOString().slice(0, 10).replace(/-/g, "")
  const markdown = lintReportToMarkdown(report, runId)

  const fullPath = `${pp}/${reportPath}`
  await writeFile(fullPath, markdown)

  activity.addItem({
    type: "lint",
    title: "Auto-fix lint report",
    status: "done",
    detail: `Fixed ${fixed.length}, failed ${failed.length}, skipped ${skipped.length}`,
    filesWritten: [reportPath],
  })

  return { report, reportPath }
}

/**
 * Run structural + semantic lint, generate a report, and save it as a wiki page.
 * Returns the report and its path for later consumption by fixLintReport.
 */
export async function runLintAndReport(
  projectPath: string,
  llmConfig: LlmConfig,
  fileTree: readonly { name: string; path: string; is_dir: boolean; children?: unknown[] }[],
  includeStructural = true,
  includeSemantic = true,
): Promise<{ report: LintReport; reportPath: string }> {
  const structural = includeStructural ? await runStructuralLint(projectPath) : []
  const semantic = includeSemantic ? await runSemanticLint(projectPath, llmConfig) : []

  const results = [...structural, ...semantic]

  // Count wiki pages
  let wikiPageCount = 0
  const countPages = (nodes: readonly { name: string; path: string; is_dir: boolean; children?: unknown[] }[]) => {
    for (const n of nodes) {
      if (n.is_dir && n.children) {
        countPages(n.children as typeof nodes)
      } else if (n.name.endsWith(".md")) {
        wikiPageCount++
      }
    }
  }
  countPages(fileTree)

  const report = generateLintReport(results, wikiPageCount)

  const now = new Date()
  const runId = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}`
  const reportPath = `wiki/lint-report-${runId}.md`

  const markdown = lintReportToMarkdown(report, runId)

  const pp = normalizePath(projectPath)
  const fullPath = `${pp}/${reportPath}`
  await writeFile(fullPath, markdown)

  return { report, reportPath }
}

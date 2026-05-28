import { listDirectory, readFile, writeFile } from "@/commands/fs";
import { hasUsableLlm } from "@/lib/has-usable-llm";
import { normalizePath } from "@/lib/path-utils";
import { makeQueryFileName } from "@/lib/wiki-filename";
import type { LlmConfig } from "@/stores/wiki-store";
import type { FileNode } from "@/types/wiki";

export interface SaveQueryPageArgs {
	projectPath: string;
	content: string;
	title?: string;
	tags?: string[];
	autoIngest?: boolean;
	llmConfig?: LlmConfig;
}

export interface SaveQueryPageResult {
	path: string;
	relativePath: string;
	title: string;
	fileName: string;
	date: string;
	indexUpdated: boolean;
	logUpdated: boolean;
	autoIngestStarted: boolean;
	fileTree: FileNode[];
}

function cleanSavedQueryContent(content: string): string {
	return content
		.replace(/<!--\s*save-worthy:.*?-->/g, "")
		.replace(/<!--\s*sources:.*?-->/g, "")
		.replace(/<think(?:ing)?>\s*[\s\S]*?<\/think(?:ing)?>\s*/gi, "")
		.replace(/<think(?:ing)?>\s*[\s\S]*$/gi, "")
		.trimEnd();
}

function inferTitle(content: string): string {
	const firstLine =
		content
			.split("\n")
			.find((line) => line.trim() && !line.trim().startsWith("<!--"))
			?.replace(/^#+\s*/, "")
			.trim() || "Saved Query";
	return firstLine.slice(0, 60) || "Saved Query";
}

function frontmatter(title: string, date: string, tags: string[] = []): string {
	return [
		"---",
		"type: query",
		`title: "${title.replace(/"/g, '\\"')}"`,
		`created: ${date}`,
		`tags: [${tags.map((tag) => JSON.stringify(tag)).join(", ")}]`,
		"---",
		"",
	].join("\n");
}

/**
 * Saves assistant/review text as a query page using the canonical Wiki rules.
 * This keeps Chat, Review, and future Agent tools on one index/log path.
 */
export async function saveQueryPage({
	projectPath,
	content,
	title,
	tags,
	autoIngest = false,
	llmConfig,
}: SaveQueryPageArgs): Promise<SaveQueryPageResult> {
	const pp = normalizePath(projectPath);
	const cleanContent = cleanSavedQueryContent(content);
	const pageTitle = (title?.trim() || inferTitle(cleanContent)).slice(0, 60) || "Saved Query";
	const { date, fileName } = makeQueryFileName(pageTitle);
	const relativePath = `wiki/queries/${fileName}`;
	const filePath = `${pp}/${relativePath}`;

	await writeFile(filePath, frontmatter(pageTitle, date, tags) + cleanContent);

	const indexPath = `${pp}/wiki/index.md`;
	let indexContent = "";
	try {
		indexContent = await readFile(indexPath);
	} catch {
		indexContent = "# Wiki Index\n\n## Queries\n";
	}
	const linkTarget = fileName.replace(/\.md$/, "");
	const entry = `- [[queries/${linkTarget}|${pageTitle}]]`;
	if (indexContent.includes("## Queries")) {
		indexContent = indexContent.replace(/(## Queries\n)/, `$1${entry}\n`);
	} else {
		indexContent = indexContent.trimEnd() + "\n\n## Queries\n" + entry + "\n";
	}
	await writeFile(indexPath, indexContent);

	const logPath = `${pp}/wiki/log.md`;
	let logContent = "";
	try {
		logContent = await readFile(logPath);
	} catch {
		logContent = "# Wiki Log\n\n";
	}
	const logEntry = `- ${date}: Saved query page \`${fileName}\`\n`;
	await writeFile(logPath, logContent.trimEnd() + "\n" + logEntry);

	const fileTree = await listDirectory(pp);

	let autoIngestStarted = false;
	if (autoIngest && llmConfig && hasUsableLlm(llmConfig)) {
		autoIngestStarted = true;
		void import("@/lib/ingest")
			.then(({ autoIngest: runAutoIngest }) =>
				runAutoIngest(pp, filePath, llmConfig),
			)
			.catch((err) => console.error("Failed to auto-ingest saved query:", err));
	}

	return {
		path: filePath,
		relativePath,
		title: pageTitle,
		fileName,
		date,
		indexUpdated: true,
		logUpdated: true,
		autoIngestStarted,
		fileTree,
	};
}

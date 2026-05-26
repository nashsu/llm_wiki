import {
	AlertTriangle,
	ArrowUpRight,
	BrainCircuit,
	CheckCircle2,
	Info,
	Link2Off,
	RefreshCw,
	Sparkles,
	Trash2,
	Unlink,
	Wrench,
	Zap,
} from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { listDirectory, readFile, writeFile } from "@/commands/fs";
import { Button } from "@/components/ui/button";
import { hasUsableLlm } from "@/lib/has-usable-llm";
import {
	type LintResult,
	runSemanticLint,
	runStructuralLint,
} from "@/lib/lint";
import { fixAllLintResults, fixLintResult, isFixable } from "@/lib/lint-fixer";
import { normalizePath } from "@/lib/path-utils";
import { useReviewStore } from "@/stores/review-store";
import { useWikiStore } from "@/stores/wiki-store";

interface IndexedLintResult {
	result: LintResult;
	index: number;
}

export function groupLintResultsForDisplay(results: readonly LintResult[]): {
	warnings: IndexedLintResult[];
	infos: IndexedLintResult[];
} {
	const warnings: IndexedLintResult[] = [];
	const infos: IndexedLintResult[] = [];

	results.forEach((result, index) => {
		const item = { result, index };
		if (result.severity === "warning") {
			warnings.push(item);
		} else {
			infos.push(item);
		}
	});

	return { warnings, infos };
}

export function LintView() {
	const { t } = useTranslation();
	const project = useWikiStore((s) => s.project);
	const llmConfig = useWikiStore((s) => s.llmConfig);
	const setSelectedFile = useWikiStore((s) => s.setSelectedFile);
	const setFileContent = useWikiStore((s) => s.setFileContent);
	const setActiveView = useWikiStore((s) => s.setActiveView);
	const setFileTree = useWikiStore((s) => s.setFileTree);
	const bumpDataVersion = useWikiStore((s) => s.bumpDataVersion);

	// Dynamic type config based on i18n
	const typeConfig = useMemo(
		() => ({
			orphan: { icon: Unlink, label: t("lint.typeLabels.orphan") },
			"broken-link": {
				icon: Link2Off,
				label: t("lint.typeLabels.broken-link"),
			},
			"no-outlinks": {
				icon: ArrowUpRight,
				label: t("lint.typeLabels.no-outlinks"),
			},
			semantic: { icon: BrainCircuit, label: t("lint.typeLabels.semantic") },
		}),
		[t],
	);

	const [results, setResults] = useState<LintResult[]>([]);
	const [running, setRunning] = useState(false);
	const [hasRun, setHasRun] = useState(false);
	const [runSemantic, setRunSemantic] = useState(false);
	const [fixingId, setFixingId] = useState<string | null>(null);
	const [fixingAll, setFixingAll] = useState(false);

	const refreshTree = useCallback(async () => {
		if (!project) return;
		const pp = normalizePath(project.path);
		const tree = await listDirectory(pp);
		setFileTree(tree);
		bumpDataVersion();
	}, [project, setFileTree, bumpDataVersion]);

	const handleRunLint = useCallback(async () => {
		if (!project || running) return;
		const pp = normalizePath(project.path);
		setRunning(true);
		setResults([]);
		try {
			const structural = await runStructuralLint(pp);
			let all = structural;

			if (runSemantic && hasUsableLlm(llmConfig)) {
				const semantic = await runSemanticLint(pp, llmConfig);
				all = [...structural, ...semantic];
			}

			setResults(all);
			setHasRun(true);
		} catch (err) {
			console.error("Lint failed:", err);
		} finally {
			setRunning(false);
		}
	}, [project, llmConfig, running, runSemantic]);

	async function handleOpenPage(page: string) {
		if (!project) return;
		const pp = normalizePath(project.path);
		const candidates = [`${pp}/wiki/${page}`, `${pp}/wiki/${page}.md`];
		setActiveView("wiki");
		for (const path of candidates) {
			try {
				const content = await readFile(path);
				setSelectedFile(path);
				setFileContent(content);
				return;
			} catch {
				// try next
			}
		}
		setSelectedFile(candidates[0]);
		setFileContent(`Unable to load: ${page}`);
	}

	async function handleFix(result: LintResult, index: number) {
		if (!project) return;
		const pp = normalizePath(project.path);
		const id = `${result.type}-${index}`;
		setFixingId(id);

		try {
			switch (result.type) {
				case "orphan": {
					const indexPath = `${pp}/wiki/index.md`;
					let indexContent = "";
					try {
						indexContent = await readFile(indexPath);
					} catch {
						indexContent = "# Wiki Index\n";
					}
					const pageName = result.page.replace(".md", "").replace(/^.*\//, "");
					const entry = `- [[${pageName}]]`;
					if (!indexContent.includes(entry)) {
						indexContent = indexContent.trimEnd() + "\n" + entry + "\n";
						await writeFile(indexPath, indexContent);
					}
					setResults((prev) => prev.filter((_, i) => i !== index));
					break;
				}
				case "broken-link": {
					const pagePath = `${pp}/wiki/${result.page}`;
					useReviewStore.getState().addItem({
						type: "confirm",
						title: t("lint.fixBrokenLink", { page: result.page }),
						description: result.detail,
						affectedPages: [result.page],
						options: [
							{ label: t("lint.openEdit"), action: `open:${result.page}` },
							{ label: t("lint.deletePage"), action: `delete:${pagePath}` },
							{ label: t("lint.skip"), action: "Skip" },
						],
					});
					setResults((prev) => prev.filter((_, i) => i !== index));
					break;
				}
				case "no-outlinks": {
					useReviewStore.getState().addItem({
						type: "suggestion",
						title: t("lint.addCrossRefs", { page: result.page }),
						description: t("lint.addCrossRefsDescription"),
						affectedPages: [result.page],
						options: [
							{ label: t("lint.openEdit"), action: `open:${result.page}` },
							{ label: t("lint.skip"), action: "Skip" },
						],
					});
					setResults((prev) => prev.filter((_, i) => i !== index));
					break;
				}
				default: {
					useReviewStore.getState().addItem({
						type: "confirm",
						title: result.detail.slice(0, 80),
						description: result.detail,
						affectedPages: result.affectedPages ?? [result.page],
						options: [
							{ label: t("lint.openEdit"), action: `open:${result.page}` },
							{ label: t("lint.skip"), action: "Skip" },
						],
					});
					setResults((prev) => prev.filter((_, i) => i !== index));
					break;
				}
			}
			await refreshTree();
		} catch (err) {
			console.error("Fix failed:", err);
		} finally {
			setFixingId(null);
		}
	}

	async function handleAutoFix(result: LintResult, index: number) {
		if (!project || !hasUsableLlm(llmConfig)) return;
		const id = `${result.type}-${index}`;
		setFixingId(id);

		try {
			const pp = normalizePath(project.path);
			const fixResult = await fixLintResult(pp, result, llmConfig);
			if (fixResult.success) {
				setResults((prev) => prev.filter((_, i) => i !== index));
			}
			await refreshTree();
		} catch (err) {
			console.error("Auto fix failed:", err);
		} finally {
			setFixingId(null);
		}
	}

	async function handleFixAll() {
		if (!project || !hasUsableLlm(llmConfig) || fixingAll) return;
		setFixingAll(true);

		try {
			const pp = normalizePath(project.path);
			const fixable = results.filter(isFixable);
			const fixResults = await fixAllLintResults(pp, fixable, llmConfig);

			const fixedIndices = new Set<number>();
			fixable.forEach((result, i) => {
				if (fixResults[i]?.success) {
					const origIndex = results.indexOf(result);
					if (origIndex >= 0) fixedIndices.add(origIndex);
				}
			});
			setResults((prev) => prev.filter((_, i) => !fixedIndices.has(i)));
			await refreshTree();
		} catch (err) {
			console.error("Fix all failed:", err);
		} finally {
			setFixingAll(false);
		}
	}

	async function handleDeleteOrphan(result: LintResult, index: number) {
		if (!project) return;
		const pp = normalizePath(project.path);
		const pagePath = `${pp}/wiki/${result.page}`;
		const confirmed = window.confirm(
			t("lint.deleteOrphanConfirm", { page: result.page }),
		);
		if (!confirmed) return;

		try {
			const { cascadeDeleteWikiPagesWithRefs } = await import(
				"@/lib/wiki-page-delete"
			);
			await cascadeDeleteWikiPagesWithRefs(pp, [pagePath]);
			setResults((prev) => prev.filter((_, i) => i !== index));
			await refreshTree();
		} catch (err) {
			console.error("Delete failed:", err);
		}
	}

	const fixableCount = useMemo(
		() => results.filter(isFixable).length,
		[results],
	);

	const { warnings, infos } = useMemo(
		() => groupLintResultsForDisplay(results),
		[results],
	);

	return (
		<div className="flex h-full flex-col">
			<div className="shrink-0 flex items-center justify-between border-b px-4 py-3">
				<div className="flex items-center gap-2">
					<h2 className="text-sm font-semibold">{t("lint.title")}</h2>
					{hasRun && results.length > 0 && (
						<span className="rounded-full bg-amber-500/20 px-2 py-0.5 text-xs font-medium text-amber-600 dark:text-amber-400">
							{results.length === 1
								? t("lint.issues", { count: results.length })
								: t("lint.issues_plural", { count: results.length })}
						</span>
					)}
				</div>
				<div className="flex items-center gap-2">
					{hasRun && fixableCount > 0 && (
						<Button
							size="sm"
							variant="outline"
							onClick={handleFixAll}
							disabled={fixingAll || !hasUsableLlm(llmConfig)}
						>
							<Zap
								className={`mr-1.5 h-3.5 w-3.5 ${fixingAll ? "animate-pulse" : ""}`}
							/>
							{fixingAll ? t("lint.fixingAll") : t("lint.fixAll")}
						</Button>
					)}
					<label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer">
						<input
							type="checkbox"
							className="h-3 w-3"
							checked={runSemantic}
							onChange={(e) => setRunSemantic(e.target.checked)}
						/>
						{t("lint.semantic")}
					</label>
					<Button
						size="sm"
						onClick={handleRunLint}
						disabled={running || !project}
					>
						<RefreshCw
							className={`mr-1.5 h-3.5 w-3.5 ${running ? "animate-spin" : ""}`}
						/>
						{running ? t("lint.running") : t("lint.runLint")}
					</Button>
				</div>
			</div>

			<div className="flex-1 overflow-y-auto">
				{!hasRun ? (
					<div className="flex flex-col items-center justify-center gap-2 p-8 text-center text-sm text-muted-foreground">
						<CheckCircle2 className="h-8 w-8 text-muted-foreground/30" />
						<p>{t("lint.runLintHint")}</p>
						<p className="text-xs">{t("lint.runLintDescription")}</p>
					</div>
				) : results.length === 0 ? (
					<div className="flex flex-col items-center justify-center gap-2 p-8 text-center text-sm text-muted-foreground">
						<CheckCircle2 className="h-8 w-8 text-emerald-500/60" />
						<p className="text-emerald-600 dark:text-emerald-400 font-medium">
							{t("lint.allClear")}
						</p>
						<p className="text-xs">{t("lint.noIssues")}</p>
					</div>
				) : (
					<div className="flex flex-col gap-2 p-3">
						{warnings.length > 0 && (
							<SectionHeader
								icon={AlertTriangle}
								label={t("lint.warnings")}
								count={warnings.length}
								color="text-amber-500"
								t={t}
							/>
						)}
						{warnings.map(({ result, index }) => (
							<LintCard
								key={`warn-${index}`}
								result={result}
								index={index}
								fixing={fixingId === `${result.type}-${index}`}
								fixingAll={fixingAll}
								hasLlm={hasUsableLlm(llmConfig)}
								onOpenPage={handleOpenPage}
								onFix={handleFix}
								onAutoFix={handleAutoFix}
								onDelete={
									result.type === "orphan" ? handleDeleteOrphan : undefined
								}
								typeConfig={typeConfig}
								t={t}
							/>
						))}
						{infos.length > 0 && (
							<SectionHeader
								icon={Info}
								label={t("lint.info")}
								count={infos.length}
								color="text-blue-500"
								t={t}
							/>
						)}
						{infos.map(({ result, index }) => (
							<LintCard
								key={`info-${index}`}
								result={result}
								index={index}
								fixing={fixingId === `${result.type}-${index}`}
								fixingAll={fixingAll}
								hasLlm={hasUsableLlm(llmConfig)}
								onOpenPage={handleOpenPage}
								onFix={handleFix}
								onAutoFix={handleAutoFix}
								onDelete={
									result.type === "orphan" ? handleDeleteOrphan : undefined
								}
								typeConfig={typeConfig}
								t={t}
							/>
						))}
					</div>
				)}
			</div>
		</div>
	);
}

function SectionHeader({
	icon: Icon,
	label,
	count,
	color,
	t,
}: {
	icon: typeof AlertTriangle;
	label: string;
	count: number;
	color: string;
	t: (key: string, opts?: Record<string, unknown>) => string;
}) {
	return (
		<div
			className={`flex items-center gap-1.5 px-1 py-1 text-xs font-semibold ${color}`}
		>
			<Icon className="h-3.5 w-3.5" />
			{t("lint.sectionCount", { label, count })}
		</div>
	);
}

function LintCard({
	result,
	index,
	fixing,
	fixingAll,
	hasLlm,
	onOpenPage,
	onFix,
	onAutoFix,
	onDelete,
	typeConfig,
	t,
}: {
	result: LintResult;
	index: number;
	fixing: boolean;
	fixingAll: boolean;
	hasLlm: boolean;
	onOpenPage: (page: string) => void;
	onFix: (result: LintResult, index: number) => void;
	onAutoFix: (result: LintResult, index: number) => void;
	onDelete?: (result: LintResult, index: number) => void;
	typeConfig: Record<string, { icon: typeof AlertTriangle; label: string }>;
	t: (key: string, opts?: Record<string, unknown>) => string;
}) {
	const config = typeConfig[result.type] ?? typeConfig.semantic;
	const Icon = config.icon;
	const canAutoFix = hasLlm && isFixable(result);

	return (
		<div className="rounded-lg border p-3 text-sm">
			<div className="mb-1.5 flex items-start gap-2">
				<Icon
					className={`mt-0.5 h-4 w-4 shrink-0 ${
						result.severity === "warning" ? "text-amber-500" : "text-blue-500"
					}`}
				/>
				<div className="flex-1 min-w-0">
					<div className="font-medium truncate">{result.page}</div>
					<div className="text-[11px] text-muted-foreground">
						{config.label}
					</div>
				</div>
			</div>

			<p className="mb-2 text-xs text-muted-foreground">{result.detail}</p>

			{result.affectedPages && result.affectedPages.length > 0 && (
				<div className="mb-2 flex flex-wrap gap-1">
					{result.affectedPages.map((page) => (
						<button
							key={page}
							type="button"
							onClick={() => onOpenPage(page)}
							className="inline-flex items-center gap-0.5 rounded bg-accent/60 px-1.5 py-0.5 text-xs font-medium text-primary hover:bg-accent transition-colors"
						>
							{page}
						</button>
					))}
				</div>
			)}

			<div className="flex items-center gap-1.5 mt-2">
				<Button
					variant="outline"
					size="sm"
					className="h-6 text-xs gap-1"
					onClick={() => onOpenPage(result.page)}
				>
					{t("lint.open")}
				</Button>
				{canAutoFix && (
					<Button
						variant="outline"
						size="sm"
						className="h-6 text-xs gap-1"
						disabled={fixing || fixingAll}
						onClick={() => onAutoFix(result, index)}
					>
						<Sparkles className="h-3 w-3" />
						{fixing ? t("lint.fixing") : t("lint.autoFix")}
					</Button>
				)}
				<Button
					variant="outline"
					size="sm"
					className="h-6 text-xs gap-1"
					disabled={fixing || fixingAll}
					onClick={() => onFix(result, index)}
				>
					<Wrench className="h-3 w-3" />
					{fixing ? t("lint.fixing") : t("lint.fix")}
				</Button>
				{onDelete && (
					<Button
						variant="outline"
						size="sm"
						className="h-6 text-xs gap-1 text-destructive hover:text-destructive"
						disabled={fixingAll}
						onClick={() => onDelete(result, index)}
					>
						<Trash2 className="h-3 w-3" />
						{t("lint.delete")}
					</Button>
				)}
			</div>
		</div>
	);
}

export const DEFAULT_API_BASE_URL = "http://127.0.0.1:19828";

export interface WikiApiClientOptions {
	baseUrl?: string;
	token?: string;
	projectId?: string;
	fetchFn?: typeof fetch;
}

export interface WikiApiListPagesOptions {
	root?: "wiki" | "sources" | "all";
	recursive?: boolean;
	maxFiles?: number;
}

export interface WikiApiSearchOptions {
	query: string;
	topK?: number;
	includeContent?: boolean;
}

export interface WikiApiGraphOptions {
	q?: string;
	limit?: number;
}

export class WikiApiError extends Error {
	constructor(
		message: string,
		readonly status?: number,
	) {
		super(message);
		this.name = "WikiApiError";
	}
}

function redactSecrets(value: string, token?: string): string {
	let out = value;
	if (token) out = out.split(token).join("[REDACTED]");
	return out.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, "Bearer [REDACTED]");
}

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
	if (!Number.isFinite(value)) return fallback;
	return Math.max(min, Math.min(max, Math.trunc(value as number)));
}

export class WikiApiClient {
	private readonly baseUrl: string;
	private readonly token?: string;
	private readonly projectId: string;
	private readonly fetchFn: typeof fetch;

	constructor(options: WikiApiClientOptions = {}) {
		this.baseUrl = (options.baseUrl ?? DEFAULT_API_BASE_URL).replace(/\/+$/, "");
		this.token = options.token?.trim() || undefined;
		this.projectId = options.projectId?.trim() || "current";
		this.fetchFn = options.fetchFn ?? fetch;
	}

	async listProjects(): Promise<unknown> {
		return this.request("GET", "/api/v1/projects");
	}

	async listPages(options: WikiApiListPagesOptions = {}): Promise<unknown> {
		const params = new URLSearchParams({
			root: options.root ?? "wiki",
			recursive: String(options.recursive ?? true),
			maxFiles: String(clampInt(options.maxFiles, 500, 1, 5000)),
		});
		return this.request("GET", `/api/v1/projects/${encodeURIComponent(this.projectId)}/files?${params.toString()}`);
	}

	async readPage(path: string): Promise<unknown> {
		const params = new URLSearchParams({ path });
		return this.request("GET", `/api/v1/projects/${encodeURIComponent(this.projectId)}/files/content?${params.toString()}`);
	}

	async searchPages(options: WikiApiSearchOptions): Promise<unknown> {
		const topK = clampInt(options.topK, 8, 1, 20);
		return this.request("POST", `/api/v1/projects/${encodeURIComponent(this.projectId)}/search`, {
			query: options.query,
			topK,
			includeContent: options.includeContent ?? true,
		});
	}

	async getGraph(options: WikiApiGraphOptions = {}): Promise<unknown> {
		const params = new URLSearchParams({
			limit: String(clampInt(options.limit, 200, 1, 1000)),
		});
		if (options.q?.trim()) params.set("q", options.q.trim());
		return this.request("GET", `/api/v1/projects/${encodeURIComponent(this.projectId)}/graph?${params.toString()}`);
	}

	private async request(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
		const headers: Record<string, string> = {};
		if (this.token) headers.Authorization = `Bearer ${this.token}`;
		if (body !== undefined) headers["Content-Type"] = "application/json";

		const url = `${this.baseUrl}${path}`;
		let response: Response;
		try {
			response = await this.fetchFn(url, {
				method,
				headers,
				body: body === undefined ? undefined : JSON.stringify(body),
			});
		} catch (err) {
			throw new WikiApiError(redactSecrets(String(err), this.token));
		}

		const text = await response.text();
		let parsed: unknown = text;
		if (text.trim()) {
			try {
				parsed = JSON.parse(text);
			} catch {
				parsed = text;
			}
		}

		if (!response.ok) {
			const message =
				typeof parsed === "object" && parsed !== null && "error" in parsed
					? String((parsed as { error?: unknown }).error)
					: text || `HTTP ${response.status}`;
			throw new WikiApiError(redactSecrets(message, this.token), response.status);
		}

		return parsed;
	}
}

export function createWikiApiClient(options: WikiApiClientOptions = {}): WikiApiClient {
	return new WikiApiClient(options);
}

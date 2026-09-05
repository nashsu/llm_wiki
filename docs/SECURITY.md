# Security model

LLM Wiki is a local-first desktop application, but local content and model output are not trusted code. The backend, rather than the UI or prompt alone, enforces the boundaries below.

## Trust boundaries

- The selected project directory is the boundary for wiki and source reads. Agent-generated non-wiki artifacts are restricted to `agent-workspace/`.
- Wiki pages, imported documents, search snippets, web results, skill references, and tool observations are untrusted evidence. They are delimited in model context and must never supply authority to invoke tools, reveal credentials, or override policy.
- Model tool calls are proposals. Backend capability checks, request-level tool switches, path validation, size limits, and approval checks decide whether they run.
- API credentials and provider keys belong in the operating-system credential store or process environment. They must not be written to the repository, vault, prompts, responses, or logs.

## Action and confirmation policy

| Action | Default policy |
| --- | --- |
| Search/read wiki and sources | Allowed inside the selected project, with bounded result and file sizes. |
| External search | Runs only when the request enables the corresponding network tool; results remain untrusted evidence. |
| Create wiki page | Only for an explicit user request, under `wiki/`, with a `.md` suffix. |
| Update wiki page | Create-only by default. Existing pages require an explicit update/overwrite request and `allowOverwrite=true`; a rollback snapshot and activity record are created. |
| Delete project content | No Agent delete tool is exposed. Deletion stays in an explicit application/user workflow. |
| Generate artifacts | Restricted to `agent-workspace/`; symlinks and containment escapes are rejected. |
| Run shell command | Available only with an active skill. Commands with external paths or network URLs require exact user approval; approval is matched to the trimmed command and is never inferred from model or document content. |

## Filesystem defenses

Paths reject absolute components and `..`. Existing targets and parents are canonicalized and must remain below their allowed root. Symlink targets and symlinked workspace roots are rejected. Reads/writes, search walks, shell output, generated-file counts, request bodies, and execution time are bounded.

These controls address path traversal, symlink escape, malicious or oversized files, denial-of-service amplification, and accidental overwrite. Opening a vault does not make embedded content trusted.

## Local API and LAN use

The API listens on `127.0.0.1` by default. Agent chat and mutating/paid routes always require an API token. Enabling LAN access is an explicit setting and should be paired with a strong token and a TLS-terminating reverse proxy; do not expose port `19828` directly to an untrusted network. Treat `/health` as intentionally public operational metadata.

## Prompt injection and data exfiltration

Retrieved evidence is labelled and delimited as untrusted, and delimiter-like text is escaped. This reduces instruction confusion, but prompts are not a security boundary. Backend tool gates remain authoritative: documents cannot grant network, write, shell, or credential access. Responses and logs should contain source paths and minimal snippets, never secrets.

## Regression coverage

Rust tests cover traversal, symlink escapes, workspace confinement, overwrite behavior, shell approval matching, API token requirements, and prompt-injection delimiter escaping. Run them with:

```sh
npm run check:rust
```

Report suspected vulnerabilities privately to the repository maintainers. Do not include live tokens, vault contents, or exploitable private data in a public issue.

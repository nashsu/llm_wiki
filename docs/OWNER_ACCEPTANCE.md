# Owner Acceptance Checks

## Purpose

This file is the **traceable record of owner acceptance checks** for this project.
Whenever the owner runs a live acceptance session against the app (manual testing
of real flows — upload, chat, search, settings, deployment behavior), the
session is written up here as a report so that what was tested, what broke, and
what fixed it stays auditable after the chat thread is gone.

It is append-only and chronological: newest reports are appended at the bottom
of the [Reports](#reports-chronological) section. Past reports are never edited;
corrections are added as a short note under the original report.

## Suggested report outline

Each report should follow this shape (adapt section names if needed, keep the
information):

```markdown
### YYYY-MM-DD — <phase or session title>

**Context (what was tested):**
- commit / version under test (link), worktree or deployment it ran from,
  URL/port, auth mode, data dir, provider configuration (no secrets),
  anything unusual about the environment.

**Scenarios tested:**
1. <scenario> — what was exercised, expected vs observed, verdict (PASS/FAIL/PARTIAL).
2. …

**Problems found:**
- <problem> — severity, how it was observed. (Omit or write "none" if clean.)

**Corresponding issues / PRs:**
- issue: <link> · PR: <link> (for every problem that produced one)

**Commits:**
- tested: <sha> · fixes: <sha(s)> (linked)
```

## Rules for writing reports

1. **Link to the issue, PR, or commit whenever one exists.** A problem, fix, or
   tested change is referenced by its GitHub issue/PR number or commit SHA —
   never paraphrased without a link. If none exists yet, say so explicitly
   (that itself is a signal to file one).
2. **Always state the context the test ran against**: commit under test, how
   the app was deployed/booted, and relevant configuration (auth mode,
   retrieval mode, provider shape). A report without context cannot be
   re-run or trusted later.
3. **Scenarios are concrete**: name the flow (e.g. "1.1 MB PDF upload →
   ingest → wiki pages"), the expected behavior, and the observed result.
   "It worked" is not a scenario; "upload → queue → complete in 4m56s,
   pages on disk, vec index populated" is.
4. **Problems get follow-up references**: if a finding produced an issue or
   fix, the report carries the link both ways (the issue should also mention
   the session).
5. **Append-only history**: do not rewrite earlier reports; add dated
   correction notes.
6. **Clean results are recorded too** — a session that found nothing is
   evidence, not noise.

## Reports (chronological)

### 2026-08-05 — Phase-1 acceptance (production-completeness, issue #14 closeout)

**Context (what was tested):**
- Tested commit: [`a42d103`](https://github.com/vinvcn/llm_wiki/commit/a42d103) (= `origin/main`, merge of PR #31), served from the `doc-pass` worktree via `node packages/server/src/index-v2.js` at `http://127.0.0.1:19828`.
- Auth mode `open` (no token configured); data dir `~/.llm-wiki-server` with pre-existing owner data (migrations 010–013 applied).
- LLM: custom OpenAI-compatible endpoint (NVIDIA integrate), `apiMode=chat_completions`; embedding endpoint configured (dim 2048); retrieval mode `hybrid` (`wikiSearchMode` in `app-state.json`).
- Scope: live verification of the merged #14 gap closures — PRs [#22](https://github.com/vinvcn/llm_wiki/pull/22), [#23](https://github.com/vinvcn/llm_wiki/pull/23), [#25](https://github.com/vinvcn/llm_wiki/pull/25), [#27](https://github.com/vinvcn/llm_wiki/pull/27), [#28](https://github.com/vinvcn/llm_wiki/pull/28), [#29](https://github.com/vinvcn/llm_wiki/pull/29), [#30](https://github.com/vinvcn/llm_wiki/pull/30), [#31](https://github.com/vinvcn/llm_wiki/pull/31).

**Scenarios tested:**
1. Retrieval-mode configuration — located Settings → Embeddings → "Retrieval mode" (keyword/vector/hybrid); value persisted as `wikiSearchMode` and honored by the server search API. PASS.
2. Chat Q&A trace — question "hi, what is 声音选择": verified request validated by `ChatRequestSchema` (#23), session + user message persisted before streaming and answer + references persisted after (#25), token streaming via `agent-event`/`chat:delta` with terminal `chat:done` (#29), unauthenticated access under open auth (#22). Answer grounded in 5 wiki pages (references persisted). PASS.
3. PDF upload → ingest end-to-end — "Harness engineering for coding agent users.pdf" (1.1 MB): multipart path (<10 MB), file complete in `raw/sources/`, queue row `pending→processing→completed` (task id 3, attempt 1, 4 min 56 s), pipeline stages 5→100%, wiki concept/entity pages + `index.md`/`log.md` written with clean frontmatter, sqlite-vec index populated (dim 2048) so hybrid's vector leg has data. PASS.

**Problems found:**
- Ingest progress is indistinguishable from a stuck run during long LLM calls: `ingest_queue.progress`/`updated_at` only update at stage boundaries, so a healthy generation leg reads as a flatlined row. Medium severity (observability; triggered a live incident investigation).
- Environmental, not a code defect: a root-owned Docker container (`phase3-integration-llm-wiki-1`, `RestartPolicy: unless-stopped`) runs a second, isolated server on port 3000; its presence initially suggested a queue-stealing zombie. Resolved operationally (container left running; isolated data volume). No code change.
- Note: at test start the project's vector index was empty, so `hybrid` correctly degraded to the keyword leg via the #27 health probe; scenario 3 later populated it.

**Corresponding issues / PRs:**
- issue: [#32](https://github.com/vinvcn/llm_wiki/issues/32) (ingest heartbeat gap).
- Verified features: PRs #22, #23, #25, #27, #28, #29, #30, #31 (all merged; per-PR validation summaries on the PRs).

**Commits:**
- tested: [`a42d103`](https://github.com/vinvcn/llm_wiki/commit/a42d103) · fixes: none in this session (issue #32 open).

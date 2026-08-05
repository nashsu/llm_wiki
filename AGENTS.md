# Agent Guide

Instructions for agents working in this repository.

## Owner acceptance records

The owner performs live acceptance checks of the app (manual testing of real
flows). **Every acceptance-check session must be recorded in
[`docs/OWNER_ACCEPTANCE.md`](docs/OWNER_ACCEPTANCE.md)** — append a report at
the bottom of its chronological Reports section, following the outline and
writing rules defined at the top of that file:

- state the context the test ran against (commit, deployment, configuration),
- list concrete scenarios tested with verdicts,
- record problems found, linking the corresponding issue/PR/commit when one
  exists (and filing one when it doesn't),
- never rewrite past reports; add dated correction notes.

Acceptance findings must not live only in chat threads or PR comments — the
doc is the durable, traceable record.

## Repository facts (short version)

- npm-workspaces monorepo; server = plain-JS ESM (`packages/server`, entry
  `packages/server/src/index-v2.js`), client = React/TS (`src/`),
  `packages/api-types` = Zod API-contract SSOT (rebuild its dist after edits:
  `npm run build -w @llm-wiki/api-types`).
- Gates from the repo root: `npm test -w @llm-wiki/server`,
  `npm run typecheck`, `npm run test:mocks`, `npm run build:web`. CI runs
  typecheck + server tests.
- Docs live in `docs/` (see `docs/PUSH1_ACTUAL_ARCHITECTURE.md` for the actual
  architecture and accepted deviations, `docs/API_REFERENCE.md`,
  `docs/DEPLOYMENT.md`); design plans in `plans/`.

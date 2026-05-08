export interface WikiTemplate {
  id: string
  name: string
  description: string
  icon: string
  schema: string
  purpose: string
  extraDirs: string[]
  extraFiles?: Record<string, string>
}

const BASE_SCHEMA_TYPES = `| entity | wiki/entities/ | Named things (people, tools, organizations, datasets) |
| concept | wiki/concepts/ | Ideas, techniques, phenomena, frameworks |
| source | wiki/sources/ | Papers, articles, talks, books, blog posts |
| query | wiki/queries/ | Open questions under active investigation |
| comparison | wiki/comparisons/ | Side-by-side analysis of related entities |
| synthesis | wiki/synthesis/ | Cross-cutting summaries and conclusions |
| overview | wiki/ | High-level project summary (one per project) |
| profile | wiki/profile/ | Durable user preferences, operating model, and personal context |
| decision | wiki/decisions/ | Confirmed choices and rationale that should guide future work |
| workflow | wiki/workflows/ | Repeatable procedures, checklists, and working agreements |
| session | wiki/sessions/ | Recent work summaries and handoff context |`

const BASE_NAMING = `- Files: \`kebab-case.md\`
- Entities: match official name where possible (e.g., \`openai.md\`, \`gpt-4.md\`)
- Concepts: descriptive noun phrases (e.g., \`chain-of-thought.md\`)
- Sources: \`author-year-slug.md\` (e.g., \`wei-2022-cot.md\`)
- Queries: question as slug (e.g., \`does-scale-improve-reasoning.md\`)`

const BASE_FRONTMATTER = `All pages must include YAML frontmatter:

\`\`\`yaml
---
type: entity | concept | source | query | comparison | synthesis | overview | profile | decision | workflow | session
title: Human-readable title
tags: []
related: []
created: YYYY-MM-DD
updated: YYYY-MM-DD
sources: []
confidence: low | medium | high
last_reviewed: YYYY-MM-DD
memory_status: active | candidate | superseded
---
\`\`\`

Source pages also include:
\`\`\`yaml
authors: []
year: YYYY
url: ""
venue: ""
\`\`\``

const BASE_INDEX_FORMAT = `\`wiki/index.md\` lists all pages grouped by type. Each entry:
\`\`\`
- [[page-slug]] — one-line description
\`\`\``

const BASE_LOG_FORMAT = `\`wiki/log.md\` records activity in reverse chronological order:
\`\`\`
## YYYY-MM-DD

- Action taken / finding noted
\`\`\``

const BASE_CROSSREF = `- Use \`[[page-slug]]\` syntax to link between wiki pages
- Every entity and concept should appear in \`wiki/index.md\`
- Queries link to the sources and concepts they draw on
- Synthesis pages cite all contributing sources via \`related:\``

const BASE_CONTRADICTION = `When sources contradict each other:
1. Note the contradiction in the relevant concept or entity page
2. Create or update a query page to track the open question
3. Link both sources from the query page
4. Resolve in a synthesis page once sufficient evidence exists`

const CODEXIAN_MEMORY_FRONTMATTER = `Codexian Memory pages use these additional meanings:

- \`profile\`: durable facts about Kevin's goals, preferences, judgment criteria, and response style. Profile updates should be reviewed before becoming active.
- \`decision\`: explicit decisions Kevin made, including date, rationale, and reversal conditions.
- \`workflow\`: repeated procedures Codex should follow in future sessions.
- \`session\`: recent work context, open loops, and short-lived continuity notes.
- \`synthesis\`: compiled memory such as \`wiki/synthesis/codex-boot-context.md\`.

Memory frontmatter:
\`\`\`yaml
sources: []
confidence: low | medium | high
last_reviewed: YYYY-MM-DD
memory_status: active | candidate | superseded
\`\`\``

const researchTemplate: WikiTemplate = {
  id: "research",
  name: "Research",
  description: "Deep-dive research with hypothesis tracking and methodology notes",
  icon: "🔬",
  extraDirs: ["wiki/methodology", "wiki/findings", "wiki/thesis"],
  schema: `# Wiki Schema — Research Deep-Dive

## Page Types

| Type | Directory | Purpose |
|------|-----------|---------|
${BASE_SCHEMA_TYPES}
| thesis | wiki/thesis/ | Working hypothesis and its evolution over time |
| methodology | wiki/methodology/ | Research methods, protocols, and study designs |
| finding | wiki/findings/ | Individual empirical results or observations |

## Naming Conventions

${BASE_NAMING}
- Theses: hypothesis as slug (e.g., \`scaling-improves-reasoning.md\`)
- Methodologies: method name (e.g., \`systematic-review.md\`, \`ablation-study.md\`)
- Findings: descriptive slug (e.g., \`larger-models-better-few-shot.md\`)

## Frontmatter

${BASE_FRONTMATTER}

Thesis pages also include:
\`\`\`yaml
confidence: low | medium | high
status: speculative | supported | refuted | settled
\`\`\`

Finding pages also include:
\`\`\`yaml
source: "[[source-slug]]"
confidence: low | medium | high
replicated: true | false | null
\`\`\`

## Index Format

${BASE_INDEX_FORMAT}

## Log Format

${BASE_LOG_FORMAT}

## Cross-referencing Rules

${BASE_CROSSREF}
- Findings link back to their source via the \`source:\` frontmatter field
- Thesis pages reference supporting and refuting findings via \`related:\`
- Methodology pages are cited by the findings that used them

## Contradiction Handling

${BASE_CONTRADICTION}

## Research-Specific Conventions

- Keep the thesis pages updated as evidence accumulates — they are living documents
- Every finding should assess replication status when known
- Methodology pages explain the *why* (rationale) not just the *how*
- Distinguish between direct evidence and inference in finding pages
`,
  purpose: `# Project Purpose — Research Deep-Dive

## Research Question

<!-- State the central question this research aims to answer. Be specific and falsifiable. -->

>

## Hypothesis / Working Thesis

<!-- Your current best guess. This will evolve — update it as evidence accumulates. -->

>

## Background

<!-- What prior work or context motivates this research? What gap does it fill? -->

## Sub-questions

<!-- Break down the main question into tractable sub-questions. -->

1.
2.
3.
4.

## Scope

**In scope:**
-

**Out of scope:**
-

## Methodology

<!-- How will you investigate this? What types of sources or experiments are relevant? -->

-

## Success Criteria

<!-- How will you know when you have a satisfying answer? -->

-

## Current Status

> Not started — update this section as research progresses.
`,
}

const readingTemplate: WikiTemplate = {
  id: "reading",
  name: "Reading",
  description: "Track a book's characters, themes, plot threads, and chapter notes",
  icon: "📚",
  extraDirs: ["wiki/characters", "wiki/themes", "wiki/plot-threads", "wiki/chapters"],
  schema: `# Wiki Schema — Reading a Book

## Page Types

| Type | Directory | Purpose |
|------|-----------|---------|
${BASE_SCHEMA_TYPES}
| character | wiki/characters/ | People and figures in the book |
| theme | wiki/themes/ | Recurring ideas, motifs, and symbolic threads |
| plot-thread | wiki/plot-threads/ | Storylines or narrative arcs being tracked |
| chapter | wiki/chapters/ | Per-chapter notes and summaries |

## Naming Conventions

${BASE_NAMING}
- Characters: character name in kebab-case (e.g., \`elizabeth-bennet.md\`)
- Themes: thematic noun phrase (e.g., \`social-class-mobility.md\`, \`deception-vs-honesty.md\`)
- Plot threads: arc description (e.g., \`darcys-redemption-arc.md\`)
- Chapters: \`ch-NN-slug.md\` (e.g., \`ch-01-opening-scene.md\`)

## Frontmatter

${BASE_FRONTMATTER}

Character pages also include:
\`\`\`yaml
first_appearance: "Ch. N"
role: protagonist | antagonist | supporting | minor
\`\`\`

Chapter pages also include:
\`\`\`yaml
chapter: N
pages: "1-24"
\`\`\`

## Index Format

${BASE_INDEX_FORMAT}

## Log Format

${BASE_LOG_FORMAT}

## Cross-referencing Rules

${BASE_CROSSREF}
- Chapter notes reference characters appearing in that chapter via \`related:\`
- Theme pages link to the chapters where the theme is most prominent
- Plot thread pages list chapters that advance the arc

## Contradiction Handling

${BASE_CONTRADICTION}

## Reading-Specific Conventions

- Chapter pages are written during or immediately after reading — capture fresh reactions
- Distinguish between plot summary and personal interpretation in chapter notes
- Theme pages should track *development* across the book, not just state that a theme exists
- Flag unresolved plot threads with status: \`open\` until resolved
- Note page numbers for important quotes to enable re-finding later
`,
  purpose: `# Project Purpose — Reading

## Book Details

**Title:**
**Author:**
**Year:**
**Genre:**

## Why I'm Reading This

<!-- What drew you to this book? What do you hope to get from it? -->

## Key Themes to Track

<!-- What thematic threads do you expect or want to follow? -->

1.
2.
3.

## Questions Going In

<!-- What do you want answered or explored by the end? -->

1.
2.

## Reading Pace

**Started:**
**Target finish:**
**Current chapter:**

## First Impressions

<!-- Update after first chapter or first sitting. -->

>

## Final Takeaways

<!-- Fill in when finished. What did this book teach you? -->

>
`,
}

const personalTemplate: WikiTemplate = {
  id: "personal",
  name: "Personal Growth",
  description: "Track goals, habits, reflections, and journal entries for self-improvement",
  icon: "🌱",
  extraDirs: ["wiki/goals", "wiki/habits", "wiki/reflections", "wiki/journal"],
  schema: `# Wiki Schema — Personal Growth

## Page Types

| Type | Directory | Purpose |
|------|-----------|---------|
${BASE_SCHEMA_TYPES}
| goal | wiki/goals/ | Specific outcomes you are working toward |
| habit | wiki/habits/ | Recurring behaviours and their tracking |
| reflection | wiki/reflections/ | Periodic reviews and lessons learned |
| journal | wiki/journal/ | Freeform daily or session entries |

## Naming Conventions

${BASE_NAMING}
- Goals: outcome as slug (e.g., \`run-a-marathon.md\`, \`learn-spanish.md\`)
- Habits: behaviour name (e.g., \`daily-meditation.md\`, \`morning-pages.md\`)
- Reflections: type + date (e.g., \`weekly-2024-03.md\`, \`quarterly-2024-q1.md\`)
- Journal: date slug (e.g., \`2024-03-15.md\`)

## Frontmatter

${BASE_FRONTMATTER}

Goal pages also include:
\`\`\`yaml
target_date: YYYY-MM-DD
status: active | paused | achieved | abandoned
progress: 0-100
\`\`\`

Habit pages also include:
\`\`\`yaml
frequency: daily | weekly | monthly
streak: N
status: active | paused | dropped
\`\`\`

Reflection pages also include:
\`\`\`yaml
period: weekly | monthly | quarterly | annual
\`\`\`

## Index Format

${BASE_INDEX_FORMAT}

## Log Format

${BASE_LOG_FORMAT}

## Cross-referencing Rules

${BASE_CROSSREF}
- Reflection pages reference the goals and habits reviewed during that period
- Goals link to the habits that support them via \`related:\`
- Journal entries can reference goals and reflections inline with \`[[slug]]\`

## Contradiction Handling

${BASE_CONTRADICTION}

## Personal Growth Conventions

- Be honest in journal and reflection entries — this wiki is for you, not an audience
- Update goal progress fields regularly; stale data is worse than no data
- Distinguish between outcome goals (what you want) and process goals (what you will do)
- Reflect on *why* habits succeed or fail, not just whether they did
- Use the synthesis directory for cross-cutting insights that span multiple goals or periods
`,
  purpose: `# Project Purpose — Personal Growth

## Focus Areas

<!-- What areas of your life or self are you actively working on? -->

1.
2.
3.

## Motivation

<!-- Why now? What prompted you to start this wiki? -->

## Current Goals (Summary)

<!-- High-level list — create detailed goal pages in wiki/goals/ -->

- [ ]
- [ ]
- [ ]

## Active Habits

<!-- High-level list — create detailed habit pages in wiki/habits/ -->

-
-

## Review Cadence

**Daily journal:** Yes / No
**Weekly reflection:**
**Monthly reflection:**
**Quarterly reflection:**

## Guiding Principles

<!-- What values or principles guide your growth work? -->

1.
2.
3.

## This Year's Theme

<!-- One phrase or sentence that captures your intention for the year. -->

>
`,
}

const businessTemplate: WikiTemplate = {
  id: "business",
  name: "Business",
  description: "Manage meetings, decisions, projects, and stakeholder context for a team",
  icon: "💼",
  extraDirs: ["wiki/meetings", "wiki/decisions", "wiki/projects", "wiki/stakeholders"],
  schema: `# Wiki Schema — Business / Team

## Page Types

| Type | Directory | Purpose |
|------|-----------|---------|
${BASE_SCHEMA_TYPES}
| meeting | wiki/meetings/ | Meeting notes, agendas, and action items |
| decision | wiki/decisions/ | Architectural or strategic decisions (ADR-style) |
| project | wiki/projects/ | Project briefs, status, and retrospectives |
| stakeholder | wiki/stakeholders/ | People, teams, and organisations involved |

## Naming Conventions

${BASE_NAMING}
- Meetings: \`YYYY-MM-DD-slug.md\` (e.g., \`2024-03-15-sprint-planning.md\`)
- Decisions: \`NNN-slug.md\` (e.g., \`001-adopt-typescript.md\`)
- Projects: descriptive slug (e.g., \`payments-redesign.md\`)
- Stakeholders: name or team in kebab-case (e.g., \`alice-chen.md\`, \`platform-team.md\`)

## Frontmatter

${BASE_FRONTMATTER}

Meeting pages also include:
\`\`\`yaml
date: YYYY-MM-DD
attendees: []
action_items: []
\`\`\`

Decision pages also include:
\`\`\`yaml
status: proposed | accepted | deprecated | superseded
deciders: []
date: YYYY-MM-DD
supersedes: ""   # slug of ADR this replaces, if any
\`\`\`

Project pages also include:
\`\`\`yaml
status: planned | active | on-hold | complete | cancelled
owner: ""
start_date: YYYY-MM-DD
target_date: YYYY-MM-DD
\`\`\`

## Index Format

${BASE_INDEX_FORMAT}

## Log Format

${BASE_LOG_FORMAT}

## Cross-referencing Rules

${BASE_CROSSREF}
- Meeting notes reference attendees via \`attendees:\` frontmatter and \`[[stakeholder-slug]]\` links
- Decision pages link to the meetings where the decision was discussed
- Project pages link to their key decisions via \`related:\`
- Stakeholder pages list projects and decisions they are involved in

## Contradiction Handling

${BASE_CONTRADICTION}

## Business-Specific Conventions

- Write meeting notes during or within 24 hours — memory fades fast
- Action items must have a named owner and due date to be actionable
- Decision pages capture *context and consequences*, not just the decision itself
- Deprecated decisions should link to the decision that superseded them
- Projects should have a retrospective section added on completion
`,
  purpose: `# Project Purpose — Business / Team

## Business Context

**Organisation / Team:**
**Domain:**
**Time period covered:**

## Objectives

<!-- What are the top-level business objectives this wiki supports? -->

1.
2.
3.

## Key Projects

<!-- High-level list — create detailed pages in wiki/projects/ -->

-
-

## Key Stakeholders

<!-- Who are the primary people or teams involved? -->

-
-

## Open Decisions

<!-- Decisions currently in flight — create ADR pages in wiki/decisions/ -->

-
-

## Metrics / Success Criteria

<!-- How does the team measure progress toward its objectives? -->

-

## Constraints and Risks

<!-- Known constraints (budget, time, org) and risks to track -->

-

## Review Cadence

**Weekly sync notes:**
**Monthly status update:**
**Quarterly retrospective:**
`,
}

const generalTemplate: WikiTemplate = {
  id: "general",
  name: "General",
  description: "Minimal setup — a blank slate for any purpose",
  icon: "📄",
  extraDirs: [],
  schema: `# Wiki Schema

## Page Types

| Type | Directory | Purpose |
|------|-----------|---------|
${BASE_SCHEMA_TYPES}

## Naming Conventions

${BASE_NAMING}

## Frontmatter

${BASE_FRONTMATTER}

## Index Format

${BASE_INDEX_FORMAT}

## Log Format

${BASE_LOG_FORMAT}

## Cross-referencing Rules

${BASE_CROSSREF}

## Contradiction Handling

${BASE_CONTRADICTION}
`,
  purpose: `# Project Purpose

## Goal

<!-- What are you trying to understand or build? -->

## Key Questions

<!-- List the primary questions driving this project -->

1.
2.
3.

## Scope

**In scope:**
-

**Out of scope:**
-

## Thesis

<!-- Your current working hypothesis or conclusion (update as the project progresses) -->

> TBD
`,
}

const codexianMemoryTemplate: WikiTemplate = {
  id: "codexian-memory",
  name: "Codexian Memory",
  description: "A personal memory wiki that helps Codex keep Kevin's context, preferences, decisions, and recent work active",
  icon: "🧠",
  extraDirs: [
    "wiki/profile",
    "wiki/decisions",
    "wiki/workflows",
    "wiki/sessions",
  ],
  schema: `# Wiki Schema — Codexian Memory

## Page Types

| Type | Directory | Purpose |
|------|-----------|---------|
${BASE_SCHEMA_TYPES}

## Naming Conventions

${BASE_NAMING}
- Profile: durable topic name (e.g., \`user-operating-model.md\`)
- Decisions: date and decision slug (e.g., \`2026-05-08-memory-context-policy.md\`)
- Workflows: procedure name (e.g., \`codex-session-boot.md\`)
- Sessions: date and concise session slug (e.g., \`2026-05-08-llm-wiki-codexian.md\`)
- Boot context: always use \`wiki/synthesis/codex-boot-context.md\`

## Frontmatter

${BASE_FRONTMATTER}

${CODEXIAN_MEMORY_FRONTMATTER}

## Memory Priority

When answering as Codex, apply memory in this order:

1. The user's current request and active runtime instructions
2. Active profile, decision, and workflow pages
3. Recent session pages
4. General wiki retrieval results

Profile pages are durable and should change slowly. If a new source suggests changing Kevin's identity, preferences, or operating model, create a review item instead of silently overwriting active profile memory.

## Index Format

${BASE_INDEX_FORMAT}

Recommended sections:

- Profile
- Decisions
- Workflows
- Sessions
- Synthesis
- Sources
- Queries

## Log Format

${BASE_LOG_FORMAT}

## Cross-referencing Rules

${BASE_CROSSREF}
- Profile pages link to the decisions, workflows, and sessions that justify them
- Session pages link to decisions and workflows that changed during the session
- \`codex-boot-context.md\` summarizes only active memory and links back to source pages

## Contradiction Handling

${BASE_CONTRADICTION}
`,
  purpose: `# Project Purpose — Codexian Memory

## Goal

Codex가 Kevin의 목표, 선호, 판단 기준, 최근 작업 맥락을 유지하도록 돕는 개인 기억 Wiki입니다.

## Key Questions

1. Kevin이 반복해서 설명하지 않아도 Codex가 알아야 하는 운영 방식은 무엇인가?
2. 최근 세션과 확정 결정 중 다음 작업에 영향을 주는 맥락은 무엇인가?
3. 어떤 기억은 장기 profile로 승격하고, 어떤 기억은 session으로만 보존해야 하는가?

## Scope

**In scope:**
- Kevin의 작업 선호, 응답 선호, 판단 기준, 반복 workflow
- Codex 세션 로그와 handoff에서 추출한 최근 작업 맥락
- 확정된 의사결정과 되돌릴 조건
- Codex가 시작 시 읽을 \`wiki/synthesis/codex-boot-context.md\`

**Out of scope:**
- 출처가 불명확한 추측
- 민감하거나 정체성에 가까운 profile 자동 확정
- 원본 raw source를 지우거나 요약본으로 대체하는 일

## Thesis

> Raw source는 보존하고, Wiki는 Codex가 바로 사용할 수 있는 기억으로 컴파일하며, profile 변경은 사람 검토를 거친다.
`,
  extraFiles: {
    "wiki/index.md": `# Wiki Index

## Profile

- [[profile/user-operating-model|Kevin Operating Model]]

## Decisions

## Workflows

- [[workflows/codex-session-boot|Codex Session Boot]]

## Sessions

## Synthesis

- [[synthesis/codex-boot-context|Codex Boot Context]]

## Entities

## Concepts

## Sources

## Queries

## Comparisons
`,
    "wiki/profile/user-operating-model.md": `---
type: profile
title: Kevin Operating Model
tags: [codexian-memory, profile]
related: [codex-boot-context]
created: 2026-05-08
updated: 2026-05-08
sources: []
confidence: medium
last_reviewed: 2026-05-08
memory_status: candidate
---

# Kevin Operating Model

Use this page for durable, reviewed preferences and working agreements about Kevin.

## Active Memory

- Add stable preferences only after review.
`,
    "wiki/workflows/codex-session-boot.md": `---
type: workflow
title: Codex Session Boot
tags: [codexian-memory, workflow]
related: [codex-boot-context, user-operating-model]
created: 2026-05-08
updated: 2026-05-08
sources: []
confidence: medium
last_reviewed: 2026-05-08
memory_status: active
---

# Codex Session Boot

## Steps

1. Read \`purpose.md\`.
2. Read \`wiki/synthesis/codex-boot-context.md\`.
3. Check recent session pages when continuity matters.
4. Prefer active decisions and workflows over older session notes.
`,
    "wiki/synthesis/codex-boot-context.md": `---
type: synthesis
title: Codex Boot Context
tags: [codexian-memory, boot-context]
related: [user-operating-model, codex-session-boot]
created: 2026-05-08
updated: 2026-05-08
sources: []
confidence: medium
last_reviewed: 2026-05-08
memory_status: active
---

# Codex Boot Context

This page is the compact memory summary Codex should read at the start of work.

## Stable Profile

- Pending reviewed profile memory.

## Active Decisions

- Pending decisions.

## Active Workflows

- Use [[codex-session-boot]] as the default session start workflow.

## Recent Session Context

- Add recent work summaries under \`wiki/sessions/\`.
`,
  },
}

export const templates: WikiTemplate[] = [
  codexianMemoryTemplate,
  researchTemplate,
  readingTemplate,
  personalTemplate,
  businessTemplate,
  generalTemplate,
]

export function getTemplate(id: string): WikiTemplate {
  const found = templates.find((t) => t.id === id)
  if (!found) {
    throw new Error(`Unknown template id: "${id}"`)
  }
  return found
}

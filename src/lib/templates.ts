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

const BASE_SCHEMA_TYPES = `| entity | wiki/entities/ | 사람, 도구, 조직, 데이터셋처럼 이름이 있는 대상 |
| concept | wiki/concepts/ | 아이디어, 기법, 현상, 프레임워크 |
| source | wiki/sources/ | 논문, 글, 발표, 책, 블로그 글 같은 원본 자료 |
| query | wiki/queries/ | 계속 조사 중인 열린 질문 |
| comparison | wiki/comparisons/ | 관련 대상의 나란한 비교 분석 |
| synthesis | wiki/synthesis/ | 여러 자료를 가로지르는 종합과 결론 |
| overview | wiki/ | 프로젝트 전체 고수준 요약(프로젝트당 하나) |`

const BASE_LANGUAGE_POLICY = `## 작성 언어 원칙

- \`schema.md\`와 \`purpose.md\`는 기본적으로 한국어로 작성하고 유지한다.
- \`wiki/index.md\`, \`wiki/log.md\`, \`wiki/overview.md\` 등 주요 구조 문서도 한국어 작성을 기본 원칙으로 한다.
- 엔티티명, 고유명사, 제품명, 논문명, 파일 slug는 필요하면 원어를 유지하되 설명과 본문은 한국어로 쓴다.
- 외국어 원문을 인용할 때도 요약, 해석, 판단, 정리 문장은 한국어로 작성한다.
- 사용자가 명시적으로 다른 출력 언어를 요청한 경우에만 그 요청을 우선한다.`

const BASE_PURPOSE_LANGUAGE_POLICY = `## 작성 언어 원칙

- 이 프로젝트의 \`schema.md\`와 \`purpose.md\`는 한국어로 관리한다.
- \`wiki/index.md\`, \`wiki/log.md\`, \`wiki/overview.md\` 등 주요 문서는 한국어 작성을 기본 원칙으로 한다.
- 고유명사와 원문 제목은 필요하면 원어를 유지하되, 설명과 판단은 한국어로 정리한다.`

const BASE_NAMING = `- 파일명: 사람이 읽기 쉬운 자연어 제목을 그대로 반영한다(예: \`에이전트 오케스트레이션.md\`).
- 단어 구분을 위해 하이픈을 넣지 않는다. 하이픈은 공식 명칭, 표준 날짜, 원제에 꼭 필요한 경우에만 유지한다.
- Unicode 한글과 공백을 허용한다. Obsidian 탐색에 한글이 더 명확하면 영어로 억지 변환하지 않는다.
- \`wiki/entities/\`: 가능하면 공식 명칭이나 원어 명칭을 제목과 파일명에 반영한다(예: \`openai.md\`, \`gpt-4.md\`).
- \`wiki/entities/\` 이외의 wiki 폴더: frontmatter \`title\`과 H1은 한글 우선으로 쓴다. 고유명사, 제품명, 법령명, 약어는 필요한 경우 원어를 유지한다.
- 개념: 설명적인 한글 명사구를 우선한다(예: \`에이전트 오케스트레이션.md\`).
- 원본 요약: 원본의 핵심 주제를 한글 제목으로 정리하고 필요하면 \`소스 요약\`을 붙인다(예: \`대한민국 판례 저장소 소스 요약.md\`).
- 질의: 질문의 핵심 주제를 한글 제목으로 정리하고 필요하면 \`질의 기록\`을 붙인다(예: \`그래프 DB 도입 기준 질의 기록.md\`).
- \`raw/sources/\`, \`raw/assets/\`: import 시 원문 내용은 바꾸지 않되, 파일명은 title 기반 자연어 제목으로 정리한다.
- Review/Chat 등 App UI에서 사용자가 직접 저장하거나 생성하는 문서도 같은 제목 규칙을 적용한다.`

const BASE_FRONTMATTER = `모든 페이지는 YAML frontmatter를 포함한다:

\`\`\`yaml
---
type: entity | concept | source | query | comparison | synthesis | overview
title: 사람이 읽기 쉬운 제목
tags: []
related: []
created: YYYY-MM-DD
updated: YYYY-MM-DD
sources: []
confidence: low | medium | high
last_reviewed: YYYY-MM-DD
---
\`\`\`

source 페이지는 추가로 다음 필드를 포함한다:
\`\`\`yaml
authors: []
year: YYYY
url: ""
venue: ""
\`\`\`

기존 Vault의 \`type: decision\` 또는 \`wiki/decisions/\` 페이지는 legacy 문서로 읽을 수 있다.
새로운 판단 기록은 기본적으로 query, project, 또는 synthesis 페이지에 남긴다.`

const BASE_INDEX_FORMAT = `\`wiki/index.md\`는 모든 페이지를 유형별로 묶어 나열한다. 각 항목은 다음 형식을 따른다:
\`\`\`
- [[page-slug]] — 한 줄 설명
\`\`\``

const BASE_LOG_FORMAT = `\`wiki/log.md\`는 작업 이력을 최신순으로 기록한다:
\`\`\`
## YYYY-MM-DD

- 수행한 작업 / 확인한 발견
\`\`\``

const BASE_CROSSREF = `- Wiki 페이지끼리는 \`[[page-slug]]\` 문법으로 연결한다.
- 모든 entity와 concept은 \`wiki/index.md\`에 나타나야 한다.
- query 페이지는 근거로 삼은 source와 concept을 연결한다.
- comparison 페이지는 비교 대상과 근거 source를 \`related:\`로 인용한다.
- synthesis 페이지는 기여한 모든 source를 \`related:\`로 인용한다.`

const BASE_CONTRADICTION = `원본 자료끼리 충돌할 때:
1. 관련 concept 또는 entity 페이지에 모순을 명시한다.
2. 열린 질문을 추적하기 위해 query 페이지를 만들거나 갱신한다.
3. query 페이지에서 충돌하는 두 source를 모두 연결한다.
4. 충분한 근거가 쌓이면 synthesis 페이지에서 정리한다.`

const researchTemplate: WikiTemplate = {
  id: "research",
  name: "Research",
  description: "Deep-dive research with hypothesis tracking and methodology notes",
  icon: "🔬",
  extraDirs: ["wiki/methodology", "wiki/findings", "wiki/thesis"],
  schema: `# 위키 스키마 — 심층 연구

## 페이지 유형

| 유형 | 디렉터리 | 목적 |
|------|-----------|---------|
${BASE_SCHEMA_TYPES}
| thesis | wiki/thesis/ | 작업 가설과 시간에 따른 변화 |
| methodology | wiki/methodology/ | 연구 방법, 프로토콜, 연구 설계 |
| finding | wiki/findings/ | 개별 경험적 결과나 관찰 |

${BASE_LANGUAGE_POLICY}

## 파일명 규칙

${BASE_NAMING}
- Thesis: 가설을 자연어 제목으로 만든다(예: \`스케일링과 추론 성능.md\`)
- Methodology: 방법론 이름을 사용한다(예: \`Systematic Review.md\`, \`Ablation Study.md\`)
- Finding: 발견 내용을 설명하는 자연어 제목을 쓴다(예: \`대형 모델의 Few Shot 성능.md\`)

## Frontmatter

${BASE_FRONTMATTER}

thesis 페이지는 추가로 다음 필드를 포함한다:
\`\`\`yaml
confidence: low | medium | high
status: speculative | supported | refuted | settled
\`\`\`

finding 페이지는 추가로 다음 필드를 포함한다:
\`\`\`yaml
source: "[[source-slug]]"
confidence: low | medium | high
replicated: true | false | null
\`\`\`

## Index 형식

${BASE_INDEX_FORMAT}

## Log 형식

${BASE_LOG_FORMAT}

## 교차 참조 규칙

${BASE_CROSSREF}
- finding 페이지는 \`source:\` frontmatter 필드로 원본 source를 연결한다.
- thesis 페이지는 \`related:\`로 지지하거나 반박하는 finding을 참조한다.
- methodology 페이지는 해당 방법을 사용한 finding에서 인용한다.

## 모순 처리

${BASE_CONTRADICTION}

## 연구 전용 규칙

- 근거가 쌓이면 thesis 페이지를 계속 갱신한다. thesis는 살아 있는 문서로 다룬다.
- 모든 finding은 알려진 경우 재현 여부를 평가한다.
- methodology 페이지는 방법뿐 아니라 그 방법을 쓰는 이유와 근거도 설명한다.
- finding 페이지에서는 직접 근거와 추론을 구분한다.
`,
  purpose: `# 프로젝트 목적 — 심층 연구

${BASE_PURPOSE_LANGUAGE_POLICY}

## 연구 질문

<!-- 이 연구가 답하려는 중심 질문을 적는다. 구체적이고 반증 가능하게 쓴다. -->

>

## 가설 / 작업 논지

<!-- 현재 가장 그럴듯한 판단을 적는다. 근거가 쌓이면 계속 갱신한다. -->

>

## 배경

<!-- 이 연구를 시작하게 한 선행 연구, 맥락, 공백을 적는다. -->

## 하위 질문

<!-- 중심 질문을 조사 가능한 작은 질문으로 나눈다. -->

1.
2.
3.
4.

## 범위

**포함:**
-

**제외:**
-

## 방법론

<!-- 어떻게 조사할지, 어떤 자료나 실험이 관련 있는지 적는다. -->

-

## 성공 기준

<!-- 어떤 상태가 되면 충분히 만족스러운 답이라고 볼지 적는다. -->

-

## 현재 상태

> 시작 전 — 연구가 진행되면 이 섹션을 갱신한다.
`,
}

const readingTemplate: WikiTemplate = {
  id: "reading",
  name: "Reading",
  description: "Track a book's characters, themes, plot threads, and chapter notes",
  icon: "📚",
  extraDirs: ["wiki/characters", "wiki/themes", "wiki/plot-threads", "wiki/chapters"],
  schema: `# 위키 스키마 — 독서

## 페이지 유형

| 유형 | 디렉터리 | 목적 |
|------|-----------|---------|
${BASE_SCHEMA_TYPES}
| character | wiki/characters/ | 책에 등장하는 인물과 주요 대상 |
| theme | wiki/themes/ | 반복되는 생각, 모티프, 상징적 흐름 |
| plot-thread | wiki/plot-threads/ | 추적 중인 이야기 줄기나 서사 arc |
| chapter | wiki/chapters/ | 장별 노트와 요약 |

${BASE_LANGUAGE_POLICY}

## 파일명 규칙

${BASE_NAMING}
- Character: 인물명 그대로 쓴다(예: \`Elizabeth Bennet.md\`)
- Theme: 주제를 나타내는 명사구를 쓴다(예: \`Social Class Mobility.md\`, \`Deception vs Honesty.md\`)
- Plot thread: 서사 흐름 설명을 사용한다(예: \`Darcy Redemption Arc.md\`)
- Chapter: 표준 번호만 유지하고 제목은 자연어로 쓴다(예: \`Ch 01 Opening Scene.md\`)

## Frontmatter

${BASE_FRONTMATTER}

character 페이지는 추가로 다음 필드를 포함한다:
\`\`\`yaml
first_appearance: "Ch. N"
role: protagonist | antagonist | supporting | minor
\`\`\`

chapter 페이지는 추가로 다음 필드를 포함한다:
\`\`\`yaml
chapter: N
pages: "1-24"
\`\`\`

## Index 형식

${BASE_INDEX_FORMAT}

## Log 형식

${BASE_LOG_FORMAT}

## 교차 참조 규칙

${BASE_CROSSREF}
- chapter 노트는 해당 장에 등장하는 character를 \`related:\`로 참조한다.
- theme 페이지는 그 주제가 두드러지는 chapter를 연결한다.
- plot-thread 페이지는 해당 arc를 진전시키는 chapter를 나열한다.

## 모순 처리

${BASE_CONTRADICTION}

## 독서 전용 규칙

- chapter 페이지는 읽는 중이거나 읽은 직후 작성해 생생한 반응을 남긴다.
- chapter 노트에서는 줄거리 요약과 개인 해석을 구분한다.
- theme 페이지는 주제가 존재한다는 사실만 쓰지 말고 책 전체에서 어떻게 발전하는지 추적한다.
- 해결되지 않은 plot thread는 해결 전까지 status를 \`open\`으로 표시한다.
- 중요한 인용은 나중에 다시 찾을 수 있도록 페이지 번호를 적는다.
`,
  purpose: `# 프로젝트 목적 — 독서

${BASE_PURPOSE_LANGUAGE_POLICY}

## 책 정보

**제목:**
**저자:**
**연도:**
**장르:**

## 이 책을 읽는 이유

<!-- 이 책에 끌린 이유와 얻고 싶은 것을 적는다. -->

## 추적할 핵심 주제

<!-- 예상하거나 따라가고 싶은 주제 흐름을 적는다. -->

1.
2.
3.

## 읽기 전 질문

<!-- 책을 다 읽을 때까지 답을 찾고 싶은 질문을 적는다. -->

1.
2.

## 독서 속도

**시작일:**
**목표 완료일:**
**현재 장:**

## 첫인상

<!-- 첫 장 또는 첫 독서 세션 뒤에 갱신한다. -->

>

## 최종 배움

<!-- 완독 후 작성한다. 이 책이 무엇을 알려주었는지 적는다. -->

>
`,
}

const personalTemplate: WikiTemplate = {
  id: "personal",
  name: "Personal Growth",
  description: "Track goals, habits, reflections, and journal entries for self-improvement",
  icon: "🌱",
  extraDirs: ["wiki/goals", "wiki/habits", "wiki/reflections", "wiki/journal"],
  schema: `# 위키 스키마 — 개인 성장

## 페이지 유형

| 유형 | 디렉터리 | 목적 |
|------|-----------|---------|
${BASE_SCHEMA_TYPES}
| goal | wiki/goals/ | 달성하려는 구체적 결과 |
| habit | wiki/habits/ | 반복 행동과 추적 기록 |
| reflection | wiki/reflections/ | 주기적 회고와 배운 점 |
| journal | wiki/journal/ | 자유 형식의 일간 또는 세션 기록 |

${BASE_LANGUAGE_POLICY}

## 파일명 규칙

${BASE_NAMING}
- Goal: 원하는 결과를 자연어 제목으로 쓴다(예: \`마라톤 완주.md\`, \`스페인어 학습.md\`)
- Habit: 행동 이름을 쓴다(예: \`Daily Meditation.md\`, \`Morning Pages.md\`)
- Reflection: 유형과 표준 날짜를 함께 쓴다(예: \`Weekly 2024-03.md\`, \`Quarterly 2024 Q1.md\`)
- Journal: 날짜 slug를 쓴다(예: \`2024-03-15.md\`)

## Frontmatter

${BASE_FRONTMATTER}

goal 페이지는 추가로 다음 필드를 포함한다:
\`\`\`yaml
target_date: YYYY-MM-DD
status: active | paused | achieved | abandoned
progress: 0-100
\`\`\`

habit 페이지는 추가로 다음 필드를 포함한다:
\`\`\`yaml
frequency: daily | weekly | monthly
streak: N
status: active | paused | dropped
\`\`\`

reflection 페이지는 추가로 다음 필드를 포함한다:
\`\`\`yaml
period: weekly | monthly | quarterly | annual
\`\`\`

## Index 형식

${BASE_INDEX_FORMAT}

## Log 형식

${BASE_LOG_FORMAT}

## 교차 참조 규칙

${BASE_CROSSREF}
- reflection 페이지는 해당 기간에 검토한 goal과 habit을 참조한다.
- goal은 이를 뒷받침하는 habit을 \`related:\`로 연결한다.
- journal 항목은 본문에서 \`[[slug]]\`로 goal과 reflection을 참조할 수 있다.

## 모순 처리

${BASE_CONTRADICTION}

## 개인 성장 전용 규칙

- journal과 reflection에는 솔직하게 쓴다. 이 위키는 관객이 아니라 자신을 위한 공간이다.
- goal의 progress 필드는 정기적으로 갱신한다. 낡은 데이터는 없는 데이터보다 더 혼란스럽다.
- 결과 목표(원하는 것)와 과정 목표(실제로 할 행동)를 구분한다.
- habit은 성공 여부뿐 아니라 왜 성공하거나 실패했는지 회고한다.
- 여러 goal이나 기간을 가로지르는 통찰은 synthesis 디렉터리에 정리한다.
`,
  purpose: `# 프로젝트 목적 — 개인 성장

${BASE_PURPOSE_LANGUAGE_POLICY}

## 집중 영역

<!-- 삶이나 자기 자신 중 현재 적극적으로 다루는 영역을 적는다. -->

1.
2.
3.

## 동기

<!-- 왜 지금 시작하는지, 무엇이 이 위키를 만들게 했는지 적는다. -->

## 현재 목표 요약

<!-- 큰 목록을 적고, 자세한 내용은 wiki/goals/에 goal 페이지로 만든다. -->

- [ ]
- [ ]
- [ ]

## 활성 습관

<!-- 큰 목록을 적고, 자세한 내용은 wiki/habits/에 habit 페이지로 만든다. -->

-
-

## 회고 주기

**일간 journal:** 예 / 아니오
**주간 reflection:**
**월간 reflection:**
**분기 reflection:**

## 운영 원칙

<!-- 성장 작업을 이끄는 가치나 원칙을 적는다. -->

1.
2.
3.

## 올해의 테마

<!-- 올해의 의도를 담은 한 문장 또는 문구를 적는다. -->

>
`,
}

const businessTemplate: WikiTemplate = {
  id: "business",
  name: "Business",
  description: "Manage meetings, projects, stakeholder context, and open questions for a team",
  icon: "💼",
  extraDirs: ["wiki/meetings", "wiki/projects", "wiki/stakeholders"],
  schema: `# 위키 스키마 — 비즈니스 / 팀

## 페이지 유형

| 유형 | 디렉터리 | 목적 |
|------|-----------|---------|
${BASE_SCHEMA_TYPES}
| meeting | wiki/meetings/ | 회의록, agenda, 실행 항목 |
| project | wiki/projects/ | 프로젝트 개요, 상태, 회고 |
| stakeholder | wiki/stakeholders/ | 관련된 사람, 팀, 조직 |

${BASE_LANGUAGE_POLICY}

## 파일명 규칙

${BASE_NAMING}
- Meeting: \`YYYY-MM-DD-slug.md\` 형식을 쓴다(예: \`2024-03-15-sprint-planning.md\`)
- Project: 설명적인 자연어 제목을 쓴다(예: \`Payments Redesign.md\`)
- Stakeholder: 사람이나 팀 이름 그대로 쓴다(예: \`Alice Chen.md\`, \`Platform Team.md\`)

## Frontmatter

${BASE_FRONTMATTER}

meeting 페이지는 추가로 다음 필드를 포함한다:
\`\`\`yaml
date: YYYY-MM-DD
attendees: []
action_items: []
\`\`\`

project 페이지는 추가로 다음 필드를 포함한다:
\`\`\`yaml
status: planned | active | on-hold | complete | cancelled
owner: ""
start_date: YYYY-MM-DD
target_date: YYYY-MM-DD
\`\`\`

## Index 형식

${BASE_INDEX_FORMAT}

## Log 형식

${BASE_LOG_FORMAT}

## 교차 참조 규칙

${BASE_CROSSREF}
- meeting 노트는 \`attendees:\` frontmatter와 \`[[stakeholder-slug]]\` 링크로 참석자를 참조한다.
- 중요한 결정이나 미해결 판단은 query 페이지에 남기고 관련 meeting 또는 project를 연결한다.
- project 페이지는 핵심 query와 source를 \`related:\`로 연결한다.
- stakeholder 페이지는 관련 project와 query를 나열한다.

## 모순 처리

${BASE_CONTRADICTION}

## 비즈니스 전용 규칙

- meeting 노트는 회의 중 또는 24시간 안에 작성한다. 기억은 빠르게 흐려진다.
- 실행 항목은 실행 가능하도록 담당자와 기한을 반드시 둔다.
- 결정이 확정되면 관련 project 또는 query 페이지에 맥락과 결과를 함께 기록한다.
- project는 완료 시 회고 섹션을 추가한다.
`,
  purpose: `# 프로젝트 목적 — 비즈니스 / 팀

${BASE_PURPOSE_LANGUAGE_POLICY}

## 비즈니스 맥락

**조직 / 팀:**
**도메인:**
**기록 기간:**

## 목표

<!-- 이 위키가 지원하는 최상위 비즈니스 목표를 적는다. -->

1.
2.
3.

## 핵심 프로젝트

<!-- 큰 목록을 적고, 자세한 내용은 wiki/projects/에 project 페이지로 만든다. -->

-
-

## 핵심 이해관계자

<!-- 주요 인물이나 팀을 적는다. -->

-
-

## 열린 질문 / 결정

<!-- 현재 논의 중인 질문이나 결정을 적고, 자세한 내용은 wiki/queries/에 query 페이지로 만든다. -->

-
-

## 지표 / 성공 기준

<!-- 팀이 목표 달성 과정을 어떻게 측정하는지 적는다. -->

-

## 제약과 위험

<!-- 예산, 시간, 조직 같은 알려진 제약과 추적해야 할 위험을 적는다. -->

-

## 검토 주기

**주간 동기화 노트:**
**월간 상태 갱신:**
**분기 회고:**
`,
}

const generalTemplate: WikiTemplate = {
  id: "general",
  name: "General",
  description: "Minimal setup — a blank slate for any purpose",
  icon: "📄",
  extraDirs: [],
  schema: `# 위키 스키마

## 페이지 유형

| 유형 | 디렉터리 | 목적 |
|------|-----------|---------|
${BASE_SCHEMA_TYPES}

${BASE_LANGUAGE_POLICY}

## 파일명 규칙

${BASE_NAMING}

## Frontmatter

${BASE_FRONTMATTER}

## Index 형식

${BASE_INDEX_FORMAT}

## Log 형식

${BASE_LOG_FORMAT}

## 교차 참조 규칙

${BASE_CROSSREF}

## 모순 처리

${BASE_CONTRADICTION}
`,
  purpose: `# 프로젝트 목적

${BASE_PURPOSE_LANGUAGE_POLICY}

## 목표

<!-- 무엇을 이해하거나 만들려는지 적는다. -->

## 핵심 질문

<!-- 이 프로젝트를 움직이는 주요 질문을 적는다. -->

1.
2.
3.

## 범위

**포함:**
-

**제외:**
-

## 작업 논지

<!-- 현재 작업 가설이나 결론을 적고, 프로젝트가 진행되면 갱신한다. -->

> 미정
`,
}

export const templates: WikiTemplate[] = [
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

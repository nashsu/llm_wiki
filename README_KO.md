# LLM Wiki

<p align="center">
  <img src="logo.jpg" width="128" height="128" style="border-radius: 22%;" alt="LLM Wiki Logo">
</p>

<p align="center">
  <strong>스스로 만들어지는 개인 지식 베이스.</strong><br>
  LLM이 문서를 읽고 구조화된 Wiki를 만들며 계속 최신 상태로 유지합니다.
</p>

<p align="center">
  <a href="#이게-무엇인가요">이게 무엇인가요?</a> •
  <a href="#변경하고-추가한-것들">기능</a> •
  <a href="#기술-스택">기술 스택</a> •
  <a href="#설치">설치</a> •
  <a href="#크레딧">크레딧</a> •
  <a href="#라이선스">라이선스</a>
</p>

<p align="center">
  <a href="README.md">English</a> | <a href="README_CN.md">中文</a> | <a href="README_JA.md">日本語</a> | 한국어
</p>

---

<p align="center">
  <img src="assets/overview.jpg" width="100%" alt="개요">
</p>

## 기능

- **2단계 Chain-of-Thought 인제스트** — LLM이 먼저 분석한 뒤, 출처 추적성과 증분 캐시를 갖춘 Wiki 페이지를 생성합니다
- **멀티모달 이미지 인제스트** — PDF에 포함된 이미지를 추출하고, Vision LLM으로 사실 기반 캡션을 생성하며, 이미지 인식 검색 결과와 라이트박스 미리보기, 원본 위치로 이동 기능을 제공합니다
- **선택적 MinerU PDF 파싱** — 표, 수식, 복잡한 레이아웃이 있는 PDF에는 MinerU 클라우드 파싱을 사용할 수 있으며, 기본값은 내장 로컬 파서입니다
- **4-신호 지식 그래프** — 직접 링크, 출처 중복, Adamic-Adar, 타입 친화도를 사용하는 관련성 모델입니다
- **Louvain 커뮤니티 감지** — 지식 클러스터를 자동으로 발견하고 응집도를 점수화합니다
- **그래프 인사이트** — 뜻밖의 연결과 지식 공백을 찾아내고, 한 번의 클릭으로 Deep Research를 실행합니다
- **벡터 의미 검색** — LanceDB 기반의 선택적 임베딩 검색으로, OpenAI 호환 엔드포인트를 지원합니다
- **영속 인제스트 큐** — 직렬 처리, 충돌 복구, 취소, 재시도, 진행 상황 시각화를 지원합니다
- **폴더 가져오기** — 디렉터리 구조를 유지하며 재귀적으로 가져오고, 폴더 컨텍스트를 LLM 분류 힌트로 사용합니다
- **소스 폴더 자동 감시** — `raw/sources/`의 외부 변경을 감지하고 인제스트/삭제 정리 흐름과 동기화합니다
- **Deep Research** — LLM에 최적화된 검색 주제와 Tavily, SerpApi, SearXNG 기반 다중 쿼리 웹 검색을 사용하고, 결과를 자동으로 Wiki에 인제스트합니다
- **Rust 백엔드 Chat Agent** — Wiki/Source/Graph/Web 검색, workspace 파일 생성, shell 승인, 취소, 스트리밍 tool event를 지원하는 도구 사용형 채팅 runtime입니다
- **Agent Skills** — 로컬 `SKILL.md` 폴더를 스캔하고 활성화하며, 채팅에서 `/skill`로 선택하면 Agent가 필요할 때 Skill 지침을 읽습니다
- **생성물 미리보기** — Agent가 만든 Markdown, HTML, 이미지 등 workspace 파일을 생성물로 표시하고, 미리보기와 출력 폴더 열기를 지원합니다
- **Mermaid 다이어그램 렌더링** — 채팅과 미리보기에서 Mermaid 코드 블록을 직접 렌더링하고, 문법 오류는 간결한 오류 카드로 표시합니다
- **비동기 리뷰 시스템** — LLM이 사람의 판단이 필요한 항목을 표시하고, 사전 정의된 작업과 미리 생성된 검색 쿼리를 제공합니다
- **Chrome Web Clipper** — 웹 페이지를 한 번의 클릭으로 캡처하고 지식 베이스에 자동 인제스트합니다
- **로컬 HTTP API + MCP Server + AI Agent Skill** — 내장 `127.0.0.1:19828` JSON API와 번들 MCP Server를 통해 하이브리드 검색, 파일 읽기, 그래프 탐색, 소스 재스캔을 지원합니다. 바로 사용할 수 있는 [agent skill](https://github.com/nashsu/llm_wiki_skill)은 한 줄 명령(`npx skills add ...`)으로 Claude Code / Codex에 설치할 수 있습니다

## 이게 무엇인가요?

LLM Wiki는 문서를 자동으로 정리되고 서로 연결된 지식 베이스로 바꾸는 크로스 플랫폼 데스크톱 애플리케이션입니다. 전통적인 RAG처럼 매번 처음부터 검색하고 답을 만드는 대신, LLM이 소스에서 **영속적인 Wiki를 증분 방식으로 구축하고 유지**합니다. 지식은 한 번 컴파일되고 계속 최신 상태로 유지되며, 쿼리마다 다시 추론되지 않습니다.

이 프로젝트는 [Karpathy의 LLM Wiki 패턴](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)을 기반으로 합니다. 이는 LLM으로 개인 지식 베이스를 구축하는 방법론입니다. llm_wiki는 [nash_su](https://x.com/nash_su)가 만들고 유지 관리하며, 핵심 아이디어를 완전한 데스크톱 애플리케이션으로 구현하고 큰 폭으로 확장했습니다.

<p align="center">
  <img src="assets/llm_wiki_arch.jpg" width="100%" alt="LLM Wiki 아키텍처">
</p>

## 크레딧

기초 방법론은 **Andrej Karpathy**의 [llm-wiki.md](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)에서 왔습니다. 이 문서는 LLM을 사용해 개인 Wiki를 증분 방식으로 구축하고 유지하는 패턴을 설명합니다. 원문은 추상적인 설계 패턴이며, 이 프로젝트는 상당한 확장을 더한 구체적인 구현입니다.

## 원본에서 유지한 것

핵심 아키텍처는 Karpathy의 설계를 충실히 따릅니다.

- **3계층 아키텍처**: Raw Sources(불변) → Wiki(LLM 생성) → Schema(규칙 및 설정)
- **3가지 핵심 작업**: Ingest, Query, Lint
- **index.md**를 콘텐츠 카탈로그이자 LLM 탐색 진입점으로 사용
- **log.md**를 파싱 가능한 형식의 시간순 작업 기록으로 사용
- **[[wikilink]]** 문법으로 상호 참조
- 모든 Wiki 페이지에 **YAML frontmatter** 사용
- **Obsidian 호환성** — Wiki 디렉터리를 Obsidian vault로 사용할 수 있습니다
- **사람이 큐레이션하고 LLM이 유지** — 기본 역할 분담입니다

<p align="center">
  <img src="assets/5-obsidian_compatibility.jpg" width="100%" alt="Obsidian 호환성">
</p>

## 변경하고 추가한 것들

### 1. CLI에서 데스크톱 애플리케이션으로

원본은 LLM 에이전트에 복사해 붙여 넣어 쓰는 추상적인 패턴 문서입니다. 우리는 이를 **완전한 크로스 플랫폼 데스크톱 애플리케이션**으로 만들었습니다.

- **3열 레이아웃**: Knowledge Tree / File Tree(왼쪽) + Chat(가운데) + Preview(오른쪽)
- Wiki, Sources, Search, Graph, Lint, Review, Deep Research, Settings를 전환하는 **아이콘 사이드바**
- **사용자 정의 리사이즈 패널** — 최소/최대 제약을 가진 좌우 패널 드래그 리사이즈
- **Activity 패널** — 파일별 인제스트 진행 상황을 보여주는 실시간 처리 상태
- **모든 상태 영속화** — 대화, 설정, 리뷰 항목, 프로젝트 설정이 재시작 후에도 유지됩니다
- **시나리오 템플릿** — Research, Reading, Personal Growth, Business, General 템플릿이 각각 purpose.md와 schema.md를 미리 설정합니다

### 2. purpose.md — Wiki의 영혼

원본에는 Schema(Wiki가 작동하는 방식)는 있지만 Wiki가 존재하는 **이유**를 담는 공식 위치가 없습니다. 우리는 `purpose.md`를 추가했습니다.

- 목표, 핵심 질문, 연구 범위, 진화하는 논지를 정의합니다
- LLM이 모든 인제스트와 쿼리에서 컨텍스트로 읽습니다
- LLM이 사용 패턴을 바탕으로 업데이트를 제안할 수 있습니다
- schema와 다릅니다. schema는 구조적 규칙이고, purpose는 방향성 있는 의도입니다

### 3. 2단계 Chain-of-Thought 인제스트

원본은 LLM이 읽기와 쓰기를 동시에 수행하는 단일 단계 인제스트를 설명합니다. 우리는 품질을 크게 높이기 위해 이를 **두 번의 순차 LLM 호출**로 나눴습니다.

```plaintext
1단계(분석): LLM이 소스를 읽음 → 구조화된 분석
  - 핵심 엔티티, 개념, 주장
  - 기존 Wiki 콘텐츠와의 연결
  - 기존 지식과의 모순 및 긴장
  - Wiki 구조 권장 사항

2단계(생성): LLM이 분석을 받아 Wiki 파일 생성
  - frontmatter(type, title, sources[])가 있는 소스 요약
  - 상호 참조가 포함된 엔티티 페이지와 개념 페이지
  - 갱신된 index.md, log.md, overview.md
  - 사람의 판단이 필요한 리뷰 항목
  - Deep Research용 검색 쿼리
```

원본을 넘어 추가한 인제스트 개선 사항:

- **SHA256 증분 캐시** — 인제스트 전에 소스 파일 콘텐츠를 해시하고, 변경되지 않은 파일은 자동으로 건너뛰어 LLM 토큰과 시간을 절약합니다
- **영속 인제스트 큐** — 직렬 처리로 동시 LLM 호출을 방지합니다. 큐는 디스크에 저장되어 앱 재시작 후에도 유지되며, 실패한 작업은 최대 3회 자동 재시도됩니다
- **폴더 가져오기** — 디렉터리 구조를 유지하며 재귀적으로 가져옵니다. 폴더 경로는 LLM 분류 컨텍스트로 전달됩니다(예: "papers > energy"는 콘텐츠 분류에 도움이 됩니다)
- **소스 폴더 자동 감시** — 앱 밖에서 `raw/sources/`에 추가, 수정, 삭제된 파일을 자동으로 감지하고 앱 내부 작업과 동일한 인제스트/삭제 생명주기를 재사용합니다
- **큐 시각화** — Activity Panel이 진행률 표시줄, 대기/처리/실패 작업, 취소 및 재시도 버튼을 표시합니다
- **자동 임베딩** — 벡터 검색이 활성화되어 있으면 새 페이지가 인제스트 후 자동으로 임베딩됩니다
- **출처 추적성** — 생성된 모든 Wiki 페이지는 YAML frontmatter에 `sources: []` 필드를 포함하여 기여한 원본 소스 파일로 되돌아갈 수 있게 합니다
- **overview.md 자동 업데이트** — 전체 요약 페이지가 매 인제스트마다 재생성되어 최신 Wiki 상태를 반영합니다
- **보장된 소스 요약** — LLM이 누락하더라도 소스 요약 페이지가 항상 생성되도록 fallback을 제공합니다
- **언어 인식 생성** — LLM은 사용자가 설정한 언어(영어 또는 중국어)로 응답합니다
- **점진적 Sources 뷰** — 큰 소스 폴더를 스크롤 중 점진적으로 렌더링하여 대규모 소스 컬렉션에서도 반응성을 유지합니다

### 4. 관련성 모델을 갖춘 지식 그래프

<p align="center">
  <img src="assets/3-knowledge_graph.jpg" width="100%" alt="지식 그래프">
</p>

원본은 상호 참조를 위한 `[[wikilinks]]`를 언급하지만 그래프 분석은 없습니다. 우리는 **완전한 지식 그래프 시각화 및 관련성 엔진**을 만들었습니다.

**4-신호 관련성 모델:**

| 신호 | 가중치 | 설명 |
|------|--------|------|
| 직접 링크 | x3.0 | `[[wikilinks]]`로 연결된 페이지 |
| 출처 중복 | x4.0 | frontmatter `sources[]`를 통해 같은 원본 소스를 공유하는 페이지 |
| Adamic-Adar | x1.5 | 공통 이웃을 공유하는 페이지(이웃 차수로 가중) |
| 타입 친화도 | x1.0 | 같은 페이지 타입(entity↔entity, concept↔concept)에 보너스 |

**그래프 시각화(sigma.js + graphology + ForceAtlas2):**

- 노드 색상은 페이지 타입 또는 커뮤니티 기준, 크기는 링크 수에 따라 조정(√ 스케일링)
- 엣지 두께와 색상은 관련성 가중치 기준(초록=강함, 회색=약함)
- Hover 상호작용: 이웃은 보이고 비이웃은 흐려지며, 엣지가 관련성 점수 라벨과 함께 강조됩니다
- 줌 컨트롤(ZoomIn, ZoomOut, Fit-to-screen)
- 위치 캐싱으로 데이터 업데이트 시 레이아웃 튐 방지
- 색상 모드에 따라 타입 수와 커뮤니티 정보를 전환하는 범례

### 5. Louvain 커뮤니티 감지

원본에는 없는 기능입니다. **Louvain 알고리즘**(graphology-communities-louvain)을 사용해 지식 클러스터를 자동으로 발견합니다.

- **자동 클러스터링** — 사전 정의된 페이지 타입과 무관하게 링크 토폴로지를 기반으로 자연스럽게 묶이는 페이지를 발견합니다
- **타입 / 커뮤니티 토글** — 노드 색상을 페이지 타입(entity, concept, source 등) 또는 발견된 지식 클러스터 기준으로 전환합니다
- **응집도 점수** — 각 커뮤니티를 내부 엣지 밀도(실제 엣지 / 가능한 엣지)로 평가합니다. 응집도가 낮은 클러스터(< 0.15)는 경고로 표시됩니다
- **12색 팔레트** — 클러스터를 뚜렷하게 구분합니다
- **커뮤니티 범례** — 상위 노드 라벨, 멤버 수, 클러스터별 응집도를 표시합니다

<p align="center">
  <img src="assets/kg_community.jpg" width="100%" alt="Louvain 커뮤니티 감지">
</p>

### 6. 그래프 인사이트 — 뜻밖의 연결과 지식 공백

원본에는 없는 기능입니다. 시스템이 **그래프 구조를 자동 분석**하여 실행 가능한 인사이트를 보여줍니다.

**뜻밖의 연결:**

- 교차 커뮤니티 엣지, 교차 타입 링크, 주변부↔허브 결합 같은 예상 밖의 관계를 감지합니다
- 복합 surprise score로 가장 주목할 만한 연결을 순위화합니다
- 닫을 수 있습니다. 연결을 reviewed로 표시하면 다시 나타나지 않습니다

**지식 공백:**

- **고립 페이지**(degree ≤ 1) — 나머지 Wiki와의 연결이 거의 없거나 없는 페이지
- **희소 커뮤니티**(응집도 < 0.15, 3개 이상 페이지) — 내부 상호 참조가 약한 지식 영역
- **브리지 노드**(3개 이상 클러스터 연결) — 여러 지식 영역을 묶는 핵심 연결 지점

**상호작용:**

- 인사이트 카드를 클릭하면 해당 노드와 엣지가 **강조**됩니다. 다시 클릭하면 선택이 해제됩니다
- 지식 공백과 브리지 노드에는 **Deep Research 버튼**이 있어 도메인 인식 주제로 LLM 최적화 리서치를 시작합니다(overview.md + purpose.md를 컨텍스트로 읽음)
- 리서치 주제는 시작 전에 **편집 가능한 확인 대화상자**에 표시되어, 사용자가 주제와 검색 쿼리를 조정할 수 있습니다

<p align="center">
  <img src="assets/kg_insights.jpg" width="100%" alt="그래프 인사이트">
</p>

### 7. 최적화된 쿼리 검색 파이프라인

원본은 LLM이 관련 페이지를 읽는 단순 쿼리를 설명합니다. 우리는 선택적 벡터 검색과 예산 제어를 포함한 **다단계 검색 파이프라인**을 만들었습니다.

```plaintext
1단계: 토큰화 검색
  - 영어: 단어 분리 + stop word 제거
  - 중국어: CJK bigram 토큰화(每个 → [每个, 个...])
  - 제목 일치 보너스(+10점)
  - wiki/와 raw/sources/ 모두 검색

1.5단계: 벡터 의미 검색(선택)
  - OpenAI 호환 /v1/embeddings 엔드포인트로 임베딩
  - 빠른 ANN 검색을 위해 LanceDB(Rust backend)에 저장
  - 키워드가 겹치지 않아도 의미적으로 관련된 페이지를 찾음
  - 결과를 검색에 병합: 기존 일치를 boost하고 새 발견을 추가

2단계: 그래프 확장
  - 상위 검색 결과를 seed node로 사용
  - 4-신호 관련성 모델로 관련 페이지 탐색
  - 깊이에 따라 감쇠되는 2-hop traversal

3단계: 예산 제어
  - 설정 가능한 context window: 4K → 1M tokens
  - 비례 할당: Wiki 페이지 60%, 채팅 기록 20%, index 5%, system 15%
  - 페이지는 검색 + 그래프 관련성 합산 점수로 우선순위화

4단계: 컨텍스트 조립
  - 전체 콘텐츠를 가진 번호 매긴 페이지(요약만 제공하지 않음)
  - system prompt 포함: purpose.md, language rules, citation format, index.md
  - LLM은 페이지 번호 [1], [2] 등으로 인용하도록 지시됨
```

**벡터 검색**은 완전히 선택 사항입니다. 기본값은 비활성화이며, Settings에서 별도의 엔드포인트, API key, 모델 설정으로 활성화합니다. 비활성화되어 있으면 파이프라인은 토큰화 검색 + 그래프 확장으로 fallback합니다. 벤치마크 기준 전체 recall은 벡터 검색 활성화 시 58.2%에서 71.4%로 향상되었습니다.

### 8. 영속성을 갖춘 다중 대화 채팅

원본에는 단일 쿼리 인터페이스만 있습니다. 우리는 **완전한 다중 대화 지원**을 만들었습니다.

- **독립 채팅 세션** — 대화를 생성, 이름 변경, 삭제할 수 있습니다
- **대화 사이드바** — 주제 간 빠른 전환
- **대화별 영속성** — 각 대화는 `.llm-wiki/chats/{id}.json`에 저장됩니다
- **설정 가능한 히스토리 깊이** — 컨텍스트로 보낼 메시지 수를 제한합니다(기본값: 10)
- **인용 참조 패널** — 각 응답에 어떤 Wiki 페이지가 사용되었는지 타입별 아이콘과 함께 접을 수 있는 섹션으로 표시합니다
- **참조 영속성** — 인용된 페이지는 메시지 데이터에 직접 저장되어 재시작 후에도 안정적입니다
- **Regenerate** — 한 번의 클릭으로 마지막 응답을 다시 생성합니다(마지막 assistant + user 메시지 쌍 제거 후 재전송)
- **Save to Wiki** — 가치 있는 답변을 `wiki/queries/`에 보관한 뒤, 자동 인제스트로 엔티티/개념을 지식 네트워크에 추출합니다

### 9. Rust 백엔드 Chat Agent와 Skills

원본에는 없는 기능입니다. 채팅은 브라우저 전용 TypeScript 루프가 아니라 Rust 백엔드 Agent runtime으로 실행됩니다.

- **도구 사용형 Agent** — Wiki 검색, Source 검색, Graph 검색, Web 검색, AnyTXT, workspace 파일 도구, 승인된 shell 명령, Skill 파일 읽기를 선택할 수 있습니다
- **Skill 관리** — 프로젝트 및 사용자 Skill 폴더를 스캔하고, Skill을 활성화/비활성화하며, 대화별로 `/skill` 자동완성으로 Skill을 선택합니다
- **생성 workspace 출력물** — Agent 도구가 만든 파일은 `agent-workspace/` 아래에 저장되며, 생성물로 표시되어 미리보기하거나 폴더를 열 수 있습니다
- **사용자 입력 폼** — Skill은 단일 선택, 다중 선택, 자유 입력 같은 구조화된 사용자 입력을 요청할 수 있으며, Skill별 UI를 하드코딩할 필요가 없습니다
- **더 안전한 실행 모델** — 프로젝트 workspace 내부 명령은 자연스럽게 이어서 실행되고, 외부 shell 명령은 계속 명시적 승인을 요구합니다

### 10. Thinking / Reasoning 표시

원본에는 없는 기능입니다. `<think>` 블록을 내보내는 LLM(DeepSeek, QwQ 등)을 위해:

- **스트리밍 thinking** — 생성 중 5줄 rolling 표시와 opacity fade
- **기본 접힘 상태** — 완료 후 thinking 블록은 숨겨지고 클릭하면 펼쳐집니다
- **시각적 분리** — thinking 콘텐츠는 별도 스타일로 주 응답과 분리되어 표시됩니다

### 11. Markdown 렌더링: KaTeX 수식과 Mermaid 다이어그램

원본에는 없는 기능입니다. 채팅과 미리보기에서 더 풍부한 Markdown 렌더링을 지원합니다.

- **KaTeX 렌더링** — inline `$...$` 및 block `$$...$$` 수식을 remark-math + rehype-katex로 렌더링합니다
- **Milkdown math plugin** — preview editor가 @milkdown/plugin-math로 수식을 네이티브 렌더링합니다
- **자동 감지** — bare `\begin{aligned}` 및 기타 LaTeX environment를 `$$` delimiter로 자동 wrapping합니다
- **Unicode fallback** — math block 밖의 단순 inline notation을 위해 100개 이상의 symbol mapping(α, ∑, →, ≤ 등)을 제공합니다
- **Mermaid 코드 블록** — fenced `mermaid` 블록을 flowchart, sequence diagram 등 Mermaid 지원 다이어그램으로 직접 렌더링합니다
- **간결한 Mermaid 오류** — 문법 오류는 작은 오류 카드 안에 표시되어 원본 parser 출력이 채팅 화면을 채우지 않습니다

### 12. Review System(비동기 Human-in-the-Loop)

원본은 인제스트 중 사람이 계속 관여할 것을 제안합니다. 우리는 **비동기 리뷰 큐**를 추가했습니다.

- LLM이 인제스트 중 사람의 판단이 필요한 항목을 표시합니다
- **사전 정의된 작업 타입**: Create Page, Deep Research, Skip — LLM이 임의 작업을 환각하지 못하도록 제한합니다
- **인제스트 시점에 생성되는 검색 쿼리** — LLM이 각 리뷰 항목에 대해 최적화된 웹 검색 쿼리를 미리 생성합니다
- 사용자는 편한 시간에 리뷰를 처리할 수 있습니다. 인제스트를 막지 않습니다

### 13. Deep Research

<p align="center">
  <img src="assets/1-deepresearch.jpg" width="100%" alt="Deep Research">
</p>

원본에는 없는 기능입니다. LLM이 지식 공백을 발견하면:

- Tavily, SerpApi, SearXNG 기반 **웹 검색**이 전체 콘텐츠 추출(잘림 없음)로 관련 소스를 찾습니다
- **Provider별 설정** — Tavily와 SerpApi는 독립 API key를 사용합니다. SerpApi는 선택 가능한 engine을 지원하고, SearXNG는 설정된 instance URL과 검색 category를 사용합니다
- 주제당 **여러 검색 쿼리** — 인제스트 시점에 LLM이 생성하고 검색 엔진에 맞게 최적화합니다
- **LLM 최적화 리서치 주제** — Graph Insights에서 시작하면 LLM이 overview.md + purpose.md를 읽고 일반 키워드가 아닌 도메인 특화 주제와 쿼리를 생성합니다
- **사용자 확인 대화상자** — 리서치 시작 전에 편집 가능한 주제와 검색 쿼리를 표시합니다
- LLM이 결과를 기존 Wiki와 상호 참조되는 Wiki 리서치 페이지로 **종합**합니다
- **Thinking 표시** — 합성 중 `<think>` 블록을 접을 수 있는 섹션으로 표시하고 최신 콘텐츠로 자동 스크롤합니다
- **자동 인제스트** — 리서치 결과를 자동 처리해 엔티티/개념을 Wiki에 추출합니다
- 3개 동시 작업을 지원하는 **작업 큐**
- **Research Panel** — 동적 높이와 실시간 스트리밍 진행 상황을 갖춘 전용 사이드바 패널

### 14. 브라우저 확장(Web Clipper)

<p align="center">
  <img src="assets/4-chrome_extension_webclipper.jpg" width="100%" alt="Chrome Extension Web Clipper">
</p>

원본은 Obsidian Web Clipper를 언급합니다. 우리는 **전용 Chrome Extension**(Manifest V3)을 만들었습니다.

- **Mozilla Readability.js**로 정확한 article extraction 수행(광고, nav, sidebar 제거)
- table 지원이 있는 **Turndown.js**로 HTML → Markdown 변환
- **Project picker** — clip할 Wiki 프로젝트 선택(다중 프로젝트 지원)
- **Local HTTP API**(port 19827, tiny_http) — Extension ↔ App 통신
- **자동 인제스트** — clip된 콘텐츠가 자동으로 2단계 인제스트 파이프라인을 실행합니다
- **Clip watcher** — 3초마다 새 clip을 polling하고 자동 처리합니다
- **Offline preview** — 앱이 실행 중이 아니어도 추출된 콘텐츠를 표시합니다

### 15. 다중 형식 문서 지원

원본은 text/markdown에 집중합니다. 우리는 문서 의미 구조를 보존하는 구조화 추출을 지원합니다.

| 형식 | 방식 |
|------|------|
| PDF | 파일 캐싱이 포함된 내장 pdf-extract(Rust); 표, 수식, 복잡한 레이아웃에는 선택적으로 MinerU 클라우드 파싱 사용 |
| DOCX | docx-rs — headings, bold/italic, lists, tables → 구조화된 Markdown |
| PPTX | ZIP + XML — slide-by-slide extraction with heading/list structure |
| XLSX/XLS/ODS | calamine — proper cell types, multi-sheet support, Markdown tables |
| Images | Native preview(png, jpg, gif, webp, svg 등) |
| Video/Audio | 내장 player |
| Web clips | Readability.js + Turndown.js → clean Markdown |

> MinerU는 선택 기능입니다. 활성화하면 PDF 파일이 파싱을 위해 MinerU 클라우드로 업로드됩니다. 민감한 문서는 내장 로컬 파서를 사용하는 것을 권장합니다. MinerU 파싱이 실패하면 LLM Wiki는 내장 파서로 자동 fallback합니다. MinerU 사용에는 파일 크기, 페이지 수, quota 제한이 적용됩니다.

### 16. Cascade Cleanup을 포함한 파일 삭제

원본에는 삭제 메커니즘이 없습니다. 우리는 **지능적인 cascade deletion**을 추가했습니다.

- 소스 파일을 삭제하면 해당 Wiki 요약 페이지가 제거됩니다
- **3가지 매칭 방식**으로 관련 Wiki 페이지를 찾습니다: frontmatter `sources[]` 필드, 소스 요약 페이지 이름, frontmatter section references
- **공유 엔티티 보존** — 여러 소스에 연결된 entity/concept 페이지는 완전히 삭제되지 않고, 삭제된 소스만 `sources[]` 배열에서 제거됩니다
- **Index 정리** — 삭제된 페이지를 index.md에서 제거합니다
- **Wikilink 정리** — 삭제된 페이지로 향하는 죽은 `[[wikilinks]]`를 남은 Wiki 페이지에서 제거합니다

### 17. 설정 가능한 Context Window

원본에는 없는 기능입니다. 사용자는 LLM이 받는 컨텍스트 양을 설정할 수 있습니다.

- **4K부터 1M tokens까지의 slider** — 다양한 LLM capability에 맞게 조정됩니다
- **비례 예산 할당** — 더 큰 window는 비례해서 더 많은 Wiki 콘텐츠를 받습니다
- **60/20/5/15 분할** — Wiki pages / chat history / index / system prompt

### 18. 크로스 플랫폼 호환성

원본은 플랫폼 중립적인 추상 패턴입니다. 우리는 구체적인 크로스 플랫폼 문제를 처리합니다.

- **경로 정규화** — 22개 이상의 파일에서 통합 `normalizePath()` 사용, backslash → forward slash
- **Unicode-safe string handling** — byte 기반이 아닌 char 기반 slicing(CJK filename crash 방지)
- **macOS close-to-hide** — close button은 창을 숨깁니다(앱은 background에서 계속 실행). dock icon을 클릭하면 복원되고 Cmd+Q로 종료합니다
- **Windows/Linux 종료 확인** — 실수로 데이터를 잃지 않도록 종료 전 확인 대화상자 표시
- **Tauri v2** — macOS, Windows, Linux에서 native desktop 제공
- **GitHub Actions CI/CD** — macOS(ARM + Intel), Windows(.msi), Linux(.deb / .AppImage) 자동 빌드

### 19. 기타 추가 사항

- **i18n** — 영어 + 중국어 인터페이스(react-i18next)
- **설정 영속성** — LLM provider, API key, model, context size, language가 Tauri Store에 저장됩니다
- **Obsidian 설정** — 권장 설정이 포함된 `.obsidian/` 디렉터리 자동 생성
- **Markdown 렌더링** — 테두리가 있는 GFM tables, 적절한 code blocks, chat과 preview의 wikilink processing
- **다중 provider LLM 지원** — OpenAI, Anthropic, Google, Ollama, Custom. 각각 provider별 streaming과 header를 지원합니다
- **15분 timeout** — 긴 인제스트 작업이 너무 일찍 실패하지 않습니다
- **dataVersion signaling** — Wiki 콘텐츠가 변경되면 그래프와 UI가 자동 새로고침됩니다

## 기술 스택

| 계층 | 기술 |
|------|------|
| Desktop | Tauri v2(Rust backend) |
| Frontend | React 19 + TypeScript + Vite |
| UI | shadcn/ui + Tailwind CSS v4 |
| Editor | Milkdown(ProseMirror 기반 WYSIWYG) |
| Graph | sigma.js + graphology + ForceAtlas2 |
| Search | Tokenized search + graph relevance + optional vector(LanceDB) |
| Vector DB | LanceDB(Rust, embedded, optional) |
| PDF | pdf-extract + 선택적 MinerU 클라우드 파서 |
| Office | docx-rs + calamine |
| i18n | react-i18next |
| State | Zustand |
| LLM | Streaming fetch(OpenAI, Anthropic, Google, Ollama, Custom) |
| Web Search | Tavily, SerpApi, SearXNG JSON API |

## 설치

### 사전 빌드 바이너리

[Releases](https://github.com/nashsu/llm_wiki/releases)에서 다운로드하세요.

- **macOS**: `.dmg`(Apple Silicon + Intel)
- **Windows**: `.msi`
- **Linux**: `.deb` / `.AppImage`

### 소스에서 빌드

```bash
# Prerequisites: Node.js 20+, Rust 1.70+
git clone https://github.com/nashsu/llm_wiki.git
cd llm_wiki
npm install
npm run tauri dev      # Development
npm run tauri build    # Production build
```

### Chrome Extension

1. `chrome://extensions`를 엽니다
2. "Developer mode"를 활성화합니다
3. "Load unpacked"를 클릭합니다
4. `extension/` 디렉터리를 선택합니다

## 빠른 시작

1. 앱 실행 → 새 프로젝트 생성(템플릿 선택)
2. **Settings**로 이동 → LLM provider 설정(API key + model)
3. 선택 사항: Settings에서 **Web Search** provider와 source folder auto-watch 설정
4. **Sources**로 이동 → 문서 가져오기(PDF, DOCX, MD 등)
5. **Activity Panel** 확인 — LLM이 Wiki 페이지를 자동으로 만듭니다
6. **Chat**으로 지식 베이스에 질문합니다
7. **Knowledge Graph**에서 연결을 둘러봅니다
8. **Review**에서 주의가 필요한 항목을 확인합니다
9. **Lint**를 주기적으로 실행해 Wiki 상태를 유지합니다

## 로컬 HTTP API + MCP Server + AI Agent Skill

LLM Wiki에는 `http://127.0.0.1:19828`의 내장 로컬 HTTP API가 포함되어 있습니다(Token 보호, `127.0.0.1` 전용). 이를 통해 **Claude Code**, **Codex** 또는 HTTP를 사용할 수 있는 스크립트 같은 외부 도구가 Wiki에 쿼리할 수 있습니다.

- `GET /api/v1/health` — server status(no auth)
- `GET /api/v1/projects` — projects list
- `GET /api/v1/projects/{id}/files` / `files/content` — files and content read
- `POST /api/v1/projects/{id}/search` — `mode`, `tokenHits`, `vectorHits`, per-result `vectorScore`를 반환하는 **hybrid** retrieval(keyword + vector)
- `POST /api/v1/projects/{id}/chat` — 비스트리밍 Rust 백엔드 Agent chat 엔드포인트로 assistant message, references, usage, tool events를 반환하며 Wiki/Source/Web/AnyTXT 검색을 지원합니다. `mode: "deep"`은 증거 수집 범위를 넓힙니다
- `GET /api/v1/projects/{id}/graph` — wikilinks graph
- `POST /api/v1/projects/{id}/sources/rescan` — backend rescan trigger

**Settings → API + MCP**에서 API를 활성화하고 token을 생성할 수 있습니다. 필요하면 로컬 unauthenticated access도 켜거나 끌 수 있습니다.

MCP 호환 클라이언트를 위해 LLM Wiki는 `mcp-server/`도 함께 제공합니다. `npm run mcp:build`로 빌드한 뒤 **Settings → API + MCP**에서 현재 머신의 실제 경로가 들어간 MCP client configuration을 복사할 수 있습니다. MCP tools는 같은 API surface를 사용하므로 에이전트는 별도 HTTP glue code 없이 project list, file read, hybrid search, graph inspect, source rescan, 같은 Rust 백엔드 Agent chat endpoint 호출을 실행할 수 있습니다.

### 한 줄 명령으로 AI 에이전트 연결하기

LLM Wiki용 **agent skill**은 별도 repo에 있습니다. Claude Code / Codex / skills 호환 runtime에 설치할 수 있습니다.

```bash
npx skills add https://github.com/nashsu/llm_wiki_skill.git --skill llm-wiki
```

설치 후 에이전트는 "내 LLM Wiki는 X에 대해 뭐라고 말해?", "내 지식 베이스에서 Y를 검색해", "내 Wiki graph에서 Z의 이웃을 보여줘", "내 Wiki sources를 다시 스캔해" 같은 프롬프트에 답할 수 있습니다. 로컬에서 실행 중인 앱과 직접 통신하며, 기본값은 read-only이고 앱에서 검증할 수 있도록 Wiki 페이지 경로를 인용합니다.

- **Skill repo**: <https://github.com/nashsu/llm_wiki_skill>
- **Trigger discipline**: "내 노트 검색해" / "내 Obsidian / Notion / Logseq 확인해" 같은 일반 요청에는 의도적으로 반응하지 않습니다. LLM Wiki / `my wiki` / `지식 베이스`를 명시했을 때만 trigger됩니다.

## 프로젝트 구조

```plaintext
my-wiki/
├── purpose.md              # 목표, 핵심 질문, 연구 범위
├── schema.md               # Wiki 구조 규칙, 페이지 타입
├── raw/
│   ├── sources/            # 업로드된 문서(불변)
│   └── assets/             # 로컬 이미지
├── wiki/
│   ├── index.md            # 콘텐츠 카탈로그
│   ├── log.md              # 작업 기록
│   ├── overview.md         # 전체 요약(자동 업데이트)
│   ├── entities/           # 인물, 조직, 제품
│   ├── concepts/           # 이론, 방법, 기술
│   ├── sources/            # 소스 요약
│   ├── queries/            # 저장된 채팅 답변 + 리서치
│   ├── synthesis/          # 소스 간 분석
│   └── comparisons/        # 나란히 비교
├── .obsidian/              # Obsidian vault 설정(자동 생성)
└── .llm-wiki/              # 앱 설정, 채팅 기록, 리뷰 항목
```

## Star History

<a href="https://www.star-history.com/?repos=nashsu%2Fllm_wiki&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=nashsu/llm_wiki&type=date&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=nashsu/llm_wiki&type=date&legend=top-left" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=nashsu/llm_wiki&type=date&legend=top-left" />
 </picture>
</a>

## 라이선스

이 프로젝트는 **GNU General Public License v3.0**으로 라이선스됩니다. 자세한 내용은 [LICENSE](LICENSE)를 참고하세요.

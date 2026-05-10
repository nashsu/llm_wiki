use std::fs;
use std::path::Path;

use chrono::Local;

use crate::panic_guard::run_guarded;
use crate::types::wiki::WikiProject;

#[tauri::command]
pub fn create_project(name: String, path: String) -> Result<WikiProject, String> {
    run_guarded("create_project", || create_project_impl(name, path))
}

fn create_project_impl(name: String, path: String) -> Result<WikiProject, String> {
    let root = Path::new(&path).join(&name);

    if root.exists() {
        return Err(format!("Directory already exists: '{}'", root.display()));
    }

    // Create all required subdirectories
    let dirs = [
        "raw/sources",
        "raw/assets",
        "wiki/entities",
        "wiki/concepts",
        "wiki/sources",
        "wiki/queries",
        "wiki/comparisons",
        "wiki/synthesis",
    ];
    for dir in &dirs {
        fs::create_dir_all(root.join(dir))
            .map_err(|e| format!("Failed to create directory '{}': {}", dir, e))?;
    }

    let today = Local::now().format("%Y-%m-%d").to_string();

    // schema.md
    let schema_content = format!(
        r#"# 위키 스키마

## 작성 언어 원칙

- `schema.md`와 `purpose.md`는 기본적으로 한국어로 작성하고 유지한다.
- `wiki/index.md`, `wiki/log.md`, `wiki/overview.md` 등 주요 구조 문서도 한국어 작성을 기본 원칙으로 한다.
- 파일명, page type, YAML key, 고유명사, 원문 제목은 필요하면 영어를 유지한다.
- 설명, 판단, 요약, 운영 규칙은 한국어로 쓴다.

## 페이지 유형

| 유형 | 디렉터리 | 목적 |
|------|-----------|---------|
| entity | wiki/entities/ | 모델, 회사, 사람, 데이터셋처럼 이름이 있는 대상 |
| concept | wiki/concepts/ | 아이디어, 기법, 현상, 반복 패턴 |
| source | wiki/sources/ | 논문, 글, 발표, 블로그 글 같은 원본 자료 |
| query | wiki/queries/ | 계속 조사 중인 열린 질문 |
| comparison | wiki/comparisons/ | 관련 대상의 나란한 비교 분석 |
| synthesis | wiki/synthesis/ | 여러 자료를 가로지르는 종합과 결론 |

## 파일명 규칙

- 파일명은 사람이 읽기 쉬운 자연어 제목을 그대로 반영한다(예: `에이전트 오케스트레이션.md`).
- 단어 구분을 위해 하이픈을 넣지 않는다. 하이픈은 공식 명칭, 표준 날짜, 원제에 꼭 필요한 경우에만 유지한다.
- Unicode 한글과 공백을 허용한다. Obsidian 탐색에 한글이 더 명확하면 영어로 억지 변환하지 않는다.
- `wiki/entities/`는 가능하면 공식 명칭이나 원어 명칭을 제목과 파일명에 반영한다(예: `gpt-4.md`, `openai.md`).
- `wiki/entities/` 이외의 wiki 폴더는 frontmatter `title`과 H1을 한글 우선으로 쓴다. 고유명사, 제품명, 법령명, 약어는 필요한 경우 원어를 유지한다.
- concept은 설명적인 한글 명사구를 우선한다(예: `에이전트 오케스트레이션.md`).
- source는 원본의 핵심 주제를 한글 제목으로 정리하고 필요하면 `소스 요약`을 붙인다(예: `대한민국 판례 저장소 소스 요약.md`).
- query는 질문의 핵심 주제를 한글 제목으로 정리하고 필요하면 `질의 기록`을 붙인다(예: `그래프 DB 도입 기준 질의 기록.md`).
- `raw/sources/`, `raw/assets/`는 import 시 원문 내용은 바꾸지 않되, 파일명은 title 기반 자연어 제목으로 정리한다.
- Review/Chat 등 App UI에서 사용자가 직접 저장하거나 생성하는 문서도 같은 제목 규칙을 적용한다.

## Frontmatter

모든 페이지는 YAML frontmatter를 포함한다:

```yaml
---
type: entity | concept | source | query | comparison | synthesis | overview
title: 사람이 읽기 쉬운 제목
tags: []
related: []
created: YYYY-MM-DD
updated: YYYY-MM-DD
---
```

source 페이지는 추가로 다음 필드를 포함한다:
```yaml
authors: []
year: YYYY
url: ""
venue: ""
```

## Index 형식

`wiki/index.md`는 모든 페이지를 유형별로 묶어 나열한다. 각 항목은 다음 형식을 따른다:
```
- [[page-slug]] — 한 줄 설명
```

## Log 형식

`wiki/log.md`는 작업 이력을 최신순으로 기록한다:
```
## YYYY-MM-DD

- 수행한 작업 / 확인한 발견
```

## 교차 참조 규칙

- Wiki 페이지끼리는 `[[page-slug]]` 문법으로 연결한다.
- 모든 entity와 concept은 `wiki/index.md`에 나타나야 한다.
- query 페이지는 근거로 삼은 source와 concept을 연결한다.
- synthesis 페이지는 기여한 모든 source를 `related:`로 인용한다.

## 모순 처리

원본 자료끼리 충돌할 때:
1. 관련 concept 또는 entity 페이지에 모순을 명시한다.
2. 열린 질문을 추적하기 위해 query 페이지를 만들거나 갱신한다.
3. query 페이지에서 충돌하는 두 source를 모두 연결한다.
4. 충분한 근거가 쌓이면 synthesis 페이지에서 정리한다.
"#
    );
    write_file_inner(root.join("schema.md"), &schema_content)?;

    // purpose.md
    let purpose_content = r#"# 프로젝트 목적

## 작성 언어 원칙

- 이 프로젝트의 `schema.md`와 `purpose.md`는 한국어로 관리한다.
- `wiki/index.md`, `wiki/log.md`, `wiki/overview.md` 등 주요 문서는 한국어 작성을 기본 원칙으로 한다.
- 고유명사, 파일명, page type, YAML key는 필요하면 원어를 유지하되 설명과 판단은 한국어로 정리한다.

## 목표

<!-- 무엇을 이해하거나 만들려는지 적는다. -->

## 핵심 질문

<!-- 이 프로젝트를 움직이는 주요 질문을 적는다. -->

1.
2.
3.

## 범위

<!-- 포함할 것과 명시적으로 제외할 것을 적는다. -->

**포함:**
-

**제외:**
-

## 작업 논지

<!-- 현재 작업 가설이나 결론을 적고, 프로젝트가 진행되면 갱신한다. -->

> 미정
"#;
    write_file_inner(root.join("purpose.md"), purpose_content)?;

    // wiki/index.md
    let index_content = r#"# 위키 색인

## 엔티티

## 개념

## 소스

## 쿼리

## 비교

## 종합
"#;
    write_file_inner(root.join("wiki/index.md"), index_content)?;

    // wiki/log.md
    let log_content = format!(
        r#"# 작업 로그

## {today}

- 프로젝트 생성
"#
    );
    write_file_inner(root.join("wiki/log.md"), &log_content)?;

    // wiki/overview.md
    let overview_content = r#"---
type: overview
title: 프로젝트 개요
tags: []
related: []
---

# 프로젝트 개요

<!-- 이 위키가 다루는 범위와 현재 상태를 고수준으로 요약한다. 이해가 깊어질수록 정기적으로 갱신한다. -->
"#;
    write_file_inner(root.join("wiki/overview.md"), overview_content)?;

    // .obsidian config for Obsidian compatibility
    fs::create_dir_all(root.join(".obsidian"))
        .map_err(|e| format!("Failed to create .obsidian: {}", e))?;

    // Obsidian app config: set attachment folder, exclude hidden dirs
    let obsidian_app_config = r#"{
  "attachmentFolderPath": "raw/assets",
  "userIgnoreFilters": [
    ".cache",
    ".llm-wiki",
    ".superpowers"
  ],
  "useMarkdownLinks": false,
  "newLinkFormat": "shortest",
  "showUnsupportedFiles": false
}"#;
    write_file_inner(root.join(".obsidian/app.json"), obsidian_app_config)?;

    // Obsidian appearance: dark mode
    let obsidian_appearance = r#"{
  "baseFontSize": 16,
  "theme": "obsidian"
}"#;
    write_file_inner(root.join(".obsidian/appearance.json"), obsidian_appearance)?;

    // Enable graph view and backlinks core plugins
    let obsidian_core_plugins = r#"{
  "file-explorer": true,
  "global-search": true,
  "graph": true,
  "backlink": true,
  "tag-pane": true,
  "page-preview": true,
  "outgoing-link": true,
  "starred": true
}"#;
    write_file_inner(
        root.join(".obsidian/core-plugins.json"),
        obsidian_core_plugins,
    )?;

    Ok(WikiProject {
        name,
        // Forward slashes for cross-platform consistency in the TS layer.
        path: root.to_string_lossy().replace('\\', "/"),
    })
}

#[tauri::command]
pub fn open_project(path: String) -> Result<WikiProject, String> {
    run_guarded("open_project", || {
        let root = Path::new(&path);

        if !root.exists() {
            return Err(format!("Path does not exist: '{}'", path));
        }
        if !root.is_dir() {
            return Err(format!("Path is not a directory: '{}'", path));
        }

        // Validate that this looks like a wiki project
        if !root.join("schema.md").exists() {
            return Err(format!(
                "Not a valid wiki project (missing schema.md): '{}'",
                path
            ));
        }
        if !root.join("wiki").is_dir() {
            return Err(format!(
                "Not a valid wiki project (missing wiki/ directory): '{}'",
                path
            ));
        }

        // Derive project name from the directory name
        let name = root
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("Unknown")
            .to_string();

        Ok(WikiProject {
            name,
            // Forward slashes for cross-platform consistency in the TS layer.
            path: path.replace('\\', "/"),
        })
    })
}

fn write_file_inner(path: std::path::PathBuf, contents: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| {
            format!(
                "Failed to create parent dirs for '{}': {}",
                path.display(),
                e
            )
        })?;
    }
    fs::write(&path, contents)
        .map_err(|e| format!("Failed to write file '{}': {}", path.display(), e))
}

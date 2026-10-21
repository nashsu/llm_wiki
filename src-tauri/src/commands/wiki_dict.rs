//! Scan wiki pages and extract terminology for the Qingjian input method.
//!
//! Produces weighted Han-only terms (page stem > aliases > wikilinks >
//! headings > prose collocations > bold). Collocations ("四线通信" repeated in
//! prose) are mined by level-wise n-gram counting over the whole corpus. The
//! pinyin column and TSV writing happen on the TS side
//! (`src/lib/wiki-dict-export.ts`), which uses pinyin-pro for word-level
//! polyphone disambiguation.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;
use walkdir::WalkDir;

use crate::panic_guard::run_guarded;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiTerm {
    pub text: String,
    pub weight: u32,
}

const MAX_TERMS: usize = 5000;
const MAX_FILE_BYTES: u64 = 8 * 1024 * 1024;
const WEIGHT_STEM: u32 = 5000;
const WEIGHT_ALIAS: u32 = 4000;
/// 文件名含非 Han 字符（`LPTIM定时器.md`）时，两端裁剪后往往只剩通用词
/// （「定时器」），降档免得它顶掉真正的行话。
const WEIGHT_STEM_MIXED: u32 = 3000;
const WEIGHT_LINK: u32 = 2000;
const WEIGHT_HEADING: u32 = 1500;
const WEIGHT_PHRASE: u32 = 1000;
/// 搭配每多出现一次的上浮量，让同档内的高频术语排到低频之前。
const PHRASE_COUNT_STEP: u32 = 10;
/// 搭配权重上限，压在标题档（1500）之下，避免行话反超结构化词条。
const WEIGHT_PHRASE_MAX: u32 = 1490;
const WEIGHT_BOLD: u32 = 800;
const MIN_TERM_CHARS: usize = 2;
const MAX_TERM_CHARS: usize = 12;
/// 一个搭配至少在语料里出现这么多次才算行话，压随机重复的噪音。
const MIN_PHRASE_COUNT: u32 = 3;
const MAX_PHRASE_CHARS: usize = 6;
const MAX_PHRASES: usize = 1500;
/// 语料 Han 字符上限，防超大 wiki 把内存吃爆；逐级计数本来就便宜。
const CORPUS_HAN_LIMIT: usize = 2_000_000;

const STOPWORDS: &[&str] = &[
    "的", "了", "和", "与", "或", "及", "等", "中", "在", "为", "对", "从", "到", "被", "把",
    "是", "有", "不", "也", "就", "都", "还", "更", "最", "可以", "以及", "因为", "所以",
    "但是", "如果", "然后", "这个", "那个", "什么", "怎么", "如何", "我们", "你们", "他们",
    "它们", "其中", "之后", "之前", "以上", "以下", "例如", "参考", "相关", "注意", "说明",
    "概述", "简介", "目录", "附录", "背景", "总结", "结论", "问题", "其他", "另外", "同时",
    "当前", "使用", "方法", "步骤",
];

#[tauri::command]
pub async fn scan_wiki_terms(project_path: String) -> Result<Vec<WikiTerm>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        run_guarded("scan_wiki_terms", || scan(&project_path))
    })
    .await
    .map_err(|e| format!("scan_wiki_terms join error: {e}"))?
}

/// Qingjian user dictionary folder, matching its own platform layout.
/// Windows: %APPDATA%\Qingjian\dicts (see qingjian docs/user/help/data-and-logs.md).
#[tauri::command]
pub fn qingjian_dict_target() -> Option<String> {
    qingjian_dicts_dir().map(|p| p.to_string_lossy().into_owned())
}

fn qingjian_dicts_dir() -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        return std::env::var_os("APPDATA")
            .map(PathBuf::from)
            .map(|d| d.join("Qingjian").join("dicts"));
    }
    #[cfg(target_os = "macos")]
    {
        return std::env::var_os("HOME").map(PathBuf::from).map(|d| {
            d.join("Library")
                .join("Application Support")
                .join("Qingjian")
                .join("dicts")
        });
    }
    #[cfg(target_os = "linux")]
    {
        let base = std::env::var_os("XDG_DATA_HOME")
            .map(PathBuf::from)
            .filter(|p| p.is_absolute())
            .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local/share")))?;
        return Some(base.join("qingjian").join("dicts"));
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        return None;
    }
}

fn scan(project_path: &str) -> Result<Vec<WikiTerm>, String> {
    let wiki = Path::new(project_path).join("wiki");
    if !wiki.is_dir() {
        return Ok(Vec::new());
    }
    let mut best: HashMap<String, u32> = HashMap::new();
    // 整个 wiki 的净化正文（代码块/行内代码已剔除），搭配提取的全局语料。
    let mut corpus = String::new();
    for entry in WalkDir::new(&wiki)
        .into_iter()
        .filter_entry(|e| {
            if e.depth() == 0 {
                return true;
            }
            let name = e.file_name().to_string_lossy();
            e.file_type().is_file() || !(name.starts_with('.') || name == "media")
        })
        .filter_map(Result::ok)
    {
        if !entry.file_type().is_file() {
            continue;
        }
        let path = entry.path();
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        if name.starts_with('.') {
            continue;
        }
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .map(str::to_ascii_lowercase)
            .unwrap_or_default();
        if ext != "md" {
            continue;
        }
        if entry
            .metadata()
            .map(|m| m.len() > MAX_FILE_BYTES)
            .unwrap_or(false)
        {
            continue;
        }
        if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
            // 纯 Han 文件名（`低功耗定时器.md`）原样顶权；含字母/数字的
            // （`LPTIM定时器.md`）裁完只剩通用后缀，降档。
            let weight = if stem.chars().all(is_han) {
                WEIGHT_STEM
            } else {
                WEIGHT_STEM_MIXED
            };
            push_term(&mut best, stem, weight);
        }
        let Ok(content) = fs::read_to_string(path) else {
            continue;
        };
        // 少数编辑器（记事本另存 UTF-8）会在开头写 BOM，先剥掉，
        // 否则首行 `\u{FEFF}---` 认不出 frontmatter，title/aliases 全丢。
        let content = content.strip_prefix('\u{FEFF}').unwrap_or(&content);
        if let Some((front, body)) = split_frontmatter(content) {
            parse_frontmatter(&front, &mut best);
            extract_body(&body, &mut best, &mut corpus);
        } else {
            extract_body(content, &mut best, &mut corpus);
        }
    }
    extract_phrases(&corpus, &mut best);
    let mut terms: Vec<WikiTerm> = best
        .into_iter()
        .map(|(text, weight)| WikiTerm { text, weight })
        .collect();
    terms.sort_by(|a, b| {
        b.weight
            .cmp(&a.weight)
            .then_with(|| a.text.chars().count().cmp(&b.text.chars().count()))
            .then_with(|| a.text.cmp(&b.text))
    });
    terms.truncate(MAX_TERMS);
    Ok(terms)
}

fn split_frontmatter(content: &str) -> Option<(String, String)> {
    let mut lines = content.lines();
    if lines.next()?.trim_end() != "---" {
        return None;
    }
    let mut front: Vec<&str> = Vec::new();
    loop {
        match lines.next() {
            Some(line) if line.trim_end() == "---" => {
                let body = lines.collect::<Vec<_>>().join("\n");
                return Some((front.join("\n"), body));
            }
            Some(line) => front.push(line),
            None => return None,
        }
    }
}

fn parse_frontmatter(front: &str, best: &mut HashMap<String, u32>) {
    let mut in_aliases = false;
    for line in front.lines() {
        let trimmed = line.trim();
        if let Some(rest) = trimmed.strip_prefix("aliases:") {
            in_aliases = true;
            let rest = rest.trim();
            if rest.starts_with('[') && rest.ends_with(']') && rest.len() >= 2 {
                for item in rest[1..rest.len() - 1].split(',') {
                    push_term(best, item, WEIGHT_ALIAS);
                }
            }
        } else if in_aliases && trimmed.starts_with("- ") {
            push_term(best, &trimmed[2..], WEIGHT_ALIAS);
        } else if let Some(rest) = trimmed.strip_prefix("title:") {
            in_aliases = false;
            push_term(best, rest.trim(), WEIGHT_ALIAS);
        } else if !trimmed.starts_with('-') && !trimmed.is_empty() {
            in_aliases = false;
        }
    }
}

fn extract_body(body: &str, best: &mut HashMap<String, u32>, corpus: &mut String) {
    let mut fence: Option<&str> = None;
    for line in body.lines() {
        let trimmed = line.trim_start();
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            let marker = &trimmed[..3];
            match fence {
                None => fence = Some(marker),
                Some(open) if open == marker => fence = None,
                _ => {}
            }
            continue;
        }
        if fence.is_some() {
            continue;
        }
        let cleaned = without_inline_code(trimmed);
        let mut heading: &str = &cleaned;
        let mut level = 0;
        while let Some(rest) = heading.strip_prefix('#') {
            heading = rest;
            level += 1;
            if level == 6 {
                break;
            }
        }
        if level > 0 && (heading.starts_with(' ') || heading.starts_with('\t')) {
            push_term(best, &heading.replace(&['*', '`'][..], " "), WEIGHT_HEADING);
        }
        // 标题行与正文行都解析行内 `[[目标]]` / `**加粗**`：标题里
        // 的双链目标（`# [[看门狗]]实战`）否则只走标题整行裁剪，全部漏掉。
        extract_links_and_bold(&cleaned, best);
        // 语料行：标题与正文都收（标题行话密度高），wikilink 保留显示文本。
        corpus.push_str(&strip_link_markers(&cleaned));
        corpus.push('\n');
    }
}

fn without_inline_code(line: &str) -> String {
    let mut out = String::with_capacity(line.len());
    for (index, segment) in line.split('`').enumerate() {
        if index % 2 == 0 {
            out.push_str(segment);
        }
    }
    out
}

fn extract_links_and_bold(line: &str, best: &mut HashMap<String, u32>) {
    let mut link_rest = line;
    while let Some(start) = link_rest.find("[[") {
        let after = &link_rest[start + 2..];
        match after.find("]]") {
            Some(end) => {
                let inner = &after[..end];
                let target = inner.split('|').next().unwrap_or(inner);
                let target = target.split('#').next().unwrap_or(target);
                push_term(best, target, WEIGHT_LINK);
                link_rest = &after[end + 2..];
            }
            None => break,
        }
    }
    let mut bold_rest = line;
    while let Some(start) = bold_rest.find("**") {
        let after = &bold_rest[start + 2..];
        match after.find("**") {
            Some(end) => {
                push_term(best, &after[..end], WEIGHT_BOLD);
                bold_rest = &after[end + 2..];
            }
            None => break,
        }
    }
}

/// 供语料用：`[[目标|显示]]` 只留显示文本，`**加粗**` 去标记；其余原样
/// （非 Han 字符本来就是 n-gram 的天然边界）。
fn strip_link_markers(line: &str) -> String {
    let mut out = String::with_capacity(line.len());
    let mut rest = line;
    while let Some(start) = rest.find("[[") {
        let after = &rest[start + 2..];
        match after.find("]]") {
            Some(end) => {
                let inner = &after[..end];
                let display = inner.rsplit('|').next().unwrap_or(inner);
                out.push_str(&rest[..start]);
                out.push_str(display);
                rest = &after[end + 2..];
            }
            None => break,
        }
    }
    out.push_str(rest);
    out.replace("**", "")
}

/// 语料里每段连续 Han 字符一个 run（标点/字母/换行天然断开）。
fn han_runs(corpus: &str) -> Vec<Vec<char>> {
    let mut runs: Vec<Vec<char>> = Vec::new();
    let mut current: Vec<char> = Vec::new();
    let mut total = 0usize;
    for c in corpus.chars() {
        if is_han(c) {
            current.push(c);
        } else if !current.is_empty() {
            total += current.len();
            runs.push(std::mem::take(&mut current));
            if total >= CORPUS_HAN_LIMIT {
                return runs;
            }
        }
    }
    if !current.is_empty() {
        runs.push(current);
    }
    runs
}

/// 数所有 n-gram；`require_prefix` 非空时只数前缀 (n-1)-gram 已存活的位置
/// （高频 n-gram 的前缀必然高频，逐级剪枝，内存只装得下真候选）。
fn count_ngrams(
    runs: &[Vec<char>],
    n: usize,
    require_prefix: Option<&HashSet<String>>,
) -> HashMap<String, u32> {
    let mut counts: HashMap<String, u32> = HashMap::new();
    for run in runs {
        if run.len() < n {
            continue;
        }
        for start in 0..=run.len() - n {
            if let Some(set) = require_prefix {
                let prefix: String = run[start..start + n - 1].iter().collect();
                if !set.contains(&prefix) {
                    continue;
                }
            }
            let gram: String = run[start..start + n].iter().collect();
            *counts.entry(gram).or_insert(0) += 1;
        }
    }
    counts
}

/// 搭配短语的噪音判定。「的/了」是纯语法字，术语内部不会有，出现在任何
/// 位置都是噪音；其余单字虚词（从/中/等）在术语内部真实存在（主从、中断），
/// 只有落在首尾才是虚词边界；多字停用词子串在哪都是噪音。
fn phrase_is_noise(gram: &str) -> bool {
    let chars: Vec<char> = gram.chars().collect();
    let first = chars[0];
    let last = chars[chars.len() - 1];
    for stop in STOPWORDS {
        let mut it = stop.chars();
        match (it.next(), it.next()) {
            (Some(c), None) => {
                if c == '的' || c == '了' {
                    if chars.contains(&c) {
                        return true;
                    }
                } else if c == first || c == last {
                    return true;
                }
            }
            _ => {
                if gram.contains(stop) {
                    return true;
                }
            }
        }
    }
    false
}

/// 从全 wiki 净化语料里挖 2-6 字搭配短语（"四线通信"），按 WEIGHT_PHRASE 入表。
///
/// 逐级计数：2-gram 先过 MIN_PHRASE_COUNT 阈值，之后每级只在前缀存活的
/// 位置数更长 gram。收尾两道清洗：虚词噪音（见 [`phrase_is_noise`]）；
/// 只作为更长搭配子串出现（频次相等）的短 gram 被长词覆盖，不单独导出。
fn extract_phrases(corpus: &str, best: &mut HashMap<String, u32>) {
    let runs = han_runs(corpus);
    if runs.is_empty() {
        return;
    }
    let mut level = count_ngrams(&runs, 2, None);
    level.retain(|_, count| *count >= MIN_PHRASE_COUNT);
    let mut frequent: HashMap<String, u32> = level.clone();
    for n in 3..=MAX_PHRASE_CHARS {
        if level.is_empty() {
            break;
        }
        let prev: HashSet<String> = level.keys().cloned().collect();
        level = count_ngrams(&runs, n, Some(&prev));
        level.retain(|_, count| *count >= MIN_PHRASE_COUNT);
        for (gram, count) in &level {
            frequent.insert(gram.clone(), *count);
        }
    }
    let mut candidates: Vec<(String, u32)> = frequent
        .into_iter()
        .filter(|(gram, _)| {
            let chars = gram.chars().count();
            (MIN_TERM_CHARS..=MAX_PHRASE_CHARS).contains(&chars) && !phrase_is_noise(gram)
        })
        .collect();
    // 长的先收；短 gram 频次与某个包含它的已收长 gram 相等 ⇒ 它只出现在
    // 长词里，单独导出只会稀释候选。频次更大说明还有独立出现，保留。
    candidates.sort_by(|a, b| {
        b.0.chars()
            .count()
            .cmp(&a.0.chars().count())
            .then_with(|| b.1.cmp(&a.1))
            .then_with(|| a.0.cmp(&b.0))
    });
    let mut accepted: Vec<(String, u32)> = Vec::new();
    for (gram, count) in candidates {
        let dominated = accepted.iter().any(|(long, long_count)| {
            long.chars().count() > gram.chars().count()
                && *long_count == count
                && long.contains(&gram)
        });
        if !dominated {
            accepted.push((gram, count));
        }
    }
    accepted.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    accepted.truncate(MAX_PHRASES);
    for (gram, count) in accepted {
        push_term(best, &gram, phrase_weight(count));
    }
}

/// 搭配权重：基础 WEIGHT_PHRASE + 出现次数上浮，封顶 WEIGHT_PHRASE_MAX。
/// 不做上浮的话，出现 100 次和 3 次的搭配在词库里完全同权。
fn phrase_weight(count: u32) -> u32 {
    WEIGHT_PHRASE
        .saturating_add(count.saturating_mul(PHRASE_COUNT_STEP))
        .min(WEIGHT_PHRASE_MAX)
}

fn is_han(c: char) -> bool {
    matches!(c as u32, 0x4E00..=0x9FFF | 0x3400..=0x4DBF)
}

fn push_term(best: &mut HashMap<String, u32>, raw: &str, weight: u32) {
    let trimmed = raw.trim();
    let stripped = trimmed.trim_matches(|c: char| !is_han(c));
    let count = stripped.chars().count();
    if count < MIN_TERM_CHARS || count > MAX_TERM_CHARS {
        return;
    }
    if !stripped.chars().all(is_han) {
        return;
    }
    if STOPWORDS.contains(&stripped) {
        return;
    }
    let entry = best.entry(stripped.to_string()).or_insert(0);
    if *entry < weight {
        *entry = weight;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp_root(tag: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "llm-wiki-wiki-dict-{tag}-{}",
            std::process::id()
        ))
    }

    #[test]
    fn scan_extracts_weighted_terms_and_skips_noise() {
        let root = temp_root("scan");
        let _ = fs::remove_dir_all(&root);
        let wiki = root.join("wiki");
        fs::create_dir_all(wiki.join("media")).unwrap();
        fs::write(wiki.join("media").join("pic.md"), "# 图片说明\n").unwrap();
        fs::write(
            wiki.join("低功耗定时器.md"),
            "---\ntitle: 低功耗定时\ntitle_bad: 忽略\naliases:\n  - 低功定时\n  - LPTIM 定时器\n---\n# 低功耗定时器\n\n正文 [[看门狗|狗]] 和 [[低功耗定时器#章节|显]]，**唤醒源**，以及 `寄存器RCC` 代码。\n\n```\n# 代码块标题\n**不应出现**\n[[也不出现]]\n```\n\n## 方法\n",
        )
        .unwrap();
        let terms = scan(root.to_str().unwrap()).unwrap();
        let weight = |text: &str| terms.iter().find(|t| t.text == text).map(|t| t.weight);
        assert_eq!(weight("低功耗定时器"), Some(WEIGHT_STEM));
        assert_eq!(weight("低功定时"), Some(WEIGHT_ALIAS));
        assert_eq!(weight("低功耗定时"), Some(WEIGHT_ALIAS));
        assert_eq!(weight("看门狗"), Some(WEIGHT_LINK));
        assert_eq!(weight("唤醒源"), Some(WEIGHT_BOLD));
        assert_eq!(weight("代码块标题"), None);
        assert_eq!(weight("不应出现"), None);
        assert_eq!(weight("也不出现"), None);
        assert_eq!(weight("方法"), None);
        assert_eq!(weight("寄存器"), None);
        assert_eq!(weight("图片说明"), None);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn scan_returns_empty_without_wiki_dir() {
        let root = temp_root("empty");
        assert!(scan(root.to_str().unwrap()).unwrap().is_empty());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn scan_extracts_repeated_prose_phrases() {
        let root = temp_root("phrase");
        let _ = fs::remove_dir_all(&root);
        let wiki = root.join("wiki");
        fs::create_dir_all(&wiki).unwrap();
        // "四线通信" ×3 进表；"线通信"/"四线" 只作为它的子串出现（频次相等）→ 被去重；
        // "主从通信" ×3 进表；含停用词子串的 gram（"如果的"）全部丢弃。
        fs::write(
            wiki.join("SPI.md"),
            "SPI 是四线通信总线。\n\n每次四线通信前要先使能时钟。\n\n四线通信的引脚为 MOSI、MISO、SCLK、CS。\n\n主从通信由主机发起。\n\n主从通信要配 CS 片选。\n\n主从通信不支持多主机。\n\n如果的配置要改三处，如果的配置要改三处，如果的配置要改三处。\n",
        )
        .unwrap();
        let terms = scan(root.to_str().unwrap()).unwrap();
        let weight = |text: &str| terms.iter().find(|t| t.text == text).map(|t| t.weight);
        // 各出现 3 次 → 基础档 + 3 × 步进。
        assert_eq!(weight("四线通信"), Some(phrase_weight(3)));
        assert_eq!(weight("主从通信"), Some(phrase_weight(3)));
        assert_eq!(weight("线通信"), None);
        assert_eq!(weight("四线"), None);
        assert!(weight("如果的").is_none());
        assert!(terms.iter().all(|t| !t.text.contains('的')));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn phrase_weight_scales_with_count_and_caps() {
        // 出现 100 次的搭配必须比 3 次的重，且都压在标题档之下。
        let hot = phrase_weight(100);
        let cold = phrase_weight(MIN_PHRASE_COUNT);
        assert!(hot > cold, "frequent phrase should outweigh rare one");
        assert_eq!(phrase_weight(u32::MAX), WEIGHT_PHRASE_MAX);
        assert!(WEIGHT_PHRASE_MAX < WEIGHT_HEADING);
    }

    #[test]
    fn scan_mixed_stem_downgrades_and_pure_stem_keeps_top_weight() {
        let root = temp_root("stem");
        let _ = fs::remove_dir_all(&root);
        let wiki = root.join("wiki");
        fs::create_dir_all(&wiki).unwrap();
        fs::write(wiki.join("低功耗定时器.md"), "正文\n").unwrap();
        fs::write(wiki.join("LPTIM定时器.md"), "正文\n").unwrap();
        let terms = scan(root.to_str().unwrap()).unwrap();
        let weight = |text: &str| terms.iter().find(|t| t.text == text).map(|t| t.weight);
        assert_eq!(weight("低功耗定时器"), Some(WEIGHT_STEM));
        // 混排文件名裁完只剩「定时器」，降档而非顶权。
        assert_eq!(weight("定时器"), Some(WEIGHT_STEM_MIXED));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn scan_strips_utf8_bom_before_frontmatter() {
        let root = temp_root("bom");
        let _ = fs::remove_dir_all(&root);
        let wiki = root.join("wiki");
        fs::create_dir_all(&wiki).unwrap();
        fs::write(
            wiki.join("看门狗.md"),
            "\u{FEFF}---\ntitle: 看门狗别名\naliases:\n  - 狗子\n---\n正文\n",
        )
        .unwrap();
        let terms = scan(root.to_str().unwrap()).unwrap();
        let weight = |text: &str| terms.iter().find(|t| t.text == text).map(|t| t.weight);
        // BOM 剥掉后 frontmatter 正常解析，title/aliases 进来。
        assert_eq!(weight("看门狗别名"), Some(WEIGHT_ALIAS));
        assert_eq!(weight("狗子"), Some(WEIGHT_ALIAS));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn scan_extracts_links_and_bold_inside_headings() {
        let root = temp_root("heading-inline");
        let _ = fs::remove_dir_all(&root);
        let wiki = root.join("wiki");
        fs::create_dir_all(&wiki).unwrap();
        // 双链目标与加粗只在标题里出现一次（正文不再提），走 n-gram 兜不住。
        fs::write(
            wiki.join("索引.md"),
            "# [[看门狗]]实战 **喂狗间隔**\n\n正文无相关内容。\n",
        )
        .unwrap();
        let terms = scan(root.to_str().unwrap()).unwrap();
        let weight = |text: &str| terms.iter().find(|t| t.text == text).map(|t| t.weight);
        assert_eq!(weight("看门狗"), Some(WEIGHT_LINK));
        assert_eq!(weight("喂狗间隔"), Some(WEIGHT_BOLD));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn push_term_merges_by_max_weight_and_bounds_length() {
        let mut best: HashMap<String, u32> = HashMap::new();
        push_term(&mut best, "看门狗", 800);
        push_term(&mut best, "看门狗", 2000);
        push_term(&mut best, "A", 5000);
        push_term(&mut best, "一二三四五六七八九十一二三四", 5000);
        push_term(&mut best, "LPTIM 定时器", 4000);
        assert_eq!(best.get("看门狗"), Some(&2000));
        assert_eq!(best.get("定时器"), Some(&4000));
        assert_eq!(best.len(), 2);
    }
}

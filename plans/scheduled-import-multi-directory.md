# Scheduled Import：多外部来源与项目级单调度器

- **状态：** Spec，尚未开始实现
- **目标版本：** 待定
- **基线：** 当前分支 `agent/fix-scheduled-import-path`，应用版本 `0.6.6`

## 1. 摘要

将 Scheduled Import 从“每个项目只能配置一个外部目录”扩展为“每个项目可以配置多个外部目录”，同时坚持以下运行模型：

- 每个项目只有一个 Scheduled Import 调度器；
- 只有当前打开的项目运行调度器；
- 项目中的所有启用目录共用一个扫描间隔；
- 每轮由调度器顺序扫描所有启用目录；
- 保留当前复制策略：外部文件先复制到项目的 `raw/sources`，再进入现有 ingest 流程；
- 不改变 Source Watch、ingest、Wiki 来源引用和项目导出的既有语义。

本方案优先选择兼容性和低风险，不引入“直接引用外部文件”模式。

---

## 2. 背景与现状审计

### 2.1 当前配置是单目录

当前数据结构：

```ts
interface ScheduledImportConfig {
  enabled: boolean
  path: string
  interval: number
  lastScan: number | null
}
```

相关文件：

- `src/stores/wiki-store.ts`
- `src/components/settings/settings-types.ts`
- `src/components/settings/settings-view.tsx`
- `src/components/settings/sections/scheduled-import-section.tsx`

### 2.2 当前运行时只有一个定时器

`src/lib/scheduled-import.ts` 使用模块级状态：

```ts
let scanTimer: ReturnType<typeof setInterval> | null = null
let scanning = false
let activeRunId = 0
```

`startScheduledImport()` 会先调用 `stopScheduledImport()`，然后立即扫描一个 `config.path`，再通过 `setInterval` 重复扫描同一路径。

### 2.3 当前复制与 ingest 流程

外部文件按相对目录结构复制到：

```text
<project>/raw/sources/scheduled-import/<relative-path>
```

然后执行：

1. 预处理；
2. 加入 ingest 队列；
3. ingest 成功入队后记录 MD5；
4. 更新项目文件树；
5. 保存扫描时间。

### 2.4 当前扫描数据库看似支持多目录，但保存会覆盖

`.llm-wiki/scheduled-import-db.json` 当前包含：

```ts
interface ImportDbStore {
  version: 1
  directories: Record<string, ImportDb>
}
```

但是 `saveImportDb()` 每次只写入当前目录，导致其他目录记录丢失。因此该结构不能直接视为已支持多目录。

---

## 3. 目标

### 3.1 功能目标

1. 一个项目可以保存零个、一个或多个外部监控目录。
2. 所有启用目录共用项目级扫描间隔。
3. 每个项目只有一个调度器；调度器顺序扫描所有启用目录。
4. 打开项目或保存设置后，调度器立即执行一轮扫描。
5. 一轮结束后再安排下一轮，禁止扫描重叠。
6. 单个目录失败不会阻止其他目录扫描。
7. 每个目录独立保存：
   - 上次扫描时间；
   - 上次错误；
   - 文件内容哈希；
   - 文件对应的项目内目标路径。
8. 保留当前复制到 `raw/sources` 后再 ingest 的策略。
9. 支持旧单目录配置和旧扫描数据库的自动迁移。

### 3.2 非功能目标

- 配置保存和迁移必须幂等。
- 多目录扫描不能产生定时器泄漏。
- 切换项目后，旧项目扫描结果不能写入新项目状态。
- 路径比较在 Windows drive-letter/UNC 路径上保持大小写不敏感。
- 同一次扫描中的目录处理顺序必须稳定、可测试。
- 所有新增用户文案必须提供英文和中文翻译。

---

## 4. 非目标

本轮不实现：

- 直接引用外部文件的零复制模式；
- 为每个目录设置不同扫描间隔；
- 同时运行多个未打开项目的后台调度器；
- 操作系统级实时 watcher；
- 外部文件删除后自动删除项目副本；
- CLI、HTTP API 或 MCP 的 Scheduled Import 配置/触发能力；
- 自动把外部目录写入 Source Watch；
- 更换 MD5 算法或重构整个 ingest cache。

---

# SDD：软件设计说明

## 5. 核心设计决策

### 5.1 一个项目一个调度器

运行关系：

```text
当前项目
└── ScheduledImportScheduler
    └── 每轮扫描
        ├── Directory A
        ├── Directory B
        └── Directory C
```

目录按配置数组顺序执行。第一版不并发扫描目录，原因是：

- 避免多个目录同时计算大量哈希；
- 避免并发复制和预处理造成 I/O 峰值；
- 避免同时向 ingest 队列写入大量任务；
- 复用现有串行 ingest 语义；
- 让取消、项目切换和测试更简单。

### 5.2 使用完成后调度，不使用固定 `setInterval`

推荐：

```ts
async function runScheduledCycle() {
  await scanAllEnabledDirectories()
  timer = setTimeout(runScheduledCycle, intervalMs)
}
```

不推荐：

```ts
setInterval(scanAllEnabledDirectories, intervalMs)
```

原因：如果一次扫描耗时超过 interval，`setInterval` 会产生重叠触发或无意义的跳过。本方案定义 interval 为“上一轮完成到下一轮开始之间的等待时间”。

### 5.3 保留复制策略

外部文件仍然复制到当前项目：

```text
external directory
    ↓ copy
<project>/raw/sources/scheduled-import/...
    ↓ preprocess + ingest
wiki outputs
```

这保证：

- Sources 页面继续只依赖 `raw/sources`；
- Wiki `sources:` 引用继续可解析；
- Read Sources Only 和项目内搜索语义不变；
- 项目 ZIP 导出仍然自包含；
- 预处理 `.cache` 不写入外部目录；
- 不需要改造 ingest queue 和 source identity。

---

## 6. 数据模型

### 6.1 配置 V2

```ts
interface ScheduledImportDirectory {
  /** 持久稳定的目录 ID；创建后不因 path 编辑而改变。 */
  id: string

  /** 用户可识别名称，默认取目录 basename。 */
  name: string

  /** 绝对路径。旧相对路径在迁移时解析为绝对路径。 */
  path: string

  /** 是否参与项目调度器的自动扫描。 */
  enabled: boolean

  /** 该目录成功完成最近一次扫描的时间。 */
  lastScan: number | null

  /** 最近一次目录级错误；下一次成功扫描后清空。 */
  lastError: string | null

  /**
   * 复制到 raw/sources/scheduled-import 下的稳定命名空间。
   * 创建后不可随 name/path 改变。
   */
  outputNamespace: string
}

interface ScheduledImportConfig {
  version: 2
  enabled: boolean
  interval: number
  directories: ScheduledImportDirectory[]
}
```

规则：

- `enabled` 是项目级总开关。
- `directory.enabled` 是目录级开关。
- 自动扫描条件为两个开关同时开启。
- `interval` 全项目共享，保存时限制在 `1..1440` 分钟。
- `id` 使用 UUID 或等价稳定随机 ID。
- `outputNamespace` 使用安全、稳定且可读的值，例如：

```text
readlatervault-a1b2c3
```

其唯一性必须在当前项目配置中得到保证。

### 6.2 扫描数据库 V2

```ts
interface ImportFileRecord {
  md5: string
  /** 项目内绝对目标路径，便于稳定处理重命名和冲突。 */
  destinationPath: string
}

interface ImportDirectoryDb {
  pathKey: string
  files: Record<string, ImportFileRecord>
  lastScan: number | null
}

interface ImportDbStore {
  version: 2
  directories: Record<string, ImportDirectoryDb> // key = directory.id
}
```

文件位置保持不变：

```text
<project>/.llm-wiki/scheduled-import-db.json
```

V2 保存必须执行 read-modify-write，只更新当前目录 ID 对应的记录，不得覆盖其他目录。

---

## 7. 目标目录布局与冲突处理

### 7.1 新目录布局

不同外部根目录必须拥有独立命名空间：

```text
raw/sources/scheduled-import/
├── readlatervault-a1b2c3/
│   └── notes/article.md
└── papers-d4e5f6/
    └── notes/article.md
```

目标路径：

```ts
destination =
  `${project}/raw/sources/scheduled-import/` +
  `${directory.outputNamespace}/` +
  `${safeRelativePath}`
```

这样两个目录中相同的相对路径不会互相覆盖。

### 7.2 outputNamespace 规则

- 基于初始目录 basename 生成可读 slug；
- 添加基于目录 ID 的短后缀；
- 使用现有 Windows 路径保留名清理规则；
- 在同一项目内必须唯一；
- 用户修改目录名称或路径后不得改变；
- 不使用绝对路径作为来源身份，避免泄漏本机目录结构。

### 7.3 旧目录输出兼容

从 V1 迁移的唯一目录使用：

```ts
outputNamespace: ""
```

从而继续使用旧布局：

```text
raw/sources/scheduled-import/<relative-path>
```

后续新增目录必须使用非空 namespace。

`outputNamespace === ""` 只允许出现在迁移得到的一个 legacy directory 中。这样可以避免升级时移动旧文件、改写 Wiki `sources:` 引用或触发全量重新 ingest。

如果新增目录的 namespaced 目标与 legacy 目录已有目标冲突，必须检测并生成新的唯一 namespace，不得覆盖已有文件。

---

## 8. 路径验证

每个目录在添加、编辑和保存时都必须验证。

### 8.1 无效路径

以下路径无效：

1. 空字符串；
2. 不存在；
3. 不是目录；
4. 等于当前项目根目录；
5. 位于当前项目内部；
6. 包含当前项目；
7. 与另一个 Monitor Directory 相同；
8. 位于另一个 Monitor Directory 内；
9. 包含另一个 Monitor Directory。

父子监控目录被禁止，避免同一文件被两次扫描和复制。

### 8.2 路径关系文案

UI 必须区分：

```text
Inside current project
Contains current project
Duplicates another monitored directory
Overlaps another monitored directory
Directory does not exist
```

不得继续用一个“inside current project”文案覆盖所有情况。

### 8.3 空目录列表行为

- 新项目的目录列表默认为空数组；
- 空列表是合法配置，但无法开启 Scheduled Import；
- 添加目录必须通过目录选择器或合法绝对路径输入完成。

### 8.4 路径规范化

- 路径持久化前统一路径分隔符；
- Windows drive-letter 和 UNC 比较大小写不敏感；
- macOS/Linux 默认大小写敏感，保持当前行为；
- 路径边界按 segment 判断，`/foo/bar` 不得匹配 `/foo/bar2`。

符号链接 canonicalization 可通过一个后端路径解析命令实现；如果本轮不实现，必须作为已知限制记录，不能声称已防止符号链接绕过。

---

## 9. 调度器设计

### 9.1 模块状态

```ts
interface SchedulerState {
  projectId: string | null
  runId: number
  timer: ReturnType<typeof setTimeout> | null
  running: boolean
  rerunRequested: boolean
}
```

继续允许模块级单例，因为应用在任意时刻只有一个当前打开项目。

### 9.2 启动

`startScheduledImport(project, config)`：

1. 停止旧调度器；
2. 增加 `runId`；
3. 如果项目级开关关闭、无启用目录或 interval 非法，则返回；
4. 立即启动一次 `runCycle()`；
5. `runCycle()` 完成后安排下一次 `setTimeout`。

### 9.3 每轮扫描

```ts
async function runCycle(project, config, runId) {
  for (const directory of enabledDirectories(config)) {
    if (!isCurrentRun(project.id, runId)) return

    try {
      await scanDirectory(project, directory, { runId })
      clearDirectoryError(directory.id)
    } catch (error) {
      saveDirectoryError(directory.id, error)
    }
  }
}
```

要求：

- 顺序与配置数组一致；
- 一个目录失败后继续下一个；
- 项目切换或停止后尽快退出；
- 被禁用目录不扫描；
- 扫描列表在一轮开始时创建快照，设置变更在下一轮生效。

### 9.4 手动扫描

UI 提供：

- `Scan All Now`：顺序扫描所有启用目录；
- 每个目录行的 `Scan Now`：只扫描该目录。

如果自动扫描正在运行：

- 不并发启动第二次扫描；
- 设置 `rerunRequested = true`；
- 当前轮完成后最多追加一轮；
- 多次点击合并成一次追加扫描。

### 9.5 停止与项目切换

`stopScheduledImport()`：

- 增加 `runId`；
- 清除 timer；
- 清除 rerun 标记；
- 不强制终止已经进入 LLM ingest queue 的任务；
- 正在扫描的目录在下一次 run/project guard 处退出。

切换项目时必须先 stop，再保存旧项目配置，再加载和启动新项目配置。

---

## 10. 单目录扫描流程

将现有 `scanAndImport(project, importPath)` 拆分为职责清晰的函数：

```ts
scanScheduledImportDirectory(
  project,
  directory,
  options,
): Promise<DirectoryScanResult>
```

建议返回：

```ts
interface DirectoryScanResult {
  directoryId: string
  scannedAt: number
  discovered: number
  unchanged: number
  copied: number
  queued: number
  skipped: number
  failed: number
}
```

流程：

1. 再次验证目录与当前项目的关系；
2. 递归枚举文件；
3. 跳过隐藏、内部、配置类、不支持和超大文件；
4. 读取该 directory ID 的扫描数据库；
5. 计算文件 MD5；
6. unchanged 文件保留原记录；
7. changed/new 文件复制到稳定目标路径；
8. 对目标文件预处理；
9. 批量加入 ingest queue；
10. 只有成功加入 ingest queue 的文件才更新 md5；
11. 合并保存该目录数据库；
12. 更新该目录 `lastScan` / `lastError`；
13. 刷新项目文件树。

### 10.1 删除语义

保持当前行为：

- 外部文件删除后，从下一版目录扫描数据库的 active file map 中移除；
- 已复制到 `raw/sources` 的文件不自动删除；
- 已生成 Wiki 内容不自动删除；
- UI 继续明确提示这一行为。

### 10.2 失败语义

- 单文件读取失败：记录计数并继续该目录其他文件；
- 目录不可访问：该目录失败，继续下一个目录；
- LLM 未配置或 enqueue 返回空：不得把文件标记为已导入；
- 数据库写入失败：该目录扫描视为失败，下轮允许重试；
- 项目切换：不得写入 stale config/store 状态。

---

## 11. 配置与数据库迁移

### 11.1 V1 配置到 V2

旧配置：

```ts
{
  enabled,
  path,
  interval,
  lastScan,
}
```

迁移规则：

- `path` 为空：
  - `directories = []`；
  - `enabled = false`。
- `path` 非空：
  - 创建一个 directory；
  - `directory.enabled = true`；
  - `directory.lastScan = old.lastScan`；
  - `directory.outputNamespace = ""`；
  - 相对路径解析为相对项目根的绝对路径；
  - 保留原项目级 `enabled` 和规范化后的 interval。

迁移后立即保存 V2，后续加载必须保持幂等，不得重复生成目录 ID。

### 11.2 V1 DB 到 V2

旧 DB 以路径为 key。迁移时：

- 找到与迁移目录规范化路径相同的记录；
- 把目录 key 改为 directory ID；
- 把 `files[path] = md5` 转成：

```ts
files[path] = {
  md5,
  destinationPath: legacyDestinationFor(path),
}
```

- 其他无法匹配当前配置的旧路径记录可以保留在 `orphanedDirectories`，或在备份后忽略；不得误配到新目录。

写 V2 前应保留原文件的可恢复备份，或者使用原子写入确保失败不会破坏 V1 数据。

---

## 12. UI/UX 设计

### 12.1 页面结构

```text
Scheduled Import

[ ] Enable scheduled import

Monitor Directories
┌─────────────────────────────────────────────────────┐
│ [✓] ReadLaterVault                                  │
│     /Users/.../ReadLaterVault                       │
│     Last scan: ...                    [Scan] [Remove]│
└─────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────┐
│ [✓] Papers                                          │
│     /Volumes/Data/Papers                            │
│     Error: Directory unavailable      [Scan] [Remove]│
└─────────────────────────────────────────────────────┘

[+ Add Directory]

Scan Interval (minutes): [60]
[Scan All Now]
```

### 12.2 交互规则

- 初始目录列表为空；
- `Add Directory` 打开单目录选择器；
- 添加重复/父子重叠目录时不加入列表并显示具体原因；
- 删除目录只删除配置和扫描元数据，不删除已经复制的项目文件；
- 删除前文案明确说明项目副本仍保留；
- 总开关开启但没有启用目录时，Save 必须阻止或自动关闭总开关；
- 路径无效时该目录显示 inline error，不能开启自动扫描；
- 保存设置后重启当前项目调度器；
- Scan All/Scan 单目录必须展示扫描中状态并防止重复点击产生并发。

---

## 13. 持久化与状态边界

### 13.1 持久化

配置继续按项目路径保存：

```text
scheduledImportConfig:<normalized-project-path>
```

扫描数据库继续保存在项目目录中：

```text
.llm-wiki/scheduled-import-db.json
```

### 13.2 Store 状态

Zustand store 保存当前项目的 V2 config。目录扫描完成时必须通过 directory ID 更新对应条目，不得使用扫描开始时的整个旧 config 覆盖用户在扫描期间的其他设置变更。

应提供类似函数：

```ts
updateScheduledImportDirectoryStatus(
  directoryId,
  patch: Pick<ScheduledImportDirectory, "lastScan" | "lastError">,
)
```

并对持久化配置执行同样的 read-modify-write。

---

## 14. 文件级改动范围

预计主要修改：

| 文件 | 修改内容 |
|---|---|
| `src/stores/wiki-store.ts` | V2 配置与目录类型、默认值、更新 action |
| `src/components/settings/settings-types.ts` | 多目录 draft 类型 |
| `src/components/settings/settings-view.tsx` | V2 draft、保存、加载、调度器重启 |
| `src/components/settings/sections/scheduled-import-section.tsx` | 目录列表、添加/删除、验证、单项扫描、Scan All |
| `src/lib/project-store.ts` | V1→V2 配置迁移与规范化 |
| `src/lib/scheduled-import.ts` | 项目级调度器、多目录顺序扫描、V2 DB、目标命名空间 |
| `src/App.tsx` | 项目打开后的 V2 hydrate/start |
| `src/i18n/en.json` | 英文文案 |
| `src/i18n/zh.json` | 中文文案 |
| `src/lib/scheduled-import.test.ts` | 单元与集成测试扩展 |

必要时新增：

- `src/lib/scheduled-import-config.ts`：配置规范化、迁移与路径关系纯函数；
- `src/lib/scheduled-import-scheduler.ts`：如果 `scheduled-import.ts` 过大，可拆出调度器；
- `src/components/settings/sections/scheduled-import-directory-row.tsx`：目录行组件。

---

## 15. 可观测性

日志必须包含 project ID、directory ID 和路径：

```text
[scheduled-import] cycle start project=<id> directories=2
[scheduled-import] directory start id=<id> path=<path>
[scheduled-import] directory complete id=<id> copied=3 queued=3 skipped=5
[scheduled-import] directory failed id=<id> error=<message>
[scheduled-import] cycle complete project=<id> durationMs=...
```

Activity Panel 至少显示：

- 目录扫描失败；
- 被拒绝的项目内/包含项目路径；
- 大文件跳过汇总；
- LLM 未配置导致未入队；
- 一轮扫描新增/变更文件数量。

不得把完整文件内容、API key 或配置文件内容写入日志。

---

# TDD：测试驱动开发说明

## 16. TDD 实施顺序

严格按以下顺序推进：

1. 先为 V2 类型规范化和 V1 迁移写失败测试；
2. 实现最小配置迁移；
3. 为路径关系与多目录重叠写失败测试；
4. 实现纯路径验证函数；
5. 为目标 namespace 和 destination 写失败测试；
6. 实现稳定目标路径；
7. 为 V2 DB 合并保存和迁移写失败测试；
8. 实现 DB read-modify-write；
9. 为单目录扫描提取写失败测试；
10. 实现单目录 scanner；
11. 使用 fake timers 为项目级调度器写失败测试；
12. 实现单调度器顺序执行；
13. 为 UI draft/交互写组件测试；
14. 实现 UI；
15. 添加跨模块集成测试；
16. 最后运行全量 typecheck、unit tests 和 desktop build。

每一步只实现让当前失败测试通过的最小代码，再重构。

---

## 17. 单元测试

### 17.1 配置规范化与迁移

测试文件建议：

```text
src/lib/scheduled-import-config.test.ts
```

用例：

1. V2 配置规范化后保持相同目录 ID。
2. interval 小于 1 时变为 1。
3. interval 大于 1440 时变为 1440。
4. V1 空 path 迁移为空目录列表并关闭总开关。
5. V1 绝对 path 迁移为一个启用目录。
6. V1 相对 path 按项目根解析为绝对路径。
7. V1 `lastScan` 迁移到目录。
8. V1 目录获得 `outputNamespace = ""`。
9. 重复加载已迁移配置不会生成新 ID。
10. 缺失字段得到安全默认值。

### 17.2 路径关系

用例：

1. 项目根目录被拒绝。
2. 项目内子目录被拒绝。
3. 包含项目的父目录被拒绝。
4. 项目兄弟目录被接受。
5. `/foo/bar` 与 `/foo/bar2` 不被误判为父子关系。
6. 相同 monitor path 被拒绝。
7. 新目录位于已有目录内时被拒绝。
8. 新目录包含已有目录时被拒绝。
9. Windows drive-letter 路径大小写不敏感。
10. UNC 路径大小写不敏感。
11. macOS/Linux 路径保持大小写敏感。
12. trailing slash 不影响比较。

### 17.3 Namespace 与目标路径

用例：

1. 相同 basename 的两个目录得到不同 namespace。
2. 修改目录 name/path 后 namespace 不变。
3. Windows 保留名得到安全 namespace。
4. 嵌套相对路径得到正确目标路径。
5. 两个目录中相同 `notes/a.md` 得到不同目标路径。
6. legacy `outputNamespace = ""` 保持旧目标路径。
7. 非法路径 segment 使用稳定后缀清理。
8. namespace 冲突时生成稳定唯一值。

### 17.4 扫描数据库

用例：

1. 空 DB 返回 V2 empty store。
2. 保存目录 A 后再保存目录 B，A 记录仍存在。
3. 更新目录 A 不改变目录 B。
4. V1 path-keyed DB 正确迁移到 directory ID。
5. V1 md5 字符串正确转换为 ImportFileRecord。
6. Windows 混合大小写旧 key 可以复用。
7. 无效 JSON 返回安全空 store，并记录 warning。
8. 原子写失败不产生部分 JSON。

### 17.5 单目录扫描

继承并扩展现有测试：

1. 递归扫描嵌套文件。
2. unchanged MD5 不复制、不 enqueue。
3. 新文件复制到目录 namespace 下。
4. changed 文件覆盖自己的稳定目标路径。
5. 两个外部根的同名文件不会互相覆盖。
6. 单文件读取失败后继续其他文件。
7. 大于 100 MB 文件在 hash/copy 前跳过。
8. 隐藏文件跳过。
9. JSON/YAML/XML 无人值守配置文件跳过。
10. 不支持扩展名跳过。
11. enqueue 失败时不更新 indexed MD5。
12. LLM 未配置时不更新 indexed MD5。
13. 成功扫描只更新当前 directory ID 的 DB/config 状态。
14. 目录不可访问时返回目录级错误。
15. 项目 runId 失效后不写 DB/store。
16. 外部文件删除不删除项目副本。

---

## 18. 调度器测试

使用 Vitest fake timers，不等待真实时间。

用例：

1. `start` 会停止旧 timer。
2. 项目禁用时不创建 timer。
3. 没有启用目录时不创建 timer。
4. 启动后立即执行一轮。
5. 一轮按配置顺序扫描 A、B、C。
6. 禁用的 B 被跳过。
7. A 抛错后仍扫描 B、C。
8. 一轮未完成前不安排/启动下一轮。
9. interval 从上一轮完成后开始计算。
10. 连续多次手动触发最多合并为一次 rerun。
11. 自动扫描与手动扫描不会并发。
12. `stop` 清除 timer 并使旧 runId 失效。
13. 项目 A 切换到项目 B 后，A 不再继续扫描。
14. A 的迟到结果不能更新 B 的 store。
15. 保存新配置后只存在一个 timer。
16. fake timer 推进多轮后 timer 数量始终为 1。

---

## 19. UI 组件测试

用例：

1. 新项目初始目录列表为空。
2. Add Directory 添加一个外部目录。
3. 重复目录显示明确错误且不添加。
4. 项目内部目录显示 Inside current project。
5. 项目父目录显示 Contains current project。
6. 与已有目录父子重叠时显示 Overlaps。
7. 可以启用/禁用单个目录。
8. 删除目录不调用项目源文件删除逻辑。
9. 无启用目录时不能开启并保存总开关。
10. Scan Now 只调用指定 directory ID。
11. Scan All 按启用目录执行。
12. 扫描中按钮禁用并显示状态。
13. 每个目录显示独立 lastScan/lastError。
14. 保存后调用一次 scheduler restart，而不是每个目录各启动 timer。

如果现有测试环境不适合完整渲染 Tauri dialog，应 mock `@tauri-apps/plugin-dialog`，并把目录列表行为下沉为可测试的纯 reducer/函数。

---

## 20. 集成测试

使用临时项目目录和两个临时外部目录。

### 场景 A：两个目录首次扫描

```text
external-a/notes/a.md
external-b/notes/b.md
```

期望：

- 两个文件分别复制到各自 namespace；
- 两个文件均加入 ingest queue；
- DB 同时包含 A、B；
- 两个目录均更新 lastScan。

### 场景 B：相同相对路径

```text
external-a/notes/article.md
external-b/notes/article.md
```

期望：

- 目标路径不同；
- 内容互不覆盖；
- source identity 不冲突。

### 场景 C：第二轮无变化

期望：

- 不复制；
- 不 enqueue；
- 只更新扫描时间。

### 场景 D：只有一个目录变化

修改 external-b 的一个文件。

期望：

- A 不重新复制；
- B 只处理变化文件；
- A 的 DB 不被 B 覆盖。

### 场景 E：目录失败隔离

让 external-a 不可访问，external-b 正常。

期望：

- A 写入 lastError；
- B 正常完成；
- 整轮不会因为 A 中断。

### 场景 F：V1 升级

准备旧配置、旧 DB 和旧 `scheduled-import/<relative>` 文件。

期望：

- 迁移后旧目录仍使用 legacy layout；
- 第一轮没有变化时不复制、不重新 ingest；
- 新增第二目录后使用 namespaced layout。

### 场景 G：项目切换

项目 A 扫描中切换到项目 B。

期望：

- A 调度器停止；
- A 的迟到结果不写入 B；
- B 只有一个活动调度器。

---

## 21. 回归测试

必须保证：

- 单目录用户升级后行为不变；
- 手动 Import Files/Folder 行为不变；
- Source Watch 行为不变；
- ingest queue 去重、暂停、恢复行为不变；
- Wiki 来源链接仍能打开复制后的文件；
- 项目 ZIP export/import 仍包含 Scheduled Import 的复制文件；
- Windows drive-letter 和 UNC 路径测试继续通过；
- 项目切换、重置项目状态和退出应用不会遗留 timer。

---

## 22. 验收标准

功能验收：

- [ ] 一个项目可以添加至少 10 个外部目录。
- [ ] 所有目录共用一个 interval。
- [ ] 任意时刻当前项目最多只有一个 Scheduled Import timer。
- [ ] 一轮扫描顺序处理所有启用目录。
- [ ] 两个目录出现相同相对路径时不会覆盖。
- [ ] 单目录失败不影响其他目录。
- [ ] 第二轮无变化时不会重新 ingest。
- [ ] 项目内路径、包含项目路径、重复/重叠目录均有准确提示。
- [ ] V1 配置和 DB 自动迁移，旧用户不需要重新设置目录。
- [ ] 已复制文件继续出现在 Sources 页面，并可从 Wiki 来源引用打开。

质量验收：

- [ ] `npm run typecheck` 通过。
- [ ] Scheduled Import 全部单元测试通过。
- [ ] 新增调度器 fake-timer 测试通过。
- [ ] 相关 UI 组件测试通过。
- [ ] `npm run test:mocks` 通过。
- [ ] `npm run build:desktop` 通过。
- [ ] 手动验证 macOS 至少两个外部目录。
- [ ] Windows 路径测试覆盖 drive-letter 与 UNC。

---

## 23. 实施阶段

### Phase 1：配置与路径基础

- V2 types；
- V1 config migration；
- 多目录路径验证；
- 单元测试。

### Phase 2：扫描数据库与目标命名空间

- V2 DB；
- V1 DB migration；
- read-modify-write；
- root namespace；
- 同名路径冲突测试。

### Phase 3：项目级调度器

- 提取单目录 scanner；
- 顺序扫描；
- completion-based `setTimeout`；
- failure isolation；
- manual rerun coalescing；
- fake timer 测试。

### Phase 4：设置 UI

- 目录列表；
- add/remove/enable；
- Scan/Scan All；
- lastScan/lastError；
- i18n；
- UI 测试。

### Phase 5：集成与回归

- V1 upgrade fixture；
- 多目录临时文件集成测试；
- 项目切换测试；
- typecheck/test/build；
- macOS/Windows 手工验证。

---

## 24. 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| 多目录同名相对路径 | 文件覆盖、来源串线 | 每个新目录使用稳定 output namespace |
| V1 DB 被覆盖 | 全量重复 ingest | V2 read-modify-write + 迁移测试 + 原子写 |
| 旧来源路径变化 | Wiki 引用失效 | legacy directory 保持空 namespace，不搬迁旧文件 |
| 扫描耗时超过 interval | 重叠、跳过 | 完成后 `setTimeout`，禁止并发 cycle |
| 一个目录不可访问 | 整轮中断 | 目录级 try/catch 与 lastError |
| 扫描期间切换项目 | 写错项目状态 | projectId + runId guard |
| 父子目录重复监控 | 重复复制和 ingest | 保存前拒绝重叠目录 |
| UI 状态覆盖用户新编辑 | 设置回滚 | 目录 ID 级 read-modify-write |
| 符号链接绕过路径判断 | 扫描到项目自身 | canonical path 校验或明确记录限制 |

---

## 25. 已确定的产品决策

- 使用“一个项目一个调度器”，不是“一个目录一个 timer”。
- 只调度当前打开项目。
- 所有目录共用同一个 interval。
- 目录顺序扫描，第一版不并发。
- 保留复制到 `raw/sources` 的策略。
- 外部删除不自动删除项目副本。
- 新目录使用独立输出 namespace。
- 旧单目录保持 legacy 输出路径，避免升级后全量搬迁和重建。
- Scheduled Import V2 默认目录列表为空。
- 本轮不扩展 CLI、API、MCP 或零复制模式。

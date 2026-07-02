# 金融模板与来源文件名规范化预处理

## 目标

面向金融纪要类知识库：来源文件名统一为 `yyyymmdd-<ts_code|NA>-<简称|主体>-<标题>.<ext>`，
使时间与标的锚点进入来源身份，全链路（摘要页/检索/LLM 上下文/deep-research）可见。

## 组成

1. **金融研究模板**（`templates.ts` 新增 `finance`）
   - 个股实体页 frontmatter 必带 `ts_code` / `industry`
   - schema 写明来源命名规范与时效性矛盾处理规则（同标的冲突优先最新纪要）
2. **命名引擎**（`src/lib/finance-naming.ts`，纯函数 + IO 包装）
   - 日期提取：`yyyymmdd` → `yymmdd` → `mmdd`（缺年份按参考年）三级；带月/日合法性
     校验（避免把 6 位股票代码误判为日期）；全部失败回退文件修改日期并标注
   - 个股匹配：读项目根 `stock_basic.csv`（固定约定位置；缺失则仅做日期规范化），
     name 包含匹配取最长命中；多只个股同时命中视为歧义 → 落 `NA` 行业格式，不猜
   - 无匹配格式：`yyyymmdd-NA-<清理后的原文件名主干>.<ext>`
3. **导入钩子**（`source-lifecycle.ts:importSourceFiles`）
   - 项目启用预处理时（`.llm-mwiki/source-naming.json`，建项目复选框写入），
     导入前重命名，成功后追加审计映射 `.llm-wiki/rename-map.json`
     （`original/renamed/date/dateSource/tsCode/matchedBy/importedAt`，
     仅供出错排查，运行时无消费方）
4. **建项目对话框**：选金融模板时显示"导入时规范化文件名"复选框（默认勾选）

## v1 范围外（记录备查）

- 文件夹导入 / 定时导入 / 剪藏路径暂不重命名（保结构、避免意外）
- 港股/美股基础表（可后续以同格式 CSV 追加）
- 向量库结构化元数据列（等真实检索需求）

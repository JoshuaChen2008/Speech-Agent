# 固定 recipe 与首版工具闭集冻结提案

> 性质：设计对齐记录（已冻结）。第 1 节的 13 项决定已由负责人于 2026-08-29 逐项确认，其中 D3、D4、D6、D11 在确认时被修订或授权由接管者裁决（本文件已按裁决落定）。**已于 2026-08-29 按第 9 节回填 `CONTEXT.md`、`docs/semantic-contract.md`、`docs/testing-strategy.md`、`docs/data-architecture.md` 与 `docs/research/personal-context-agent-design-draft.md`，权威口径以那四份文档为准；本文件此后只作为决定来由的记录。回填的语义状态为"已决定"，尚无实现证据，尚未进入正式实现。**
>
> 依据：`CONTEXT.md`、`docs/semantic-contract.md`（`SEM-F08/F13/F15/F16/F25/F26/F28/F30–F35`、`SEM-T07/T10/T15`）、`docs/testing-strategy.md`（`J3/J13/J21/J22/J24/J25/J26` 与第 4 节不变量）、`docs/data-architecture.md`（目标 Agent 逻辑表、第 4.2/4.3 节、第 5 节）、`docs/research/personal-context-agent-design-draft.md`、`docs/research/agent-harness-reference-notes.md`。
>
> 日期：2026-08-29
>
> 用途：交接文档待做事项 2（冻结固定 recipe 的输入/输出 Schema）与 3（冻结首版工具闭集）。本文件不重建另一套要求；第 9 节列出的语义应回填 `docs/semantic-contract.md` 与 `docs/testing-strategy.md`，schema 只能通过新的追加 migration 落地。

## 1. 已确认的决定（负责人 2026-08-29）

| 编号 | 问题 | 最终决定 |
|---|---|---|
| D1 | `CONTEXT.md` 的 Agent recipe 行与 `SEM-F16` 都只枚举"问答、分析、规划、文本转换与个人上下文摄取"五类，但 `SEM-F08` 的会后结构化纪要与 `SEM-F13` 的增强文本都是已登记独立产物，落不进这五类。 | **确认。** 在 `SEM-F16` 与 `CONTEXT.md` 的 recipe 定义中补入"摘要与总结"类别，使类别枚举与已登记产物一致；类别是分组，第 3 节的 recipe ID 闭集才是冻结对象。 |
| D2 | 分析报告在 `SEM-F08` 的分类里属于摘要，在用户可见模型用途里自然落到"分析与规划"，两种读法给出不同模型。 | **确认。** 产物分类保持"摘要"（不改 `SEM-F08`）；模型用途固定为"分析与规划"。产物分类与模型用途是两个独立维度，第 4 节映射表为唯一权威。**追加**："摘要与总结"与"分析与规划"必须能分别绑定不同档案，前者面向低成本小模型（DeepSeek / Haiku 级）；这只是用途绑定能力与 UI 提示，不硬编码任何模型。 |
| D3 | `SEM-F15/F28` 只说"确实需要只读工具的跨会话分析/规划"才走 Agent Loop，未指明哪些 recipe、何时成立。 | **修订确认（省钱优先）。** Agent Loop 不是"跨会话就开"，而是第 5.6 节的**四条件 AND 阈值**：默认单次请求，四条同时成立才升级。判定在运行创建期一次性完成并冻结。 |
| D4 | `SEM-F26` 允许"规范化关键词和别名匹配"，`docs/data-architecture.md` 第 4.3 节写"不接受自由文本"。`search_context` 到底能不能按关键词检索。 | **授权接管者裁决 → 收窄为别名等值匹配。** 不引入关键词检索：字段名由 `keywords` 改为 `aliasKeys`，语义是"对规范化语义键或已登记别名的**等值**匹配"（NFKC + casefold 后全等，非子串、非分词、非模糊、无通配符、无查询语言），≤8 项、每项 ≤64 字符。因此 `SEM-F26` 与第 4.3 节不再冲突，**第 4.3 节"不接受自由文本"无需改写**，只补一句"别名等值匹配不属于自由文本查询"。结果新增 `unmatchedAliasKeys` 回传，让模型一轮内知道哪些键没登记，避免重复试探（省钱）。 |
| D5 | `read_sources` 的返回会把字幕正文写进 `formal_agent_tool_calls.result_json`，等于第二份正文副本，而设计草案 §9 把"复制第二份正文"排除在首版之外。 | **确认，并按第 5.2.1 节分清三类正文。** 设计草案 §9 的"不复制第二份正文"指的是**不建第二份可检索知识库**，属表述遗留，需在该草案补一句澄清。交互审计中的正文副本是有界、随交互级联删除、不建索引、不参与检索、不进入个人记忆的排障证据。 |
| D6 | 现有六条预算轴不限制累计字节；`agent_jobs` 九码错误闭集没有预算超限码；工具级错误码闭集不存在。 | **确认，并修正预算轴。** 见第 5.3 节：预算轴由六轴扩为**十轴**；"省钱轴"是**累计计费 token**（跨 turn 求和），不是单次请求上限；累计来源正文字节是累计工具结果字节的**子预算**（128 KiB < 256 KiB）。向 `agent_jobs` 错误闭集追加 `AGENT_BUDGET_EXCEEDED`；登记第 5.4 节的工具错误码闭集。 |
| D7 | `formal_agent_tool_calls` 没有 `attempt` 字段；重试后旧 attempt 的工具记录保留还是删除，直接影响 `SEM-F35` 的重导出字节一致。 | **确认保留旧记录。** 表增加 `attempt`，工具记录按 `(attempt, call_order)` 全序保留，`UNIQUE(interaction_id, attempt, call_order)`；导出按同一全序编码。该字段必须在首个正式 Agent migration 内一次落地，避免二次迁移。 |
| D8 | Agent Loop 中模型在工具调用之外产生的中间 assistant 文本既不是 `reasoning` 也不是最终结果，无任何规则覆盖。 | **确认零持久化。** 中间 assistant 文本与思维链都不进入 SQLite、UI、日志、报告、导出，避免干扰记录并防止记录膨胀。**零持久化不等于不入上下文**：它仍可在内存中作为模型上下文的一部分参与本次运行。 |
| D9 | `formal_agent_interactions` 每行只有一个 `run_id` 和一个 `model_binding_id`，但 `J25` 要求模型性价比比较。 | **确认结构，首版只跑通不做评测。** 模型比较是**两条兄弟交互**：范围 digest 与输入 digest 相同、`run_id` 与模型运行绑定不同，UI 按这两个 digest 归组对照。不在一条交互内挂多个绑定。后续 eval 的零重构预留见第 7 节。 |
| D10 | 费用估算依赖价格目录 revision，若导出时重算则 `SEM-F35` 的字节一致会被价格目录更新破坏。 | **确认。** 费用估算在运行收束时一次性算出并连同 `pricing_revision`（已由 `agent_model_run_bindings` 承载）冻结写入用量事实；导出只读取冻结值，永不重算。价格目录是随应用发布的静态目录（键为 adapter + 受信任 origin 类别 + model，带整数 revision），允许每档案可选覆盖；缺少单价时 `costEstimate` 为 `null`，不得猜测，且始终标注为估算。 |
| D11 | Agent 处理资格闭集是按单个冻结输入定义的，跨会话范围如何计算；`SEM-F28` 提到"recipe 未登记"但闭集里没有对应值。 | **确认并细化到会话内粒度（见第 3.3 节）。** 剔除粒度不是整会话：会话只取已跨越字幕提交边界的已定稿内容，未定稿尾部与不完整精修按规则剔除而不排除整会话。整会话排除只在非终态、无已提交转写或命中冻结包上界时发生，并以省略标记进入个人上下文包。零个合格会话返回 `no_committed_transcript`。未登记 recipe 在创建期以 `AGENT_REQUEST_INVALID` fail closed，**不扩充资格闭集**。 |
| D12 | `SEM-F28` 要求任务可恢复，但 Agent Loop 的中途状态不可确定性重建。 | **确认为兜底方案。** Agent Loop 不做中途恢复：恢复等于**保留已有数据**（旧 attempt 的工具记录全部留存，D7）后在同一 `runId`、同一模型运行绑定、同一冻结输入下**整体重跑**，并递增 `attempt`。token / wall-clock / turn / 工具 / 字节预算按 attempt 计，`max_attempts` 约束总量。 |
| D13 | 取消后的交互是否算终态、能否导出未定义。 | **确认，并明确为协程式取消（见第 6.2 节）。** 取消信号贯穿模型请求与工具执行，工具必须在自身检查点主动配合；取消后整次运行的 runtime 收束。取消是终态：保留已发生的工具调用记录，`result` 为 `null`，`terminal_reason` 为 `cancelled`，`error_code` 为空，允许 `SEM-F35` 导出。 |

## 2. 贯穿性不变量（本轮新增，需登记）

1. **范围不可扩大**：工具的每个范围参数必须是运行开始时冻结的个人上下文包范围的子集。任何超出冻结范围的请求以 `TOOL_SCOPE_DENIED` 拒绝，不得由工具扩大 `input_watermark`、`input_digest` 或范围 digest。产物记录的输入身份必须始终等于实际可访问输入的上界。
2. **有界分页不是截断**：每个工具在注册期声明的 `maxResultBytes` 必须 ≤ 交互审计的单次结果预算，因此任何 Schema 合法的工具结果都必然可完整持久化。达到上界时返回更少的**完整**条目并置 `hasMore=true`，永不切开一个条目、一个字幕段或一个 code point。`SEM-F34` 的"不得静默截断"因此只作用于提交期：审计写入不得压缩或裁剪已返回的正文。
3. **工具只读**：首版没有任何写工具。个人记忆的写入只经 `ingest`，用户控制只经 `manage`，二者都不暴露为工具。模型不能"记住"或"忘记"任何事。
4. **工具不是记忆信号**：工具调用记录不参与交互记忆信号，不得反向驱动个人记忆（`SEM-F34`）。
5. **单向依赖**：`read_sources` 只经 Agent 执行宿主的工具适配器调用字幕上下文适配器与个人上下文模块；`search_context` 只经个人上下文模块 `resolve`。recipe、模型和 renderer 都不接触 SQLite（`SEM-F30`）。
6. **背景摄取无工具**：只有 Agent Bar 发起的正式 Agent 交互可以使用工具。后台个人上下文摄取 recipe 的工具集恒为空集，因此 `formal_agent_tool_calls` 的作用域完整落在交互内。
7. **失败零部分产物**：分块、归并、Schema 校验、预算或工具任一失败时不得提交部分产物（`docs/data-architecture.md` 第 4.2 节）。

## 3. 固定 recipe 闭集（首版 10 项）

产物身份（`transcript_version`、`input_through_event_order`、`input_digest`、`recipe_version`、`provider`、`model`）由 `agent_artifacts` 列承载，因此下表"输出 Schema"只定义 `content_json` 或交互 `result_json` 的**结果对象本身**，不重复保存身份字段。

| recipe ID | 用户可见能力 | 触发 | 输入范围 | 工具 | 模型用途 | 执行形态 | 持久化 |
|---|---|---|---|---|---|---|---|
| `context.ingest.session` | 无（后台状态） | `MeetingStopped` 完整提交水位确定后 | 单个终态会话的权威原始转写 | 空集 | 信息提取 | 单次请求 | 写会话经历记录与个人记忆，不产生产物 |
| `context.ingest.interaction` | 无（后台状态） | 正式 Agent 交互收束且信号提取完成后 | 一条终态交互及其交互记忆信号 | 空集 | 信息提取 | 单次请求 | 写会话经历记录与个人记忆，不产生产物 |
| `qa.answer` | 问答、解释 | Agent Bar 明确请求 | 选区 / 单会话 / 日期范围 / 项目 | 空集 | 默认 | 单次请求 | 只存交互 `result_json`，不成为报告 |
| `extract.items` | 信息提取 | Agent Bar 明确请求 | 选区 / 单会话 | 空集 | 信息提取 | 单次请求 | 只存交互 `result_json`（首版不新增产物类型） |
| `summary.minutes` | 会后结构化纪要 | 用户明确请求，或报告自动呈现偏好开启后的合格终态会话 | 单个终态会话的完整提交水位 | 空集 | 摘要与总结 | 单次请求 | 产物 `meeting-minutes` |
| `report.analysis` | 分析报告 | Agent Bar 明确请求 | 选区 / 会话 / 日期范围 / 项目 | `search_context`、`read_sources` | 分析与规划 | 默认单次请求；满足第 5.6 节四条件才升级 Agent Loop | 产物 `analysis-report`，版本化默认保存 |
| `plan.proposal` | 规划建议 | Agent Bar 明确请求 | 个人记忆 + 会话经历记录 + 用户输入约束 | `search_context`、`read_sources` | 分析与规划 | 默认单次请求；满足第 5.6 节四条件才升级 Agent Loop | 产物 `planning-proposal` |
| `text.enhance` | 增强文本 | Agent Bar 明确请求，跨越冻结的完整水位 | 单个终态会话的权威原始转写或整场精修覆盖 | 空集 | 摘要与总结 | 单次请求（长输入按段边界完整分块） | 产物 `enhanced-transcript` |
| `text.rewrite` | 改写、精简、语气调整 | Agent Bar 明确请求 | 选区 | 空集 | 默认 | 单次请求 | 只存交互 `result_json` |
| `text.translate` | 翻译 | Agent Bar 明确请求 | 选区 / 单会话 | 空集 | 默认 | 单次请求 | 只存交互 `result_json`；整场翻译产物后置 |

`analysis-report` 与 `planning-proposal` 是需要在正式 Agent migration 中登记的新产物类型。`extract.items` 首版不新增产物类型；若日后需要保存，必须另行登记类型而不是复用 `reference-output`（后者只属于隔离 Agent 内核开发入口）。

### 3.1 输出 Schema

所有结果对象都带 `schemaVersion`（整数，从 1 起）。所有 `sourceRef` 形状固定为 `{ sessionId, transcriptVersion, fromEventOrder, throughEventOrder }`；所有 `memoryRef` 为 `{ memoryId, revisionId }`。文本字段长度上限以 Unicode code point 计。

```text
context.ingest.session / context.ingest.interaction
{
  schemaVersion: 1,
  experiences: [ {                                   // ≤64 条
    kind: "decision" | "todo" | "risk" | "topic" | "event",
    text: string ≤300,
    evidence: sourceRef | { interactionId, signalKind },
    confidence: "low" | "medium" | "high"
  } ],
  memoryCandidates: [ {                              // ≤128 条
    scopeKind: "global" | "session" | "topic" | "project",
    scopeKeyProposal?: string ≤64,
    kind: "fact" | "decision" | "todo" | "term" | "habit" | "preference",
    semanticKey: string ≤128,
    content: string ≤512,
    confidence: "low" | "medium" | "high",
    salience: "low" | "medium" | "high",
    evidence: sourceRef | { interactionId, signalKind }
  } ]
}
```

宿主在 Schema 校验后执行噪声筛选、范围判定与合并；冻结字幕快照无说话人身份，因此其 `scopeKind: "global"` 的偏好候选一律丢弃（`docs/data-architecture.md` 第 4.3 节）。模型自评置信不能直接成为当前投影。

```text
qa.answer
{ schemaVersion: 1, answer: string ≤4000,
  sourceRefs: sourceRef[≤16], memoryRefs: memoryRef[≤16],
  unresolved: string[≤5] }

extract.items
{ schemaVersion: 1, items: [ {                       // ≤100 条
    kind: "decision" | "todo" | "risk" | "term" | "entity" | "question",
    text: string ≤300, sourceRefs: sourceRef[≤4],
    confidence: "low" | "medium" | "high" } ] }

summary.minutes                                      // 栏目固定，缺栏目返回空数组
{ schemaVersion: 1,
  overview: string ≤2000,
  conclusions: [ { text: string ≤300, sourceRefs: sourceRef[≤4] } ]  // ≤30
  todos:       [ { text: string ≤300, ownerHint?: string ≤64,
                   dueHint?: string ≤64, sourceRefs: sourceRef[≤4] } ]  // ≤50，只生成文字
  risks:       [ { text: string ≤300, sourceRefs: sourceRef[≤4] } ] }  // ≤30

report.analysis
{ schemaVersion: 1, title: string ≤120, summary: string ≤2000,
  findings:  [ { text: string ≤600,
                 evidence: (sourceRef | memoryRef)[≤8] } ],            // ≤30
  timeline?: [ { label: string ≤64, ref: sourceRef,
                 text: string ≤300 } ],                                // ≤60
  assumptions: string[≤10], gaps: string[≤10] }

plan.proposal
{ schemaVersion: 1, objective: string ≤300,
  facts:        [ { text: string ≤300, ref: sourceRef | memoryRef } ],  // ≤20
  assumptions:  string[≤10],
  plan:         [ { step: integer, text: string ≤300,
                    whenHint?: string ≤64, dependsOn?: integer[≤4] } ], // ≤40
  alternatives: [ { text: string ≤300, tradeoff: string ≤300 } ],       // ≤5
  openQuestions: string[≤10] }
// 首版不写日历、待办、邮件或预订；plan 只是文字草案。

text.enhance
{ schemaVersion: 1,
  segments: [ { segmentId: string, enhancedText: string ≤2000 } ],
  notes?: string ≤500 }
// 必须覆盖冻结水位内的全部字幕段；分块与归并全部成功才提交产物。

text.rewrite
{ schemaVersion: 1, style: "concise" | "formal" | "casual" | "bulleted",
  text: string ≤4000, sourceRefs: sourceRef[≤8] }

text.translate
{ schemaVersion: 1, targetLanguage: string (BCP-47),
  basedOnRevision: string,
  segments: [ { segmentId: string, translatedText: string ≤2000 } ] }
```

`report.analysis` 的 `gaps` 与 `plan.proposal` 的 `openQuestions` 必须如实登记第 3.3 节的省略标记；单次请求覆盖不了范围时不得静默假装完整。

### 3.2 失败语义（全部 recipe 一致）

| 情况 | 结果 |
|---|---|
| 输出不满足 Schema | 至多一次结构化修复重试（同一模型运行绑定），仍失败则 `AGENT_OUTPUT_INVALID` → `failed`，不写产物 |
| 任一预算超限 | `AGENT_BUDGET_EXCEEDED`（D6 新增码）→ `failed`，不写产物 |
| 工具越权或 recipe 无该工具 | `AGENT_PERMISSION_DENIED` → `failed` |
| 未登记 recipe / 请求字段非法 | 创建期 `AGENT_REQUEST_INVALID` fail closed，不进入队列 |
| provider 超时 / 限流 / 断网 / 5xx / worker 退出 | 按现有闭集映射，`max_attempts` 内沿用同一 `runId` 与同一模型运行绑定重试；旧 attempt 的工具记录保留（D7/D12） |
| provider 鉴权失败 | `AGENT_PROVIDER_AUTH_FAILED` → `failed`，不重试，不换模 |
| 用户取消 | `cancelled`，`error_code` 为空，交互为终态且可导出（D13） |
| 长输入分块或归并失败 | 不提交任何部分产物 |

任何上述失败都不得影响字幕、SQLite 历史或导出能力（`SEM-F00/F28`）。

### 3.3 范围解析与省略标记（D11）

范围解析在个人上下文模块内完成，产出冻结的个人上下文包；解析结果一次冻结，运行中不得改变。

1. **剔除粒度是会话内的完整提交水位，不是整会话**：每个会话只取已跨越字幕提交边界的**已定稿**内容，水位之后的内容不进入输入。
2. **精修覆盖不完整（`N≠M`）时该会话回落权威原始转写的完整提交水位**，不整体排除；一个会话内不得混合 `raw` 与 `refined`；`partial` 永不进入。
3. **整会话排除只在三种情况发生**：非终态会话（`session_not_terminal`，水位随时间变化，无法重现也无法比价）、无已提交转写（`no_committed_transcript`）、命中冻结包内部上界（`budget`）。
4. 每个被剔除的部分以省略标记进入冻结包：`{ sessionId, omitted: "session_not_terminal" | "no_committed_transcript" | "not_committed_tail" | "budget" }`，其中 `not_committed_tail` 表示会话内尾部未定稿内容被剔除。
5. 范围内至少一个会话有非空已定稿内容 → `ready`；零个 → `no_committed_transcript`。资格闭集九值不扩充。
6. 省略标记必须进入结果的 `gaps` / `openQuestions`，并进入 `SEM-F35` 导出；不得静默丢弃。

## 4. recipe → 模型用途静态映射

映射由 Agent 模型接入层拥有，是全映射且不向用户暴露 recipe ID（`SEM-F33`）。专用用途未配置档案时回落到"默认"档案；回落不是模型 fallback。

| 模型用途（用户可见） | 映射的 recipe | 成本定位（D2，仅 UI 提示） |
|---|---|---|
| 默认 | `qa.answer`、`text.rewrite`、`text.translate` | 由用户自定 |
| 信息提取 | `context.ingest.session`、`context.ingest.interaction`、`extract.items` | 低成本小模型即可 |
| 摘要与总结 | `summary.minutes`、`text.enhance` | 低成本小模型（DeepSeek / Haiku 级） |
| 分析与规划 | `report.analysis`、`plan.proposal` | 更强模型，与摘要用途独立绑定 |

## 5. 首版工具闭集

首版只有两个只读工具，只对 `report.analysis` 与 `plan.proposal` 在升级为 Agent Loop 时开放（第 5.6 节）。

### 5.1 `search_context`

按精确范围、类型、语义键与**已登记别名的等值匹配**读取个人记忆与会话经历记录；实现在个人上下文模块 `resolve` 之上，不是第四个接口。

```text
args   // canonical JSON ≤8 KiB
{
  scopeRefs:     string[1..4],    // 必须 ⊆ 冻结个人上下文包的 scopeRefs
  kinds:         ("experience" | "fact" | "decision" | "todo" | "term" | "habit" | "preference")[1..6],
  semanticKeys?: string[0..8],    // 每项 ≤128，规范化语义键
  aliasKeys?:    string[0..8],    // 每项 ≤64；NFKC + casefold 后与已登记别名等值匹配
                                  // 非子串、非分词、非模糊、无通配符、无查询语言（D4）
  timeRange?:    { fromDate: "YYYY-MM-DD", toDate: "YYYY-MM-DD" },  // 必须 ⊆ 冻结范围
  limit?:        integer 1..20    // 默认 20
}

result // canonical JSON ≤64 KiB
{
  items: [ { memoryId, revisionId, scopeRef, kind, semanticKey,
             content: string ≤512, origin: "explicit" | "automatic",
             confidenceBand, salienceBand,
             evidenceRefs: sourceRef[≤8], updatedAt } ],
  unmatchedAliasKeys: string[≤8],  // 未在别名表中登记的键，回传以避免重复试探
  hasMore: boolean,
  omittedReason?: "limit" | "budget"
}
```

内部上界沿用 `docs/data-architecture.md` 第 4.3 节：单次最多读取 256 个候选、返回 20 条、65536 canonical JSON UTF-8 字节，每条来源引用最多 8 条；命中上限时保守返回 `hasMore=true`，不为探测第 257 条而读取其正文。排序固定按明确内容、显著性、置信、证据数、更新时间与稳定 ID。

`aliasKeys` 全部未命中时返回空 `items` 与非空 `unmatchedAliasKeys`，不设置 `omittedReason`（没有匹配不是省略），也不算错误。

### 5.2 `read_sources`

按已在冻结个人上下文包中出现的来源引用读取权威原始转写（或用户明确选择且整场覆盖的精修稿）。

```text
args   // canonical JSON ≤8 KiB
{
  sourceRefs: sourceRef[1..8],    // 每个必须 ⊆ 冻结包中某个来源引用
  maxBytes?:  integer 1..65536    // 默认 16384
}

result // canonical JSON ≤64 KiB
{
  sources: [ { sessionId, transcriptVersion, fromEventOrder, throughEventOrder,
               inputDigest, text } ],
  hasMore: boolean,
  omittedReason?: "budget" | "scope"
}
```

只按字幕段边界返回完整段，永不切开一个字幕段或 code point；不足以放入预算时返回更少的完整段并置 `hasMore=true`。`transcript_version='refined'` 只在整场 `N=M` 时可用；不完整精修的混合正文不构成 Agent 输入版本。`partial` 永不进入。

#### 5.2.1 三类正文的边界（D5）

| 存放位置 | 性质 | 规则 |
|---|---|---|
| 字幕事实表（权威原始转写 / 精修稿） | **唯一知识库** | 唯一权威来源，建索引，参与检索与导出 |
| `formal_agent_tool_calls.result_json` 内 `read_sources` 返回的 `text` | **有界审计证据** | 受第 5.3 节字节预算约束；不建索引；不参与任何检索；不进入个人记忆、报告、日志、`.artifacts/`、`docs/validation/`；随交互级联删除；只在 `SEM-F35` 单交互导出中出现 |
| `agent_artifacts.content_json` | **模型生成物** | 不是转写副本，有独立产物身份与版本 |

设计草案 `personal-context-agent-design-draft.md` §9 的"首版不复制第二份正文"指的是不建第二份**可检索知识库**，需在该草案补一句澄清，避免被读成禁止有界审计证据。

### 5.3 预算（首版十轴）

前六轴沿用 `docs/testing-strategy.md` 第 4 节；累计计费 token 拆分与两条字节轴为 D6 新增。**省钱轴是累计计费 token，不是单次请求上限**——Loop 每轮都会重发上下文，只限单次请求不省钱。

| # | 轴 | 单次请求 recipe | Agent Loop recipe（首版值） |
|---|---|---|---|
| 1 | turn 上限 | 1 | 6 |
| 2 | 单次请求输入 token | 由模型运行绑定的上下文上界约束 | 同左，每次请求各自校验 |
| 3 | **累计计费输入 token（按 attempt 求和）** | 由绑定预算约束 | ≤120k |
| 4 | **累计计费输出 token（按 attempt 求和）** | 由绑定预算约束 | ≤8k |
| 5 | wall-clock | 交互 60 s / 后台 180 s | 180 s |
| 6 | 工具调用总数 | 0 | ≤12 |
| 7 | 单工具 timeout | — | 5 s |
| 8 | 并行度 | — | 1（首版顺序执行，保证工具记录全序确定） |
| 9 | **累计工具结果字节** | — | ≤256 KiB canonical JSON UTF-8 |
| 10 | **累计来源正文字节**（第 9 轴的子预算） | — | ≤128 KiB（`read_sources` 返回的 `text` 合计） |

- 单次工具审计预算：`args` ≤8 KiB、`result` ≤64 KiB。任何工具在注册期声明的 `maxResultBytes` 必须 ≤64 KiB（第 2 节不变量 2）。
- 第 10 轴必须严格小于第 9 轴，否则子预算永不先触发、形同虚设。
- token 计数以 provider 返回的 usage 为准；provider 未返回时按 `ceil(canonicalUtf8Bytes / 2)` **保守高估**并计入预算与费用估算，同时把用量事实标注为 `usageSource: "estimated"`（provider 提供时为 `"provider"`）。
- 全部预算按 attempt 计，`max_attempts` 约束总量（D12）。

### 5.4 工具错误码闭集（新增，需登记）

`formal_agent_tool_calls.error_code` 独立于 `agent_jobs` 的错误闭集，不得复用。

| 工具错误码 | 含义 | 是否回传给模型 | 运行级后果 |
|---|---|---|---|
| `TOOL_ARGS_INVALID` | 参数不满足 exact Schema | 是 | 同一工具连续 2 次后运行以 `AGENT_OUTPUT_INVALID` 失败 |
| `TOOL_SCOPE_DENIED` | 范围超出冻结个人上下文包 | 是 | 整次运行累计 2 次后以 `AGENT_PERMISSION_DENIED` 失败 |
| `TOOL_NOT_AVAILABLE_FOR_RECIPE` | 该 recipe 未登记此工具 | 否 | 立即 `AGENT_PERMISSION_DENIED` |
| `TOOL_BUDGET_EXCEEDED` | 触及第 5.3 节任一上界 | 否 | 立即 `AGENT_BUDGET_EXCEEDED` |
| `TOOL_TIMEOUT` | 超过单工具 timeout | 是 | 计入工具调用总数，不单独终止运行 |
| `TOOL_CANCELLED` | 取消信号贯穿到工具 | 否 | 运行进入 `cancelled` |
| `TOOL_INTERNAL_FAILURE` | 宿主内部失败 | 否 | 立即 `AGENT_INTERNAL_FAILURE` |

工具错误不得携带原始 Error、stack、本地绝对路径或凭据。

### 5.5 明确拒绝的能力

首版工具闭集不提供，且不得通过提示词、recipe 配置或 provider 选项间接获得：

shell 与进程启动；任意文件读写与任意路径解析；任意 HTTP 或网络请求；SQL、SQLite 直连或自由查询；对日历、待办、邮件、预订等外部系统的写操作；递归委派、子 Agent 或 `spawn_subagent`；凭据读取；现场音频、PCM 或音频路径访问；模型自选 base URL、headers 或凭据；修改字幕事实、精修稿或权威原始转写；写个人记忆或改用户偏好/设置（写入只经 `ingest`，用户控制只经 `manage`）；读取内部思维过程或 provider 原始事件。

### 5.6 Agent Loop 升级阈值（D3，省钱优先）

**默认单次请求。** 只有下列四条**同时**成立才升级为 Agent Loop：

1. recipe 属于 `report.analysis` 或 `plan.proposal`；其余 recipe 工具集恒为空集，永不升级。
2. 冻结范围覆盖 ≥ 2 个终态会话。
3. 冻结个人上下文包在构建时命中了内部上界，即存在 `hasMore=true` 或至少一条第 3.3 节省略标记（说明一次请求确实覆盖不了范围）。
4. 确定性输入估算 `estimatedInputTokens = ceil(frozenBundleCanonicalUtf8Bytes / 2) + recipePromptOverheadTokens` ≥ 模型运行绑定输入预算的 70%；`recipePromptOverheadTokens` 是随 `recipe_version` 冻结的常量。

判定规则：

- 判定在**运行创建期一次性完成**，结果与依据冻结写入交互记录的 `execution_form`（`single_shot` | `agent_loop`）与 `escalation_reason`，运行中不得改变。
- 判定必须可重现：同一冻结输入、同一模型运行绑定、同一 recipe 版本必须给出同一 `execution_form`。这是模型比价（D9）与回归测试的前提。
- 任一条不成立即为单次请求；单次请求覆盖不了范围时，结果按第 3.3 节第 6 条如实登记省略。
- 单次请求形态下工具集为空集，模型请求工具一律 `TOOL_NOT_AVAILABLE_FOR_RECIPE`。

## 6. 工具调用记录、取消与导出的一致性

### 6.1 记录与导出

- 工具记录按 `(attempt, call_order)` 全序保存，`UNIQUE(interaction_id, attempt, call_order)`（D7）；`args_json/result_json` 是 exact Schema 校验且在第 5.3 节预算内的完整结构化正文，UI 默认折叠。
- 中间 assistant 文本与思维链零持久化（D8）：不进入 SQLite、UI、日志、报告、导出；仍可在内存中作为本次运行的模型上下文。`reasoning`/`reasoning_content` 与 provider 原始事件同样零持久化。
- `SEM-F35` 导出按同一全序编码，包含冻结的用量（含 `usageSource`）与费用估算（D10），不含提示、内部思维过程、凭据、音频、本地绝对路径或保存目标路径。
- 工具正文不进入普通日志、报告、个人记忆、`.artifacts/` 或 `docs/validation/`；随交互级联删除（D5）。

### 6.2 协程式取消（D13）

1. 取消是 cooperative：取消信号贯穿模型请求（`AbortSignal`）与工具 `execute`；工具必须在自身检查点主动检查并以 `TOOL_CANCELLED` 返回，宿主不强杀正在执行的工具体。
2. 取消后不再开新 turn、不再发新 provider 请求、不再调用新工具；本次运行的 runtime 整体收束，租约释放。
3. 取消是终态：`cancelled`，`error_code` 为空，`terminal_reason` 为 `cancelled`，`result` 为 `null`；已发生的工具记录按 `(attempt, call_order)` 全部保留。
4. 取消不重试、不换模、不产生任何产物（第 2 节不变量 7）。
5. 迟到结果（取消后到达的 provider 响应或工具结果）一律拒绝，不写库、不改变终态。
6. 取消后的交互可按 `SEM-F35` 导出，且重复导出字节一致。

## 7. 模型比价与后续 eval 的零重构预留（D9）

首版只跑通，不实现评测。为避免后续频繁重构，只做四项预留：

1. **列必须现在定，表可以后加。** 新表可由追加 migration 随时引入；给已有表加列会引起二次迁移与旧行回填。因此 `formal_agent_interactions` 必须在**首个正式 Agent migration 内一次补齐**：`recipe_id`、`recipe_version`、`input_digest`、`execution_form`、`escalation_reason`、`terminal_reason`、`usage_json`（含 `usageSource`）、`cost_estimate_json`、`comparison_group_id`（可空稳定 ID，同范围同输入的兄弟交互共享）。`pricing_revision` 已由 `agent_model_run_bindings` 承载，不重复存。
2. **eval 在导出文件上离线做（首选路线）。** `SEM-F35` 单交互导出已是确定性字节一致，且含 recipe 身份、输入 digest、范围 digest、模型运行绑定、冻结用量与费用估算、工具调用全序。评测因此可以完全由外部工具消费导出文件完成，应用侧零改动。
3. **不预建评分表。** 评分维度、打分口径与人工标注格式都会变；在 eval 阶段以新的追加 migration 引入即可。
4. **确定性 provider 替身。** 模型接入层保留一个仅测试构建可用的确定性 provider 注入点（Pi 的 `fauxProvider()` 形状），用于回放固定响应；`test:core` / `test:integration` 与后续 eval 共用同一替身，避免为评测另造一套请求路径。

## 8. 与既有实现的迁移关系

可作为迁移素材的机制：utility 进程隔离、租约与过期回收、幂等提交与 receipt、`AgentInputPlanner` 的段边界完整分块、调用级凭据的有界副本与清零、终态会话 durable reconciliation、canonical JSON digest 计算。

应被替换而不是叠加的实现：`AgentPluginHost` 的 manifest / 依赖 / 卸载机制、`MemoryReader` 的 exact query 外部接口、三项默认自动任务、固定 DeepSeek catalog 与 `DEEPSEEK_API_KEY` 启动环境入口、隔离 Agent 内核开发入口的产品外壳与调试聊天。删除时机在负责人确认设计并形成实现 SPEC 之后。

## 9. 回填的登记项（已完成）

下表五个目标文件已于 2026-08-29 全部回填完成。`data-architecture.md` 只登记了逻辑表列清单与约束语义；真正的 SQL 追加 migration 属于实现阶段，既有 `INITIAL_SCHEMA_SQL`、既有 migration SQL 与 checksum 逐字节未改动。

| 目标文件 | 回填内容 |
|---|---|
| `CONTEXT.md` | Agent recipe 定义补入"摘要与总结"类别（D1）；工具调用记录行补入 `attempt` 全序（D7）；Agent Loop 行补入默认单次请求与四条件阈值（D3） |
| `docs/semantic-contract.md` | `SEM-F16` 类别枚举（D1）；`SEM-F15/F28` 增补第 2 节七条不变量、第 5.3 节十轴预算、`AGENT_BUDGET_EXCEEDED` 与第 5.6 节升级阈值（D3/D6）；`SEM-F26` 明确 `aliasKeys` 为等值匹配、不是关键词检索（D4）；`SEM-F30` 增补 `search_context` 建立在 `resolve` 之上与第 3.3 节跨会话范围资格计算（D4/D11）；`SEM-F31` 增补中间 assistant 文本零持久化（D8）；`SEM-F33` 增补价格目录与费用冻结、`usageSource`（D10）与兄弟交互模型比较（D9）；`SEM-F34` 增补工具错误码闭集、`attempt`、第 5.2.1 节三类正文边界（D5/D6/D7）；`SEM-F35` 增补取消交互可导出与费用不重算（D13/D10） |
| `docs/testing-strategy.md` | `J22` 增补每个 recipe 的输出 Schema 往返、工具越权 2 次终止、十轴预算拒绝、`attempt` 全序与重导出一致、升级阈值可重现；`J24` 增补第 3.3 节跨会话范围资格与省略标记（含 `not_committed_tail`）；`J25` 增补兄弟交互对照与 `comparison_group_id`；`J26` 增补取消交互导出与迟到结果拒绝；第 4 节不变量补入第 2 节七条 |
| `docs/data-architecture.md` | 第 4.3 节补一句"别名等值匹配不属于自由文本查询"（D4，原有"不接受自由文本"表述不改）；`formal_agent_tool_calls` 增列 `attempt` 与唯一约束（D7）；`formal_agent_interactions` 一次补齐第 7 节第 1 条列清单（D9/D10/D13）；登记 `analysis-report`、`planning-proposal` 产物类型；第 4.2 节错误闭集追加 `AGENT_BUDGET_EXCEEDED`（D6）。全部通过新的追加 migration 落地，既有 migration/checksum 逐字节不变 |
| `docs/research/personal-context-agent-design-draft.md` | §9 补一句澄清：不复制第二份正文指不建第二份可检索知识库，不禁止第 5.2.1 节的有界审计证据（D5） |

回填已完成，下一步进入交接文档待做事项 4（冻结模型接入接口）与 5（形成实现 SPEC）。旧 Agent（`AgentPluginHost`、`MemoryReader`、三项自动任务、固定 DeepSeek catalog、环境凭据、隔离调试入口）在负责人评审通过前不动一行。

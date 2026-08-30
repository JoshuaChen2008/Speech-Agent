# ADR 0017：确认关键词退出个性化范围，个人偏好只影响 Agent 产物

- 状态：已决定
- 日期：2026-08-30
- 决策者：项目负责人
- 依赖：ADR 0005、ADR 0006、ADR 0013
- 取代：无既有 ADR 决策项；本 ADR 取消的是 SEM-F27 中「用户确认的词汇型条目可影响后续 ASR」这一条语义
- 修订：[ADR 0005](0005-separate-recognition-and-agent-providers.md) 中关于确认关键词进入识别上下文的表述、[ADR 0006](0006-local-structured-personal-memory.md) 中关于确认关键词作为筛选终点的表述
- 保留不变：ADR 0006 的四类筛选、明确内容与自动推断分离、来源引用与生命周期规则

## 背景

SEM-F27 把个性化边界定为两条并行的通路：用户明确确认的**词汇型**条目（术语、实体名、别名）在未来新会话开始时冻结成快照交给识别 provider，用来改善 ASR；写作、摘要与表达偏好则只影响 Agent 产物。J20 把「权威识别策略」与「确认关键词」合并为一条旅程，SEM-T15 又把 J20 整条列为正式 Agent 首版的门禁。

在为 S3–S5 冻结总规格时，这个形状暴露三个问题。

**第一，产品目的已经改变。** 个性化的价值不在于纠正识别结果，而在于让会后的分析、总结与记忆沉淀按用户的关注点和表达偏好产出。用一份用户维护的词表去影响 ASR，解决的是识别准确率问题；而识别准确率应当由识别 provider、模型资源与权威识别策略负责，不应当转嫁给用户维护词表。

**第二，首版没有能力承载这条通路。** 当前 `src/runtime/realtime-worker/**` 与 `src/runtime/refine-worker/**` 完全没有 hotword / keyword 接线。在纯本地权威识别路径下，用户完成「确认关键词」这个动作后，识别结果不会有任何变化；按 SEM-F27 的要求，界面还必须显式告诉用户「当前识别 provider 不支持受控关键词」。这是一条用户做完动作、系统立即声明无效的路径。

**第三，J20 把两件没有因果关系的事捆在一起，并因此阻塞 Agent 首版。** 权威识别策略（云端主力识别与本地降级）属字幕系统，需要新建云端识别 provider adapter、连接存活检测与会话内单向降级；确认关键词属 Agent 侧个性化。SEM-T15 把 J20 整条列为门禁，等于让正式 Agent 首版被一项与 Agent 无因果依赖的字幕能力阻塞。

## 决策

1. **确认关键词退出首版范围，并取消其影响 ASR 的语义。** 用户明确确认的个人记忆条目——包括 `kind='term'` 的术语条目——此后只是个人上下文事实，**在任何情况下都不进入识别 provider、不冻结成会话关键词快照、不影响任何字幕会话**。SEM-F27 相应重写；`CONTEXT.md` 的「确认关键词（Confirmed Recognition Term）」术语条目移除。

2. **个性化边界收敛为单一通路：个人上下文中的偏好只影响 Agent 产物。** 自动提取的术语、实体名、别名与偏好仍先形成带来源的候选；用户明确确认或人工修正后成为明确内容，只能由用户再次明确修改，自动推断可以补充证据或形成冲突候选但不得覆盖当前明确值。这条规则本身不变，变化只在其作用对象：从「ASR 与 Agent 产物两处」收窄为「只有 Agent 产物」。

3. **偏好进入 recipe 的方式固定为个人上下文包的独立分区。** 个人上下文模块的 `resolve(request)` 返回的个人上下文包中，`kind='preference'` 的条目必须与事实类条目（`decision`、`conclusion`、`todo`、`term`、`project_fact`、`experience`）分区表达。Agent 执行宿主把偏好分区表达为**产出约束**（关注什么、按什么结构组织、用什么措辞），把事实分区表达为**知识来源**；模型不得把偏好当作事实引用，也不得把事实当作偏好套用。二者共用同一份来源引用与预算规则，不新增第二套检索。

4. **J20 整条旅程后置，从 SEM-T15 的门禁清单移除。** 权威识别策略（云端主力识别与本地降级）仍是已决定的未来能力，不因本 ADR 作废；它只是不再是正式 Agent 首版的前置。J20 的用户意图与验收口径保持不变，但删去其中确认关键词的部分，并在 `testing-strategy.md` 标注状态为「已决定；后置，不阻断正式 Agent 首版」。不新增 `J20a` / `J20-terms` 这类同义旅程 ID。

5. **v3 已建出的四张识别词汇表标记为废案，不删表。** `recognition_terms`、`recognition_term_sets`、`recognition_term_set_members` 与 `recognition_session_configs` 由 `FORMAL_AGENT_SCHEMA_SQL`（v3）建出。按 ADR 0015 第 10 项，既有 migration SQL 与 checksum 逐字节不变，删表是独立的、需要单独裁决的数据变更，本 ADR 不做。这四张表此后：新设计零写入、零读取；`data-architecture.md` 标注为废案；唯一触及它们的 `src/runtime/storage-worker/formal-agent-store.js` 属 ADR 0015 锁定在启动路径之外的旧实现，新设计的会话删除事务不涉及这四张表。

6. **未来若重新引入 ASR 个性化，必须走新的裁决。** 本 ADR 不预留兼容接口、不保留半实现入口、不在个人上下文模块或识别链路上留下「以后接上去」的钩子。届时需要新的 ADR、新的 SEM 行与新的旅程登记，并重新回答「谁维护词表」「provider 能力缺失如何暴露」「与首次稳定转写不可变性如何共存」三个问题。

## 取舍

- 相比保留确认关键词，本方案去掉一条首版必然无效的用户动作与一份需要用户长期维护的词表；代价是识别准确率此后完全由识别 provider 与模型资源负责，产品不再提供用户侧的补救手段。
- 相比把 J20 拆成两条旅程，整条后置避免了新增同义旅程 ID 与拆分后的验收口径漂移；代价是权威识别策略这项已决定能力在旅程矩阵中长期停留在「后置」，需要在 PLAN 中单独跟踪以免被遗忘。
- 相比顺手删除四张识别词汇表，保留它们让 v3 checksum 与既有候选数据库保持可复现；代价是数据模型里长期留着四张空表，必须明确标注为废案以免被误认为现行设计。
- 相比让偏好通过独立的第二条检索通路进入 recipe，把偏好做成个人上下文包内的分区复用了同一套范围、预算、来源引用与省略标记规则；代价是包的结构变宽，`resolve` 的预算分配必须同时覆盖两类条目而不能让偏好挤占事实。

## 未选择

- 保留确认关键词并接受首版「用户确认后识别无变化」的空转路径。
- 用会后字符串替换改写首次稳定转写来模拟关键词效果。
- 把 J20 拆成两条旅程或新增同义旅程 ID。
- 删除 `recognition_*` 四张表或修改 v3 的 SQL 与 checksum。
- 在个人上下文模块或识别链路上预留未来接回 ASR 个性化的接口或开关。
- 让偏好条目直接进入模型的事实上下文，或让事实条目被当作产出约束。

## 关联

- 语义：SEM-F25、SEM-F26、SEM-F27、SEM-F30、SEM-T15
- 旅程：J20（后置）、J21（个人上下文摄取与管理）、J22（Agent Bar 与固定 recipe）
- 数据：`recognition_terms` / `recognition_term_sets` / `recognition_term_set_members` / `recognition_session_configs`（v3，废案不写入）、`personal_context_items`（v5，`kind='preference'` 分区）
- 现状代码：`src/runtime/realtime-worker/**` 与 `src/runtime/refine-worker/**` 无 hotword 接线；`src/runtime/storage-worker/formal-agent-store.js` 为 ADR 0015 锁定的旧实现
- 实现 SPEC：[`../agent-redesign-execution-plan.md`](../agent-redesign-execution-plan.md)

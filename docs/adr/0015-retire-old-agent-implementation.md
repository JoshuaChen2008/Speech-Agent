# ADR 0015：旧 Agent 实现整体废案——保留源码、摘除启动路径、隔离入口降级为历史证据

- 状态：已决定
- 日期：2026-08-29
- 决策者：项目负责人
- 依赖：ADR 0013、ADR 0014
- 取代：[ADR 0007](0007-isolated-agent-core-mvp.md)（作为前瞻决策整体取代；其第 2、3、5 项继续作为被保留代码的现状描述有效）
- 保留不变：[ADR 0010](0010-separate-isolated-and-formal-agent-migration-catalogs.md)

## 背景

ADR 0013 与 ADR 0014 取代了旧 Agent 的宿主结构与 provider 结构。这留下一个必须单独回答的问题：既有旧实现怎么处置。

旧实现由六部分组成：`AgentPluginHost`、`MemoryReader`、`MeetingStopped` 后三项自动任务、启动期固定单一 DeepSeek catalog（`validateAgentProviderConfigCatalog()`）、启动环境凭据引导（`CREDENTIAL_ENV_NAME = 'DEEPSEEK_API_KEY'`）、以及 SEM-F29 的隔离 Agent 内核开发入口。

其中启动期 catalog 校验是硬耦合点：它在 `provider-bootstrap.js` 中断言 `providers.length === 1` 且 `providerId === 'deepseek'` 且 `baseUrl === 'https://api.deepseek.com'`，并在**启动期** fail closed。只要它仍在启动路径上，ADR 0014 的多档案接入层就不可能存在——两者不能同时为真。

同时，旧实现产出的可靠性证据（Pi ESM 在 Electron utility process 下的可用性、进程隔离、调用级凭据借用与清零、claim/租约/恢复/幂等、取消与超时合流、migration checksum fail-closed）是真实的、可复用的，直接删除会丢失迁移审计输入。

ADR 0007 第 1 项与第 6 项把隔离入口定为「首个实现切片」并让 J23 成为 Agent 内核门禁；这两条已被新的切片顺序取代。

## 决策

1. 旧 Agent 实现**整体为废案**，不作为新正式 Agent 的组成部分或演进起点。新实现不得复用旧启动接线、旧配置表或旧凭据入口；旧实现也不得因被保留而重新获得任何门禁资格。
2. 旧源码**继续留在仓库**，不删除。它的唯一作用是迁移审计输入与可靠性不变量的参照（具体清单见 ADR 0014 第 16 项与 [`../research/model-access-interface-freeze-draft.md`](../research/model-access-interface-freeze-draft.md) 第 12 节）。
3. 旧实现**必须从启动路径摘除**：不注册旧宿主、不调度三项自动任务、不在启动期校验单一 DeepSeek catalog、不读取环境凭据、不开放旧调试聊天与隔离开发入口。摘除后旧代码在生产运行中不可达。
4. **新旧是两套独立实现。** 二者不共享启动接线、配置表、凭据入口或注册表；不建立兼容层、适配器或双写路径。
5. 摘除启动接线本身是一次**可观察行为变更**，必须作为独立实现切片单独取证，不得夹带在其它切片里。它排在新实现各片之后（切片顺序见实现 SPEC 的 S6），并需要自己的旅程编号与证据。
6. 在摘除完成前，新的多档案模型接入层**不得依赖启动期存在任何 provider 配置**。这条是两片可以并行推进而不互相阻塞的前提。
7. 隔离 Agent 内核开发入口从**门禁降级为历史资格证据**（SEM-F29、J23）。ADR 0007 第 1 项「首个实现切片是隔离入口」与第 6 项「J23 只验收 Agent 内核，J21/J22 后置」被新的切片顺序取代；J23 此后只记录旧设计已验证过的事实，不再是任何新能力的前置或替代。
8. ADR 0007 第 2、3、5 项继续有效，但性质从「对将要建设的入口的要求」变为「对被保留代码的现状描述」：该入口拥有独立 main / renderer / preload / IPC access policy / utility process / userData / SQLite / 诊断目录且不导入正式字幕主进程；其参考插件只产出标记为 `reference-output` 的产物；其数据不迁移到正式 userData，其产物不进入正式安装包或正式导航。摘除启动路径后这些约束自动继续成立。
9. [ADR 0010](0010-separate-isolated-and-formal-agent-migration-catalogs.md) **完整保留**。隔离候选 catalog 的 v3 SQL、checksum 与受限映射保持逐字节不变；正式 catalog 继续在自己序列上追加 v4、v5……；任一 catalog 打开另一 catalog 的数据库时仍必须因 checksum 不一致 fail closed，不得自动转换、跳过或重写 migration 历史。隔离入口不再启动**不构成**修改候选 catalog 的理由——既有候选数据库必须保持可复现。
10. 新实现的所有 schema 变化一律通过正式 catalog 的**追加 migration** 落地。既有 migration SQL 与 checksum 逐字节不变；checksum 不匹配继续 fail closed。旧 Agent 相关的既有正式表不在本轮删除——删表是独立的、需要单独裁决的数据变更。

## 取舍

- 相比直接删除旧实现，保留源码让迁移期间可以对照可靠性不变量与既有证据；代价是仓库内长期存在一套不可达的代码，需要明确标注以免被误认为现行设计。
- 相比让旧实现继续启动并与新实现共存，摘除启动路径是必要的——启动期单一 DeepSeek catalog 校验与多档案设计不能同时为真。代价是新接入层必须等这一片完成才能在真实启动路径上可用。
- 相比把摘除夹带进新实现的某一片，单独一片能让「旧行为消失」这件事有独立可观察证据；代价是多一片工作与多一条旅程。
- 相比保留 J23 作为门禁，降级为历史证据避免了「旧内核已验收」被当成新能力的验收替代；代价是新实现无法继承任何既有门禁通过状态，必须自己重新取证。
- 相比顺手清理旧 Agent 的既有正式表，本 ADR 不动它们；代价是数据模型里暂留未使用的表，换来本轮不引入任何数据风险。

## 未选择

- 删除旧 Agent 源码、隔离入口或候选 migration catalog。
- 让旧实现继续在启动路径上注册、调度或校验配置。
- 在新旧之间建立兼容层、适配器、双写或数据迁移路径。
- 修改候选 catalog 的 v3 SQL 或 checksum。
- 把摘除启动接线作为其它切片的附带改动。
- 把 J23 的既有通过状态计入新实现的验收证据。

## 关联

- 语义：SEM-F29、SEM-F28、SEM-F33
- 旅程：J23（历史资格，不计入新实现证据）；摘除切片的旅程编号见实现 SPEC
- 现状代码：`src/agent-provider/provider-bootstrap.js`、`src/agent-provider/model-provider-registry.js`
- 实现 SPEC：[`../agent-redesign-execution-plan.md`](../agent-redesign-execution-plan.md)

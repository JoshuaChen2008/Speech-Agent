## Context

本 change 从 [Agent 重设计实现执行计划](../../../docs/agent-redesign-execution-plan.md) 的阶段 A 与 S1 收敛而来。语义冲突优先级保持为 [semantic-contract.md](../../../docs/semantic-contract.md) → ADR 0013–0015 → data/testing 文档 → 本 change；这里不复制表定义与完整旅程，只记录实施前仍缺失的选择和执行顺序。

本轮代码核查补充了两项现状事实：

1. 新代码根 `src/agent/**` 尚不存在。
2. ADR 0012 冻结的 `FormalAgentJobScheduler` 目前只有文档合同，仓库里没有对应实现；`src/agent-runtime/formal-agent-runtime.js` 是旧实现留存且不在产品启动路径，新设计不得复用或改造它。

另有一个切片级矛盾需要显式处理：SEM-F28 要求自动摄取先取得包含真实模型接入事实的 `ready` 资格，而 S1 又明确不接模型。因而 S1 可以实现 v5、个人上下文模块和调度基础，但在 S2 尚未提供真实模型接入层时，不能通过内部替身伪造完整 J21 自动摄取产品旅程，也不能把 S1 标成“联合验收完成”。

## Goals / Non-Goals

**Goals:**

- 建立 migration v5 与新旧 store 的物理隔离，保持 v1–v4 逐字节不变。
- 建立一个深的个人上下文模块，其外部 interface 恰好为 `ingest(source)`、`resolve(request)`、`manage(command)`。
- 建立 ADR 0012 调度合同的新实现骨架，并让它只调度新 `formal_agent_runs`。
- 通过真实 storage worker/SQLite 验证 S1 子边界，同时保持字幕系统独立。
- 把阶段 A 的测试清单拆回各切片，S1 只写会被 S1 实现立即转绿的测试。

**Non-Goals:**

- 不实现 S2 模型配置档案、模型运行绑定、凭据或 provider adapter。
- 不实现 S3/S4 的模型请求、受控工具、Agent Loop 或十轴预算执法。
- 不实现 S5 Agent Bar、`agent` 窗口角色或单交互导出。
- 不实现 settings/history 的正式个人上下文管理 renderer；S1 只签发 exact preload 投影与脱敏 fixture，独立 UI/UX 工作线按 `docs/agent-ui-ux-handoff.md` 消费。
- 不重写 `docs/runtime-architecture.md` §11.2；该节在 S3/S4 形成真实运行时后同步。
- 不修改或调用旧 `src/agent-core/**`、`src/agent-runtime/**`、`src/agent-provider/**`、`src/agent-mvp/**` 实现。

## Decisions

### 1. 三个 seam 已确认，再进入红测

S1 的测试与调用者使用同一组 interface：

1. **个人上下文模块 seam**：`ingest(source)`、`resolve(request)`、`manage(command)`。范围解析、来源身份、水位/digest、三层分流、revision、冲突、生命周期、预算、省略标记和删除事务都隐藏在模块内；调用者不得取得 SQLite、自由查询或内部 store 方法。
2. **调度 seam**：`FormalAgentJobScheduler.start()`、`wake(reason)`、`stop()`。logical claim attempt、`wakeEpoch`、timer、generation、单 owner 与错误隔离都隐藏在模块内。
3. **renderer adapter seam**：main-owned `agent-context:get-overview` / `agent-context:manage` 与 `agent-context:changed`，只允许 `settings` / `history`。preload 只把 exact 载荷映射到个人上下文模块 interface，不形成第四个个人上下文入口；同一 exact validator 产生脱敏 fixture，供 UI/UX 预览，fixture 不替代真实 renderer/IPC/SQLite 的 J21 证据。

项目负责人已于 2026-08-29 确认这三个 seam。storage worker 是个人上下文模块的 remote-but-owned adapter；生产走 `StorageGateway → StorageWorkerHost → StorageWorkerService`，联合测试走相同 worker/service 与真实临时 SQLite，不使用内存 repository。

### 2. 阶段 A 是测试清单，不是批量红测提交

每个 tracer bullet 固定为“一个 seam 行为测试变红 → 最小实现转绿 → 定向回归”。不会先创建 J21–J27 全部常红骨架，也不会提交或交接无法通过 lane 的红测。跨切片的闭集、绑定顺序、十轴预算与 J22/J24/J25/J26/J27 测试在对应 S2–S6 才进入循环。

### 3. v5 使用独立新 store，并保持字幕路径惰性

v5 表与字段以 [data-architecture.md §3、§5](../../../docs/data-architecture.md) 为唯一表定义。`StorageWorkerService` 新增独立 `personalContextStoreFactory` 与 `requirePersonalContextStore()`；只有新 personal-context 操作到达时才加载新 store。既有 `agentStoreFactory`、旧表和旧操作保持不变，字幕 `open/append/close/history` 不加载任一 Agent store。

直接 schema 测试只验证 migration/checksum、STRICT/CHECK/外键和隐私列不变量；行为测试通过个人上下文模块 interface 观察结果，不越过 interface 直接查询表来证明行为。

### 4. scheduler 属于新执行宿主，不属于个人上下文模块

新实现放入 `src/agent/execution-host/formal-agent-job-scheduler.js`，由一个最小 `job-runner.js` 领取 `context.ingest.session` 并调用个人上下文模块。这样调度生命周期不会膨胀 `ingest/resolve/manage` interface，S2–S4 后续可在同一执行宿主内增加模型运行而无需改变个人上下文调用者。

旧 `FormalAgentRuntime`、旧 `AgentJobRunner` 和旧三任务 store 只能作为审计素材，不作为 adapter，也不建立兼容层。

### 5. S1 不伪造 `ready`，J21 使用子边界证据

S1 证明以下真实链路：v5 migration → 新 store → 个人上下文模块 interface → 新调度器/领取生命周期 → exact IPC adapter，以及字幕路径零回归。模型接入事实缺失时产品资格保持 `provider_not_configured`，自动产品路径不创建运行。

J21 保持一个用户旅程编号，不为 S1/S3/S4 的实现切片创建同义新旅程。`docs/testing-strategy.md` 在实现前增加 S1 子边界登记，明确它不提升完整 J21 状态；S2 接入真实模型接入层且后续 UI/正式交互成立后，才组合晋级 J21。

### 6. S1 的无模型分流采用已确认的保守基线

S1 不为任意字幕正文发明关键词、正则或模糊分类规则。项目负责人已于 2026-08-29 确认以下基线：

- 非空终态会话可确定性形成一条仅含有界结构化轨迹与来源引用的会话经历记录；不复制整场正文。
- 用户经 `manage` 提交的 exact “记住”/修改命令可以形成或修订个人记忆；无受信任结构化信号时，S1 不从任意正文自动臆测个人记忆条目。
- 空正文、无来源推断、无效或超预算结构化输入进入丢弃/拒绝路径，且失败零写入。

自动从正文提取个人记忆条目的模型-backed 分类在真实模型接入层与固定 recipe 可用后接入，但仍只通过 `ingest` 提交。若项目负责人要求 S1 就自动产生个人记忆条目，必须先在语义合同/旅程矩阵登记一套可测试的确定性提取规则；当前权威文档没有这套规则，不能由实现者临时发明。

### 7. 交接第 6 节四项裁决已确认

- S5 使用新的 `agent` 窗口角色；它不进入 S1 文件或测试。
- 十轴预算唯一值定义点为 `src/agent/contracts/budget-axes.js`；S1 只冻结十值任务错误码，不定义预算数值。
- S3/S4 继续复用 J22/J24 并登记子边界，不新建同义用户旅程。
- `runtime-architecture.md` §11.2 在 S3/S4 真实运行时形成后一次性重写，S1 只保留失效 banner。

### 8. S1 UI-facing contract 独立版本化且冻结后不可改写

S1 的 renderer-facing 权威合同登记在 `docs/agent-context-ui-contract.md`，可执行 exact validator 与 preview-only fixture 唯一位于 `src/agent/contracts/`。合同使用独立于 SQLite migration v5 和项目 v5/v6/v7 的 `contract_id + contract_version`；已签发版本的字段、枚举、错误、权限与 fixture 不得原地修改。breaking 变更发布新 major，additive 变更发布新 minor，metadata-only 变更发布新 patch；每个版本使用独立 fixture 目录，旧目录保持只读。

首个 S1 UI contract 只冻结 `agent-context:get-overview`、`agent-context:manage`、`agent-context:changed`，角色仍只有 `settings` / `history`。现有 preload global 保持 `window.shell` / `window.historyApi`，二者都只增加 `getAgentContextOverview`、`manageAgentContext`、`onAgentContextChanged` 三个同形 facade；角色由 main sender identity 判定，不进入 renderer request。用户可通过 exact 结构化字段明确“记住”一条个人记忆；这不等于 J20 确认关键词，也不影响识别 provider。“忘记”只使条目退出检索并保留条目、revision、来源引用和会话经历记录；“删除”继续执行 suppression 后物理移除。调度器的 `wakeEpoch`、timer、generation、claim 和 `AGENT_SCHEDULER_FAILED` 均不进入产品投影，技术故障只由受约束诊断与后台幂等恢复收束。

fixture 使用同一 exact validator 校验其内嵌的生产 request/response/event；额外的 preview envelope 只描述 loading/pending 等 UI 预览场景并固定 `preview_only=true`。它不进入 `.artifacts/`、`docs/validation/` 或 J21 证据。

## Risks / Trade-offs

- **[S1 无法独立形成 `ready` 产品旅程]** → 保持 `provider_not_configured` fail closed，只登记 S1 子边界；不使用内部模型接入替身冒充完整 J21。
- **[“确定性分流”缺少正文分类规则]** → 采用保守基线；若要扩大，先按 SEM-T06 登记规则与旅程，再写测试。
- **[新旧同类表被误用]** → 新 store 禁止出现旧表名，旧 store 禁止出现新表名；产品字幕路径对两者都保持惰性。
- **[v5 追加后不可回滚降版本]** → 发布前只在副本/临时库验证升级；失败保留原库并 fail closed。已应用 v5 的数据库只能通过后续追加 migration 修复，不能改写 v5。
- **[scheduler 新实现扩大 S1]** → 只实现 ADR 0012 生命周期与 `context.ingest.session`，不引入模型、工具或动态 recipe。
- **[测试耦合实现]** → schema 只测不可替代的数据库不变量；业务行为全部从已确认 interface 观察。

## Migration Plan

1. 在 `docs/testing-strategy.md` 登记 J21 的 S1 子边界与状态上限；不改语义要求。
2. 先用临时 v4 数据库验证 v5 升级、v1–v4 checksum、表/列/CHECK 与隐私 schema。
3. 逐个 tracer bullet 增加 contracts、store、个人上下文模块、调度器和 IPC adapter；每条红测立即转绿。
4. 用真实 storage worker/SQLite 运行 S1 联合子边界，并证明字幕 `open/append/close/history` 不加载新 store、Agent 失败不改变字幕回执。
5. 依次运行 `npm run test:core`、`npm run test:integration`、`npm run test:evidence`。只有局部与子边界证据时，S1 状态最多为“实现完成·尚未验收”。
6. 提交时逐路径显式暂存，保留八个 `docs/current-framework*` 未跟踪文件；不使用 `git add .`。

数据库回退只允许停止发布并恢复升级前备份；不得修改 v5 SQL/checksum、降 `user_version` 或静默修行。代码回退移除新 main 接线但保留已发布 migration 的读取兼容，后续修复继续追加 migration。

## Open Questions

无阻断项。三个测试 seam、S1 保守无模型分流基线和交接第 6 节四项裁决均已于 2026-08-29 确认。若以后要求 S1 从任意字幕正文自动产生个人记忆条目，或改变上述 seam/切片边界，必须先按 SEM-T06 更新语义合同与旅程矩阵，再更新本 change；实现者不得在 `/opsx:apply` 阶段自行扩张。

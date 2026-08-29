# ADR 0015：旧 Agent 实现整体废案——保留源码、锁定在启动路径之外、隔离入口降级为历史证据

- 状态：已决定
- 日期：2026-08-29
- 决策者：项目负责人
- 依赖：ADR 0013、ADR 0014
- 取代：[ADR 0007](0007-isolated-agent-core-mvp.md)（作为前瞻决策整体取代；其第 2、3、5 项继续作为被保留代码的现状描述有效）
- 保留不变：[ADR 0010](0010-separate-isolated-and-formal-agent-migration-catalogs.md)

## 背景

ADR 0013 与 ADR 0014 取代了旧 Agent 的宿主结构与 provider 结构。这留下一个必须单独回答的问题：既有旧实现怎么处置。

旧实现由六部分组成：`AgentPluginHost`、`MemoryReader`、`MeetingStopped` 后三项自动任务、启动期固定单一 DeepSeek catalog（`validateAgentProviderConfigCatalog()`）、启动环境凭据引导（`CREDENTIAL_ENV_NAME = 'DEEPSEEK_API_KEY'`）、以及 SEM-F29 的隔离 Agent 内核开发入口。

其中启动期 catalog 校验是最硬的耦合点：`provider-bootstrap.js` 断言 `providers.length === 1` 且 `providerId === 'deepseek'` 且 `baseUrl === 'https://api.deepseek.com'`，并在**启动期** fail closed。它与 ADR 0014 的多档案接入层不能同时为真。

2026-08-29 逐文件核查后确认，这六部分**当前已经不在产品启动路径上**，本 ADR 的处置因此不是「摘除」而是「锁定」：

| 事实 | 核查依据 |
|---|---|
| 产品入口不接线任何 Agent 模块 | `package.json` 的 `main` 为 `src/main.js`；该文件内出现 `Agent` 的位置只有三处设备/应用名字符串（`src/main.js:214`–`216`），无任何 Agent require |
| 旧宿主、三项自动任务、provider 引导、环境凭据、旧调试聊天只能从非产品入口到达 | `src/agent-runtime/formal-agent-runtime.js` 仅被 `scripts/formal-agent-storage-utility-smoke.js` 引用；`src/agent-provider/provider-bootstrap.js` 仅被该脚本、`src/agent-runtime/agent-utility/*` 与三个 `test/integration/formal-*` 引用；隔离入口 `src/agent-mvp/main.js` 只能经 `npm run start:agent-mvp` 手动启动 |
| 唯一残留在产品启动路径上的旧 Agent 耦合是 schema | `src/runtime/storage-worker/worker-service.js:28` 让产品 storage worker 选用 `FORMAL_AGENT_MIGRATIONS`，因此 v3/v4 旧 Agent 表在产品启动时被建出；`FormalAgentStore` 是惰性 require（同文件第 30–34 行），只有正式 Agent 操作到达才加载 |
| 打包排除不完整 | `electron-builder.config.cjs` 的 `files` 只排除 `src/agent-core/**` 与 `src/agent-mvp/**`；`src/agent-provider/**` 与 `src/agent-runtime/**` 仍被打入 asar，而它们 require 的 `src/agent-core/**` 已被排除，因此是打进包里且一旦加载即失败的死文件。`scripts/verify-package-layout.js:159` 与 `test/validation/b5-packaging-contract.test.js` 也只守这两棵树 |

因此真正的缺口不是启动接线，而是：这个「已经不可达」的状态**没有任何测试或打包契约在守**，任何一次接线都能悄悄把它接回来；且打包载荷里带着一批不可达的旧 Agent 文件。

同时，旧实现产出的可靠性证据（Pi ESM 在 Electron utility process 下的可用性、进程隔离、调用级凭据借用与清零、claim/租约/恢复/幂等、取消与超时合流、migration checksum fail-closed）是真实的、可复用的，直接删除会丢失迁移审计输入。

ADR 0007 第 1 项与第 6 项把隔离入口定为「首个实现切片」并让 J23 成为 Agent 内核门禁；这两条已被新的切片顺序取代。

## 决策

1. 旧 Agent 实现**整体为废案**，不作为新正式 Agent 的组成部分或演进起点。新实现不得复用旧启动接线、旧配置表或旧凭据入口；旧实现也不得因被保留而重新获得任何门禁资格。
2. 旧源码**继续留在仓库**，不删除。它的唯一作用是迁移审计输入与可靠性不变量的参照（具体清单见 ADR 0014 第 16 项与 [`../research/model-access-interface-freeze-draft.md`](../research/model-access-interface-freeze-draft.md) 第 12 节）。
3. 旧实现**必须锁定在启动路径之外**：产品入口不注册旧宿主、不调度三项自动任务、不在启动期校验单一 DeepSeek catalog、不读取环境凭据、不开放旧调试聊天与隔离开发入口。这一状态当前已成立（见背景表），因此本条的实施内容是把它变成**被守住的契约**而非一次改动：需要一条会红的守卫，断言产品入口的 require 图不到达任何 Agent 模块；需要把 `src/agent-provider/**` 与 `src/agent-runtime/**` 补进打包排除与打包契约。隔离入口保留 `npm run start:agent-mvp` 手动启动能力，但它不得被产品入口、产品脚本或安装包引用。
4. **新旧是两套独立实现。** 二者不共享启动接线、配置表、凭据入口或注册表；不建立兼容层、适配器或双写路径。
5. 锁定动作必须作为独立实现切片单独取证，不得夹带在其它切片里。它排在新实现各片之后（切片顺序见实现 SPEC 的 S6），并需要自己的旅程编号与证据。它的**可观察变更只有两项**：打包载荷不再包含 `src/agent-provider/**` 与 `src/agent-runtime/**`；产品入口的 require 图从此有守卫。运行时行为不变——因为运行时旧实现本来就没在跑。任何把这一片描述为「关掉了正在运行的旧 Agent」的说法都是错的。
6. 新的多档案模型接入层**不得依赖启动期存在任何 provider 配置**。这条使 S6 与新实现各片互不阻塞；因为旧 provider 引导本来就不在产品启动路径上，它也使 S1–S5 无需等待 S6。
7. 隔离 Agent 内核开发入口从**门禁降级为历史资格证据**（SEM-F29、J23）。ADR 0007 第 1 项「首个实现切片是隔离入口」与第 6 项「J23 只验收 Agent 内核，J21/J22 后置」被新的切片顺序取代；J23 此后只记录旧设计已验证过的事实，不再是任何新能力的前置或替代。
8. ADR 0007 第 2、3、5 项继续有效，但性质从「对将要建设的入口的要求」变为「对被保留代码的现状描述」：该入口拥有独立 main / renderer / preload / IPC access policy / utility process / userData / SQLite / 诊断目录且不导入正式字幕主进程；其参考插件只产出标记为 `reference-output` 的产物；其数据不迁移到正式 userData，其产物不进入正式安装包或正式导航。这些约束当前成立，S6 的守卫使它们从此可被证伪。
9. [ADR 0010](0010-separate-isolated-and-formal-agent-migration-catalogs.md) **完整保留**。隔离候选 catalog 的 v3 SQL、checksum 与受限映射保持逐字节不变；正式 catalog 继续在自己序列上追加 v4、v5……；任一 catalog 打开另一 catalog 的数据库时仍必须因 checksum 不一致 fail closed，不得自动转换、跳过或重写 migration 历史。隔离入口不再启动**不构成**修改候选 catalog 的理由——既有候选数据库必须保持可复现。
10. 新实现的所有 schema 变化一律通过正式 catalog 的**追加 migration** 落地。既有 migration SQL 与 checksum 逐字节不变；checksum 不匹配继续 fail closed。旧 Agent 相关的既有正式表不在本轮删除——删表是独立的、需要单独裁决的数据变更。
11. 产品 storage worker 继续选用 `FORMAL_AGENT_MIGRATIONS`，因此 v3/v4 旧 Agent 表继续在产品启动时被建出。这是第 10 项的直接后果，**不属于**第 3 项要锁定的启动接线：建表不加载任何旧 Agent 运行时代码，`FormalAgentStore` 保持惰性 require。S6 不得改动这一点。

## 取舍

- 相比直接删除旧实现，保留源码让迁移期间可以对照可靠性不变量与既有证据；代价是仓库内长期存在一套不可达的代码，需要明确标注以免被误认为现行设计。
- 相比让旧实现有机会重新接线，加守卫是必要的——启动期单一 DeepSeek catalog 校验与多档案设计不能同时为真，而「当前不可达」是一个没有任何契约在守的偶然状态。代价是多一条结构性守卫要维护。
- 相比把锁定夹带进新实现的某一片，单独一片能让打包载荷收缩与守卫生效各有独立证据；代价是多一片工作与多一条旅程。
- 相比保留 J23 作为门禁，降级为历史证据避免了「旧内核已验收」被当成新能力的验收替代；代价是新实现无法继承任何既有门禁通过状态，必须自己重新取证。
- 相比顺手清理旧 Agent 的既有正式表，本 ADR 不动它们；代价是数据模型里暂留未使用的表，换来本轮不引入任何数据风险。

## 未选择

- 删除旧 Agent 源码、隔离入口或候选 migration catalog。
- 让旧实现在产品启动路径上注册、调度或校验配置。
- 删除 `npm run start:agent-mvp` 或让隔离入口不可手动启动。
- 让产品 storage worker 退回只用 `SUBTITLE_BASE_MIGRATIONS`，或删除 v3/v4 旧 Agent 表。
- 在新旧之间建立兼容层、适配器、双写或数据迁移路径。
- 修改候选 catalog 的 v3 SQL 或 checksum。
- 把锁定动作作为其它切片的附带改动。
- 把 J23 的既有通过状态计入新实现的验收证据。

## 关联

- 语义：SEM-F29、SEM-F28、SEM-F33
- 旅程：J23（历史资格，不计入新实现证据）；锁定切片为 J27（定义见 [`../testing-strategy.md`](../testing-strategy.md)）
- 现状代码：`src/main.js`（无 Agent 接线）、`src/runtime/storage-worker/worker-service.js`（唯一残留耦合：选用 `FORMAL_AGENT_MIGRATIONS`）、`src/agent-provider/provider-bootstrap.js`、`src/agent-provider/model-provider-registry.js`、`src/agent-runtime/formal-agent-runtime.js`、`src/agent-mvp/main.js`
- 现状打包契约：`electron-builder.config.cjs`、`scripts/verify-package-layout.js`、`test/validation/b5-packaging-contract.test.js`
- 实现 SPEC：[`../agent-redesign-execution-plan.md`](../agent-redesign-execution-plan.md)

# 正式 Agent MVP 工程交接

> 更新：2026-08-10  
> 分支：`codex/b1-application-skeleton`  
> 当前 HEAD：`cdadb3a docs(agent): 登记 D15 后台任务调度边界`

## 1. 先看结论

正式 Agent 的 UI-free 后端已经形成从终态字幕会话、SQLite 后台 Agent 任务、正式插件宿主、Pi Agent Loop、main-owned `StorageGateway` 到独立 Agent utility 的纵切。D14 的最近完整基线为 core 531/531、integration 65/65、evidence 227/227、总计 823/823；这些子边界的证据状态是**实现完成·尚未验收**，不能称为正式 Agent MVP 的联合验收完成。

D15 的后台任务调度与字幕会话资源桥接已经先登记语义、旅程和 ADR，提交为 `cdadb3a`，独立 Luna/max 末轮复核为 P1=0、P2=0、P3=0；实现尚未形成。当前工作树只有 `src/agent-core/formal/job-runner.js` 存在一段 D15 未测试半成品，不能据此提高 D15 状态。

真实 DeepSeek HTTP 按产品决定后置。首版非敏感 provider 参数使用 main-only 受信任配置表，默认 `deepseek/deepseek-v4-flash`；凭据只允许启动环境 `DEEPSEEK_API_KEY`。应用不自动读取 `.env`，不提供 renderer 凭据输入或回读接口，也不得在真实 provider 未接入时伪造正式产物。

## 2. 权威阅读顺序

接手模型不要从本文件反推要求。发生冲突时固定按以下顺序处理：

1. [`docs/semantic-contract.md`](semantic-contract.md)
2. [`docs/adr/`](adr/)
3. [`CONTEXT.md`](../CONTEXT.md) 与架构文档
4. [`docs/testing-strategy.md`](testing-strategy.md)
5. [`docs/agent-mvp-interface-contract.md`](agent-mvp-interface-contract.md)
6. [`docs/agent-mvp-todo.md`](agent-mvp-todo.md)
7. 本交接与代码现状

每批改动前必须重新通读 `CONTEXT.md`。新增能力或改变语义时，先登记适用 SEM 行与用户旅程，再动实现。

## 3. 必须保持的语义

| 概念 | 对齐要求 |
|---|---|
| 字幕系统 | 本地核心产品；Agent 系统完全不存在时仍独立运行。Agent 故障不得阻塞采集、字幕、精修、持久化、历史或导出。 |
| Agent 系统 | 字幕提交边界之后的可选系统，只生成内容和个人记忆结果，首版不执行外部操作。 |
| 后台 Agent 任务 | SQLite 权威、可恢复、可取消、带冻结输入身份的异步工作单元，不属于字幕会话同步停止路径。 |
| Agent 模型 provider | 与识别 provider 分离。默认 `deepseek/deepseek-v4-flash`，模型名是配置中的不透明字符串，不能据此猜测上下文窗口或能力。 |
| 输入事实 | 默认消费权威原始转写；`partial` 不进入 Agent。精修稿只有整场 `N=M` 时才能成为 `refined` 输入。 |
| 单路来源 | 一个会话只能是 `mic` 或 `loopback`，运行中不得并发或直接换源。 |
| 隐私 | 永不保存现场音频。报告只写指标、布尔值和哈希，不写字幕正文、凭据、本地绝对路径、设备名或原始 Error/stack。 |
| 证据状态 | 只使用「已决定 / 实现完成·尚未验收 / 联合验收完成 / 实机验收完成 / 发布验收完成」。任务机状态 `queued/running/succeeded` 不等于证据状态。 |

## 4. Provider 决策

### 4.1 已冻结的正式形状

- main-only `AgentProviderConfigCatalog` 保存非敏感参数：`providerId/providerKind/apiStyle/baseUrl/model/maxChunkInputBytes/maxResultBytes/timeoutMs`。
- 默认配置：`deepseek`、`cloud`、`openai-chat-completions`、exact origin `https://api.deepseek.com`、`deepseek-v4-flash`。
- 当前保守预算：`maxChunkInputBytes=65536`、`maxResultBytes=16384`、`timeoutMs=60000`。
- 网络接入后仍只允许 exact origin 和受控路径，拒绝 redirect；这些规则不能由 renderer 修改。

### 4.2 凭据生命周期

- 正式 main 必须早于任何窗口、preload、renderer、worker、child 或 utility 读取并删除所有大小写等价的 `DEEPSEEK_API_KEY`。
- 凭据只驻留 main 私有有界 `Buffer`；每次 Agent utility 调用取得一份私有副本，调用后尽力清零。
- 配置、SQLite、日志、报告、argv、child environment、普通 lifecycle event 和 renderer 都不得出现凭据。
- utility 异常退出、稳定鉴权失败或应用退出后，本进程凭据失效；恢复需要新的应用启动。
- 不自动加载 `.env`，不把 API key 写进 `ConfigStore`。

### 4.3 当前边界

当前只使用确定性 Agent 模型 provider 作为网络外部边界替身，内部仍经过真实 registry、`ModelGateway`、Pi Agent Loop 和 Agent utility。真实 DeepSeek HTTP、账户、配额和模型质量证据后置。生产路径在 provider 未接入或凭据不可用时必须显示显式降级，不能由 fixture 直接提交正式产物。

## 5. 已落库的工程进度

| 批次 | 内容 | 证据状态 |
|---|---|---|
| D1–D2 | 正式合同与 J24 矩阵；隔离 Agent 内核开发入口的故障、恢复、权限和隐私矩阵 | 正式合同已决定；隔离入口联合验收完成 |
| D3 | 正式 Agent SQLite migration、资格、任务生命周期、幂等结果与 tombstone | 实现完成·尚未验收 |
| D4 | 冻结输入、正式纪要插件、确定性分块/归并、`ModelGateway` + Pi、runner 与原子提交 | 实现完成·尚未验收 |
| D5 | 增强文本、个人记忆提取/合并、三任务独立提交、记忆 suppression 与单条删除 | 实现完成·尚未验收 |
| D6 | production storage utility、策略先行、exact-child replacement、同 `runId` 恢复 | 实现完成·尚未验收 |
| D8 | 个人记忆的受信任策略门控与有界读取 | 实现完成·尚未验收 |
| D9 | main-only provider catalog/bootstrap、启动环境凭据消费/删除/失效 | 实现完成·尚未验收 |
| D10 | `AgentModelProviderRegistry → ModelGateway → Pi Agent Loop` 的无公网正式内部路径 | 实现完成·尚未验收 |
| D11 | `ConfigStore` v2 Agent 设置、revision 更新与自动处理边界 | 实现完成·尚未验收 |
| D12 | `SessionCoordinator → MeetingStoppedPersistenceSink → FormalAgentRuntime` 的字幕提交边界 | 实现完成·尚未验收 |
| D13 | runner、字幕/记忆读取和 writer 统一通过 main-owned `StorageGateway` | 实现完成·尚未验收 |
| D14 | main proxy 与独立 Agent utility，调用级凭据副本、异常退出失效和双启动恢复 | 实现完成·尚未验收 |
| D15 | main-owned scheduler、logical claim attempt、`wakeEpoch`、retry/stop generation 与会话资源桥接 | 已决定；实现尚未形成 |

最近 D14 提交：

- `9ac4933`：登记 D14 语义与旅程
- `3aa3f02`：建立 D14 Agent utility 进程边界
- `91ad5a7`：记录 D14 证据
- `cdadb3a`：登记 D15 调度边界与 ADR 0012

## 6. 当前工作树：不要误提交

### 6.1 本轮 Agent 半成品

`src/agent-core/formal/job-runner.js` 有未提交、未测试改动：

- 增加 runner-owned `createClaimAttempt()`；冻结 key、owner、请求 `leaseMs`、`availableTaskKinds` 与 `localWorkAllowed`。
- 增加 nominal `runClaimAttempt()`；未知异常后把同一 attempt 恢复为 pending，确定返回后标记 settled。
- 保留 `runNext()` 兼容包装。
- retry 结果增加 `nextAttemptAt`，供 scheduler 安排最早到期 timer。

这段设计方向与 D15 合同一致，但尚未运行定向测试，也未经过实现复核。接手后应先审查并补测试；不要单独把它提交为 D15 实现证据。

### 6.2 并行 UI/UX 改动

> 2026-08-29 历史说明：下列 `docs/agent-ui-ux-handoff.md` 在当时指向 2026-08-09 的隔离入口 UI 交接；该文件路径现已承载新的正式 Agent UI/UX 交接，旧正文只从 Git 历史读取。本节仍只记录当时并行工作树归属，不得据此把新 handoff 解释成 `agent-mvp` 实现说明。

以下文件属于并行 UI/UX 任务，本轮没有审查其最终语义，也不得和 Agent 后端提交混在一起：

- `docs/agent-ui-ux-handoff.md`
- `docs/current-ui-ux-handoff.md`
- `docs/ui-design-brief.md`
- `src/agent-mvp/renderer/index.html`
- `src/agent-mvp/renderer/main.tsx`
- `src/agent-mvp/renderer/styles.css`
- `src/agent-mvp/renderer/icons.tsx`

正式 Agent UI 接线前需要重新对照语义合同。Stage 0 隔离入口中的 provider key/safeStorage 表单不是正式产品接口，不能复制到正式设置页。

### 6.3 仍应避让的冲突区

并行字幕任务可能继续修改 `src/main.js`、`src/main/**`、`src/preload/**`、`src/caption/**`、`src/toolbar/**`、`src/history/**` 和 `src/settings/**`。D15 可以先在 `src/agent-runtime/**`、`src/agent-core/formal/**`、相关 runtime test 与既有 UI-free 联合旅程内闭合，不必抢写正式 main。

## 7. UI/UX 接手最小合同

正式 UI/UX 以 [`docs/agent-mvp-interface-contract.md`](agent-mvp-interface-contract.md) §5 和语义合同为准；现有 `src/agent-mvp/renderer/**` 属于隔离 Agent 内核开发入口，不是正式产品接口范本。

### 设置页

- renderer 只允许提交 exact `{ expectedRevision, agentEnabled, memoryEnabled, cloudDisclosureAccepted }`。
- provider 公共状态只读展示 `providerId/providerKind/model/credentialState` 的受控投影；不得展示 `baseUrl`、预算或凭据。
- 不提供 API key、URL、model 输入框，不读取 `.env`，不复制 Stage 0 的 safeStorage/key 表单。
- revision 冲突必须重新读取权威 snapshot，不能用前端最后写入覆盖。
- Agent 不可用时明确展示稳定原因与下一动作；字幕设置与字幕会话操作保持可用。

### 历史与产物

- 历史页从 preload/exact IPC 读取 SQLite 权威任务、产物和个人记忆投影，不读取 renderer fixture 或内存副本。
- 会后结构化纪要、增强文本、权威原始转写和精修稿是彼此独立的版本；Agent 产物永不覆盖字幕正文。
- `queued/running/retry_wait/succeeded/failed/cancelled` 是后台 Agent 任务机状态，不是本仓库的证据状态。用户文案要逐项核对 UI brief，不能把 `succeeded` 投影成“验收完成”。
- 失败只显示稳定错误分类与可执行下一动作，不展示原始 Error、stack、provider 响应或凭据。
- 重试、取消、重新生成、个人记忆单条删除都必须经受限 preload/exact IPC；UI 不直接选择 SQLite 表或构造自由 SQL。

### 交互和可访问性

- 动态任务状态和错误使用不抢焦点的 live region；不能只靠颜色表达。
- renderer reload 后先读取权威 snapshot，再订阅增量；丢失增量不能重复创建任务或产物。
- Agent 关闭或失败只降低 Agent 系统能力，不禁用字幕系统、历史原文或导出。
- 正式 UI 仍为**已决定**。并行 UI 文件在语义与真实 IPC 旅程复核前，不得标为实现完成·尚未验收。

## 8. D15 接手方案

### 7.1 必须实现的对象

建议新增 `src/agent-runtime/formal-agent-job-scheduler.js`，包含：

1. `FormalAgentJobScheduler`
   - main-owned，单 owner，同一时刻最多一个 logical claim attempt。
   - `start` 只允许一次；`stop` 为终态。
   - unknown claim/transport 结果保留同一个 runner-owned attempt，下一次显式唤醒复用；receipt 或空结果确定后才创建新 key。
   - `wake()` 递增 `wakeEpoch`；idle 时只排一个 drain；空扫描进入 idle 前由同一 owner 临界点复核 epoch。
   - 禁止固定轮询。retry 只保留当前 generation 的到期集合，始终只挂最早 timer；最早项触发后继续安排下一项。
   - `stop` 清除 timer/wake、推进 generation；旧 timer、旧微任务和旧回调不得重新领取。
   - 异常只投影 exact `{ code: 'AGENT_SCHEDULER_FAILED' }`；不得写任务错误码、正文、路径或原始 Error。

2. `FormalAgentSessionResourceBridge`
   - 先 `SessionCoordinator.onSnapshot(listener)`，再 `getSnapshot()`。
   - 只提取 exact `{ revision, sessionId }`，只应用 revision 单调不减的投影。
   - `sessionId !== null` 表示活动字幕会话；只影响下一 attempt 的 `localWorkAllowed`。
   - 云端任务继续；D15 不实现本地任务运行中抢占。
   - `stop` 取消订阅并用 generation guard 忽略旧回调。

3. `FormalAgentRuntime` 工作通知
   - 增加可选、无参数的 `onWorkAvailable` observer。
   - 成功应用任务策略、终态会话对账形成/发现任务、replacement 恢复后只调用 observer 唤醒 scheduler。
   - observer 异常必须隔离，不能改变字幕持久化或对账结果。

### 7.2 预计修改文件

- `src/agent-core/formal/job-runner.js`
- `src/agent-runtime/formal-agent-job-scheduler.js`（新增）
- `src/agent-runtime/formal-agent-runtime.js`
- `test/runtime/formal-agent-job-scheduler.test.js`（新增）
- `scripts/formal-agent-storage-utility-smoke.js`
- `scripts/fixtures/formal-agent-utility-worker.js`
- `test/integration/formal-agent-storage-utility-journey.test.js`

### 7.3 最小回归，不要复制旅程

runtime 层只保留能独立保护下列竞态的测试：

- claim transport 首次异常后，第二次显式 wake 复用同一 attempt 和完全相同的冻结请求。
- 第一次空扫描准备进入 idle 时注入 wake，下一轮仍执行，且最大并发为 1。
- 两个 retry 到期值只挂一个最早 timer；触发后正确保留下一到期值。
- `stop` 后旧 timer、旧排队微任务和后续 wake 都不能再领取。
- 会话桥接严格 subscribe-first，拒绝 revision 回退，并在 stop 后忽略旧回调。

不要新增第二条与 `formal-agent-storage-utility-journey` 同义的 integration journey。升级现有旅程即可。

### 7.4 Provider barrier 建议

既有 fixture 是唯一允许替换的 Agent 模型 provider 外部边界。建议为 fixture 增加一个有界延迟 barrier 场景：

- provider 进入真实 utility 内的模型调用后输出固定、无敏感信息的 barrier marker。
- barrier 仍未释放时，用真实 `SessionCoordinator` 和 `FakeRuntimeAdapter` 开始并停止一项新的无音频合成会话。
- 开始与停止返回时 provider result marker 必须尚未出现；barrier 释放后原云端任务继续并提交。
- 不要为测试扩大正式 Agent utility RPC 协议，也不要把临时路径、正文或凭据写进 marker/report。

旅程仍需证明三个后台 Agent 任务共享同一冻结输入、独立提交、各自最多一次；父测试继续独立读取 SQLite 并扫描 stdout/stderr、报告和数据文件。

## 9. 形成完整正式 Agent MVP 仍缺什么

### 后端与生命周期

- D15 scheduler 和字幕会话资源桥接。
- 正式 main 的最早 provider bootstrap、Agent runtime/utility/scheduler 创建与退出次序。
- utility/storage replacement 后的策略重放与 wake 接线。
- 正式取消、重试、重新生成和应用退出收束的 main-owned 编排。

### 正式产品接口

- `docs/agent-mvp-interface-contract.md` §5 已登记的 exact IPC 与 preload 角色白名单。
- 设置页：Agent 总开关、个人记忆、云端披露、provider 公共只读状态；不含 URL/model/key 编辑。
- 历史页：三项任务状态、会后结构化纪要、增强文本版本、失败/重试/取消/重新生成与来源证据。
- 个人记忆的有界读取、单条删除和休眠状态投影。
- 默认隐藏的正式调试聊天、执行预览/确认和固定业务工具。
- 确认关键词与识别 provider 能力仍未形成正式实现证据；它们属于 SEM-T15 的完整门禁，不应被 D15 或 Agent UI 冒充。

### 验收与发布

- J21：正式设置/历史/个人记忆的真实 renderer + preload + IPC + SQLite 用户旅程。
- J22：正式调试聊天、预览、确认与恢复旅程。
- J24：正常使用边界组合，包括 renderer reload、资源让行、设置竞态、隐私负扫描和字幕系统独立降级。
- J20：识别 provider 与确认关键词。
- 正式 package layout；隔离 Agent 内核开发入口和开发依赖继续排除。
- 真实 DeepSeek 公网证据按当前决定后置，不阻塞无公网的确定性内部门禁，但接入前生产路径必须显式降级。

## 10. 验证与提交顺序

1. 先审查当前 `job-runner.js` 半成品并写最小红测。
2. 实现 scheduler/bridge 和 `FormalAgentRuntime.onWorkAvailable`。
3. 跑 D15 runtime 定向测试。
4. 升级现有 utility-process 联合旅程并跑定向 integration。
5. 使用 Luna/max 独立复核实现；重点检查 claim receipt、idle 线性点、stop generation、provider barrier 和报告隐私。
6. 运行：
   - `npm run test:core`
   - `npm run test:integration`
   - `npm run test:evidence`
   - `npm test`
7. 只暂存 D15 自有文件。建议分为实现提交和证据文档提交，不混入并行 UI/UX 文件。

Windows 受限环境中的 Electron/Vite `spawn EPERM` 只能记为执行环境问题；不得把它算作产品断言成功或失败。D15 实现复核和三条 lane 未闭合前，状态保持**已决定**。

## 11. 最容易踩的坑

- 同一个 logical claim 的未知响应必须复用原 key 和冻结请求；生成新 key 会误领下一任务。
- attempt 中冻结的是请求 `leaseMs`；receipt 返回的任务 lease 仍由 runner/storage 管理，两者不能混用。
- `wakeEpoch` 只有计数而没有 idle 时排 drain，会让已经休眠的 scheduler 永久漏任务。
- 只保存一个 retry 时间会丢掉第二个未来到期项；应保存有界到期集合，但只挂一个最早 timer。
- 会话快照必须 subscribe-first；先读再订阅会漏掉中间状态。
- `localWorkAllowed=false` 只阻止下一次本地任务领取，不能阻止云端任务，也不能宣称已经实现运行中本地任务有界停止。
- `AGENT_SCHEDULER_FAILED` 只是 observer 诊断，不属于 `agent_jobs.error_code` 闭集。
- `segments.text` 可能被精修稿覆盖；Agent 原始输入仍必须通过 `first_event_order` 回到首次稳定转写事实。
- 不要把 Stage 0 隔离入口、直接插件测试、内存 repository 或文档正则测试当作正式 Agent 用户旅程。
- 不要覆盖或顺手提交当前并行 UI/UX 文件。

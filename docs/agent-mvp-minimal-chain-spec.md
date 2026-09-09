# 最小 Agent 链路 Spec（会话分析 + 记忆沉淀）

> 状态：已决定（设计稿，未替代现有语义合同）
>
> 权威来源仍是 `CONTEXT.md`、`docs/semantic-contract.md`、`docs/testing-strategy.md`、
> ADR 0013–0018 与 `docs/agent-redesign-execution-plan.md`。本文只冻结 MVP
> 的产品切片、实现顺序和验收边界，不改变既有 SEM/J 定义。

## 1. 当前 S3–S6 审计（2026-09-09 代码核对）

本表区分已有代码与完整用户旅程；下方 2026-08-31 测试数字是历史记录，本次文档核对不代表重新执行。切片事实以执行计划 §5 的日期记录为入口，未勾选的旧任务不能反推代码不存在。

| 切片 | 当前事实 | 结论 |
|---|---|---|
| S3 执行宿主 | `recipes.js` 已登记 11 个固定 recipe；统一 `agent-loop`、意图收敛、两段式 session ingest、v7 interaction/tool/presentation storage 与真实 SQLite 联合测试已存在 | 实现完成·尚未验收。正式 Agent 窗口与真实 Agent Bar 汇合缺失 |
| S4 工具与预算 | `ControlledToolRuntime`、`ToolAuditRuntime`、`search_context`/`read_sources`、十轴预算和 `(attempt, call_order)` 审计已存在；定向 runtime/storage/integration 29/29 通过 | 实现完成·尚未验收。完整 Loop 预算观测和正式 UI 汇合缺失 |
| S5-Core | 工作树已有 `agent-run:*` contract/controller、`agent` 角色、preload、main-owned `AgentRunService`、真实 StorageGateway 读取、意图收敛、统一 Agent Loop 接线、分页、changed revision 与 canonical 导出；真实 Electron Agent Bar IPC 旅程已接入 storage worker/SQLite 与字幕停止路径 | 局部 S5-Core 实现完成·尚未验收；provider/Schema/预算/replacement 失败矩阵和正式 MVP 总门槛仍待后续验收 |
| S5-UX | `src/agent/**` 已是正式 Agent Bar renderer，覆盖终态会话范围、纪要/问答、状态、结果、来源引用、折叠工具调用、历史详情与导出动作；工具条 `agent` action 已验证打开、复用、聚焦与关闭；设置页另有模型配置档案 renderer | 实现完成·尚未验收（局部 UI 与 S5 子边界）；J21/J25/J27 及完整 J22/J24/J26 阶段门禁仍缺 |
| S6 旧实现隔离 | 产品入口 require 图不到达四棵旧树；打包排除四棵旧树并保留 `src/agent/**`；J27 定向 integration 1/1、validation 17/17 | 实现完成·尚未验收。隔离入口独立 userData 的联合证据仍缺 |

### 1.1 实际回归基线（2026-08-31）

- `npm run test:core`：785/785，返回码 0。
- `npm run test:integration`：72/80。8 项失败位于 Electron/utility/renderer 启动边界，包含 GPU `exit_code=-1073741515`、开发 renderer 启动失败、受监督退出状态异常及 utility 初始报告缺失；在根因分离前不得统称为环境问题，也不得计作 Agent 旅程通过。
- 工作树已有用户未跟踪的 `docs/current-framework.*` 可视化文件；本设计不修改或纳入这些文件。

### 1.2 S5 实现 revision 证据（2026-09-09，`adcfa31`）

- `npm run verify:renderer` 返回码 0；`npm run test:core` 返回码 0（842/842）；Electron/utility 子进程可运行环境下 `npm run test:integration` 返回码 0（82/82）；`npm run test:evidence` 返回码 0（229/229）。受限沙箱的 integration 记录为 73/82，失败均为 Electron GPU/utility/renderer 启动边界，属于执行环境诊断。
- `test/integration/agent-bar-ipc-journey.test.js` 使用 production Vite renderer、真实 preload、exact main IPC、`SessionCoordinator`、`StorageWorkerHost`/utility、SQLite、HistoryService 与文本导出，覆盖工具条 Agent 入口；该旅程在 `provider_not_configured` 检查前完成字幕启动/停止，随后验证 Agent 窗口关闭后已停止会话的历史与导出独立性。`test/integration/agent-redesign-s5-target-journey.test.js` 以真实 StorageGateway/SQLite 覆盖 `qa.answer`、`summary.minutes`、取消、迟到结果、工具 args/results、历史详情和重复导出；取消回执进入 `cancelling` 后、以及 Schema 失败收束为 `failed` 后，分别由独立 recorder 关闭字幕并读取历史/文本导出，这些是局部 SQLite 证据。`test/integration/formal-agent-lifecycle-journey.test.js` 另以真实 SQLite eligibility 旅程记录 `agent_disabled` 策略下先关闭字幕、再读取历史/文本导出。worker replacement 仍由 scheduler/runtime 与既有 utility-process integration 证据负责。
- tracked I3 非音频报告按 `TZ=UTC --segments 3600 --batch-size 100` 重建后通过 provenance/export 校验，保持 `result=pass`、`gateStatus=partial`，只记录指标、布尔值和哈希。以上证据只收束 S5 子边界，J21 生产后台摄取、完整 J25 设置/模型比较、J27 隔离入口 userData/SQLite 仍是后续阻断项。

## 2. MVP 目标与非目标

### 2.1 一条完整目标用户链路

下图是完整 MVP 目标链路，不是本次 S5 change 的全部实施范围。本次 S5 只收束
终态会话 → Agent Bar 的 `summary.minutes`/`qa.answer` → SQLite → 历史与导出；
`context.ingest.session` 的 J21 后台摄取和完整 J25/J27 证据仍保持后续门禁，不能由
S5 子边界证据晋级。

```text
终态会话停止
  → 字幕提交边界后异步 context.ingest.session
      → 会话经历记录 + 带 sourceRef 的低权重记忆候选
用户打开 Agent Bar，选择终态会话并输入“总结本次会话”
  → main 计算资格
  → 冻结 raw transcript + inputWatermark + digest
  → resolve() 生成有界 Personal Context Bundle
  → summary.minutes（3 轮，search_context）
  → Schema 校验、原子提交、结果展示、历史/导出
```

首版正式入口只暴露：

1. `context.ingest.session`：终态会话后的后台记忆沉淀（默认不呈现报告）。
2. `summary.minutes`：用户明确请求的会话分析，固定栏目为概要、结论、待办、风险。
3. `qa.answer`：同一 Agent Bar 的单次问答，用于验证交互闭环；不自动成为个人记忆。
4. `context.ingest.interaction`：只消费正式 Agent 交互的提示、明确编辑、接受、拒绝、记住、忘记六类交互记忆信号，并按资格、范围和生命周期规则筛选；不是无差别保存问答输出。

其余 recipe 仍保留在固定登记表，但 MVP UI 不暴露入口；不得删除、复制或运行期动态注册。

### 2.2 不做

- 不在字幕停止同步路径等待模型、工具或报告。
- renderer、recipe、provider 不得直接访问 SQLite、文件系统、shell、凭据或任意网络。
- 不保存现场音频、reasoning、中间 assistant 文本、provider 原始事件或本地绝对路径。原始提示仅在受控运行/交互记忆信号提取生命周期内暂存，终态收束并提取后清理，交互历史只留 digest（SEM-F31/F32）。
- 不执行待办、日历、邮件、文件修改或其它外部写操作。
- 不引入 FTS5、embedding、动态插件、递归子 Agent 或第二套任务/租约协议。

## 3. 运行时与数据契约

### 3.1 运行创建时冻结

`runId`、`recipeId + recipeVersion`、模型运行绑定、scope、`transcriptVersion`、`inputWatermark`、`inputDigest`、`comparisonGroupId` 必须一次性冻结。`partial` 永不进入 Agent；不完整精修整场回落 raw，并保留省略事实。运行中不得切换 provider/model、用途或工具授权。

### 3.2 公共状态闭集

```text
pending → running → succeeded
                  ├→ failed
                  └→ cancelling → cancelled
```

`cancelled` 是终态，允许 `result=null` 且不补造结果；迟到 provider/tool/storage 消息按 generation 拒绝。`retry_wait` 只作为后台事实，不投影为成功。

### 3.3 S5-Core exact IPC

所有载荷带 `contract_id`、`contract_version`，并执行 exact key 校验。

| 频道 | 作用 |
|---|---|
| `agent-run:get-eligibility` | 读取九值资格 snapshot；未签发下一动作前 `next_action=null` |
| `agent-run:submit` | 只提交 scope、prompt、client_idempotency_key；main 从真实快照派生版本、水位、digest 和个人上下文 revision |
| `agent-run:cancel` | 幂等取消指定 run；终态再次调用不改写 |
| `agent-run:get-history` | 按 `(terminal_at DESC, interaction_id)` opaque keyset 分页，排除 `intent.route` |
| `agent-run:get-interaction` | 同一 SQLite 快照读取结果、模型身份、用量、来源引用和工具审计 |
| `agent-run:changed` | 单调 revision；renderer 先订阅再读取 |
| `agent-run:export-interaction` | main-owned 保存对话框与原子写入；用户取消零写入 |

公开投影不得包含 recipe ID、轮次上限、tool grants、提示正文、reasoning、凭据或 provider 原始事件；交互终态只留 `promptDigest`。

### 3.4 个人上下文

- `ingest` 只接受终态会话或终态正式 Agent 交互；先建可重放 episode skeleton，再提取候选；失败不得留下部分记忆。提示在受控生命周期内可成为信号，提取后删除；未采纳的生成文字不成为用户事实。
- `resolve` 只返回有界 Personal Context Bundle（范围、episodes、memories、sourceRefs、watermark/digest、预算、省略标记），不返回完整个人记忆表。
- `manage` 的查看、修改、删除、休眠、记住、忘记均经 exact 命令；删除与忘记作用对象不同，revision 冲突零写入。
- 交互记忆信号只来自用户明确动作；普通点击、停留、滚动、复制、调试聊天和未采纳模型输出不进入。

## 4. Agent Loop 与降级

所有 recipe（包括零工具 recipe）只走统一 Agent Loop；轮次上限与工具授权在 `recipes.js` 静态登记，不存在运行期执行形态判定或四条件升级（SEM-F16、ADR 0016）。零工具 recipe 仍以登记的一轮、零工具 Agent Loop 收束，不得旁路成第二种直接模型调用路径。

- `qa.answer`、`summary.minutes`、两类 `context.ingest.*`：最多 3 轮，授权 `search_context`。
- `report.analysis`、`plan.proposal`：最多 6 轮，授权 `search_context` 与 `read_sources`；MVP UI 暂不开放入口，不改变其已登记语义。
- `intent.route`、`text.rewrite`、`text.translate`：最多 1 轮、无工具。

轮次上限是上限，不要求用满；资格、模型能力、预算、取消与 Schema 约束仍生效，能力不足显式拒绝，不降为第二种执行路径。

工具闭集只有 `search_context`（等值 alias/semantic-key 匹配）和 `read_sources`（只读已授权 sourceRef）。越权先写受控失败审计，再拒绝执行。

## 5. 失败与边界矩阵

| 场景 | 必须结果 |
|---|---|
| 会话未终态/无已提交正文 | 资格 `session_not_terminal` / `no_committed_transcript`；不调用模型 |
| Agent 未启用、披露未确认、provider/credential 不可用 | 对应九值资格；不入队、不写交互 |
| Schema 无效 | 最多一次同 binding 修复；仍失败为 `AGENT_OUTPUT_INVALID`，不写部分产物 |
| provider 超时/断网/短暂 worker 退出 | 允许次数内同 binding 重试；旧 attempt/工具记录保留 |
| 用户取消 | `cancelled` 终态；不重试、不生成产物；迟到结果拒绝 |
| 任一预算轴触顶 | `AGENT_BUDGET_EXCEEDED`；已有审计保留，产物不提交 |
| 精修覆盖不完整 | 输入回落 raw；不混合 raw/refined |
| Agent 模块失败 | 只降级 Agent；字幕显示、SQLite 字幕历史和文本导出不受影响 |

## 6. 实现分片与验收

不新增同义 J 编号；沿用 J21/J22/J24/J25/J26/J27 的既有旅程。

### S5-1：窗口与 exact IPC（Core）

- 新增 `agent` BrowserWindow（聚焦、非模态、不穿透）；关闭不影响字幕窗口。
- 扩展 `channels.js`、`access-policy.js`、`src/preload/agent.js`；复用生产 validator。
- 先订阅 `agent-run:changed`，再读取资格/历史；未知版本、字段、枚举 fail closed。
- 证据：J22/J24 submit、cancel、reload、幂等子场景。

### S5-2：最小 Agent Bar（UX + Integration）

- 首先启用“终态会话”范围；其它范围无数据时显示空状态，不提供假下拉框。
- 结果显示状态、来源引用和概要/结论/待办/风险；不显示 recipe ID、confidence 或内部思维过程。
- 所有写动作先 pending，只有 CommandResult/snapshot 后改变 UI；无乐观成功。
- 证据：J22 正常/取消/失败/reload；J24 字幕独立性。

### S5-3：交互历史与导出（Core + Integration）

- 历史使用 `(terminal_at DESC, interaction_id)` keyset；`intent.route` 不出现在用户列表。
- 详情默认折叠工具审计；展开仍受有界投影与权限校验。
- `export-interaction` 由 main-owned 保存对话框原子写入；重复导出字节和 SHA-256 相同。
- 证据：J26 终态/取消、多 attempt、usage unknown、隐私负扫描。

### S5-4：后台记忆闭环（Integration）

- close ACK 后仅唤醒 `context.ingest.session`；同一 `sessionId + watermark + digest` 幂等。
- 结果中的明确“记住/忘记”触发 `context.ingest.interaction`；普通浏览不触发。
- 设置页查看、修改、删除、休眠个人上下文；关闭期间来源不自动补处理。
- 证据：J21/J24 候选、冲突 revision、删除/忘记、worker replacement。

### S6：隔离守卫收束

- 保持 J27 require 图和四棵旧树打包排除。
- 补隔离入口独立 userData/SQLite 的真实联合证据；不删除旧入口、不把旧入口变成正式 Agent。

## 7. 通过条件

MVP 只能在以下条件全部满足后记录为「联合验收完成」：

1. `npm run test:core`、`npm run test:integration`、`npm run test:evidence` 返回码均为 0；Electron/GPU 异常必须有可复现的产品替代证据，不能静默忽略。
2. J21 至少有真实“终态会话 → ingest → 经历记录/记忆候选”；J22 至少有真实“Agent Bar → summary.minutes → 历史详情”；J24 覆盖取消、provider 不可用、重复停止和字幕独立性；J26 覆盖确定性导出；J27 覆盖隔离入口 userData。
3. `.artifacts/`、`docs/validation/` JSON 通过 SEM-F14 负扫描；不得出现正文、音频、音频路径、凭据、本地绝对路径、设备名、绝对单调时刻、时钟偏移或金额字段。
4. 实机证据另按适用门禁记录；单测或 Core 子边界不得替代用户旅程验收。

在 S5-Integration 之前，S3/S4/S5-Core/S5-UX/S6 均最多使用「实现完成·尚未验收」。

## 8. 实施顺序建议

1. 先分类 integration 的 8 个失败，尤其 utility 初始报告缺失；先建立产品断裂与执行环境噪声的清晰边界。
2. 按 S5-1 → S5-2 → S5-3 → S5-4 顺序，每片先写一条会红的真实跨模块测试，再实现最小路径；日常只执行受影响验证，PR/阶段联合验收再执行完整门禁，频率统一见 `testing-strategy.md` §2.1。
3. 暂不扩大 recipe 暴露面；先闭合 `summary.minutes` 与 `context.ingest.session` 的成功、取消、失败、重放和隐私负证据。
4. S5 汇合后再决定是否开放 `report.analysis`/`plan.proposal` 的产品入口；执行仍遵守已登记 6 轮上限和两项工具授权，不新增运行期升级规则。
5. 最后补 J27 隔离入口证据，并更新 `docs/testing-strategy.md` 与本文件状态记录。

## 9. 外部资料

Pi、DeepSeek Harness、OpenAI Agents SDK、LangGraph、LangMem、Letta、Mem0 的一手资料与设计映射见 [`docs/research/minimal-agent-chain-primary-sources.md`](research/minimal-agent-chain-primary-sources.md)。

## 10. S5 纵向切片登记（2026-09-08）

下一步执行工件为 [`openspec/changes/implement-agent-redesign-s5-minimal-chain/`](../openspec/changes/implement-agent-redesign-s5-minimal-chain/)。本切片只把 J22/J24/J26 的以下子边界接成真实产品链路：终态会话范围 → Agent Bar 请求 `summary.minutes`/`qa.answer` → 意图收敛与统一 Agent Loop → SQLite 结果与交互历史 → 单交互 canonical JSON 导出。其它已登记 recipe 仍保留在固定登记表，但在 Agent Bar 中显式显示尚未开放。

本切片的状态只能记录为「实现完成·尚未验收」，直到真实 renderer、preload、main service、模型接入层、执行宿主、storage worker/SQLite 和确定性联合旅程共同通过对应门禁。J21 后台摄取与交互记忆信号、J27 隔离入口 userData/SQLite 证据、完整 J25 模型比较不因本切片存在而晋级。

重启边界已明确：若新 main 无法恢复原始提示，活动请求必须以稳定终态错误收束且不得伪造结果；用户可以基于同一终态会话重新提交。该选择不改变 SEM-F31/F32 的提示清理和不保存完整提示历史要求。

### 10.1 当前 S5 收束面（2026-09-09）

下一轮实施只推进现有 S5 change 的收束面，不新增 J 编号、recipe、工具或 migration：

1. 将工具条的正式入口接到既有 `agent` action 和窗口生命周期，打开 Agent Bar 后保持字幕窗口、工具条窗口的焦点与关闭行为不变。
2. 以真实 Electron renderer → preload exact IPC → `AgentRunService` → Personal Context/Model Access/Agent Loop → storage worker/SQLite → renderer 完成 J22 正向链路和 J24 的取消、reload、provider 失败、replacement 与字幕系统独立性。
3. 保留现有 J26 导出 contract，补保存对话框、成功/失败/取消终态和旧目标保护的正式联合证据；导出仍不得写入提示、reasoning、凭据、现场音频、音频路径、本地绝对路径或金额字段。
4. 将进程内 host 转发、手工 execution adapter、确定性 Agent 模型 provider 和系统对话框替身标记为测试边界；它们只能证明局部行为，不能晋级 J22/J24/J26。

收束条件：`openspec validate` 通过；受影响的 core/integration/evidence lane 按 `testing-strategy.md` §2.1 记录当前 revision 的返回码；三条 lane 和 J22/J24/J26 真实联合证据未齐前，状态保持「实现完成·尚未验收」。

### 10.2 S5 实现 revision 证据收束（2026-09-09，`adcfa31`）

10.1 的四项收束面已纳入当前 revision：工具条正式入口、真实 Electron Agent Bar IPC 与已停止会话的字幕历史/导出边界、真实 SQLite 目标旅程、取消/迟到结果和确定性导出均有对应代码与旅程记录；取消进入 `cancelling` 后及 Schema 失败收束为 `failed` 后的字幕 recorder/history/export 证据均为局部 SQLite 证据。`test:core` 842/842、Electron/utility 可运行环境下 `test:integration` 82/82、`test:evidence` 229/229，均返回码 0。该结果记录为「实现完成·尚未验收」，不把确定性 provider 或系统保存对话框替身当成正式 provider/实机证据，也不提前晋级 J21、完整 J25 或 J27。

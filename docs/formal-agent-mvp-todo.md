# 正式 Agent MVP 实施 Todo / Spec

> 状态：已决定
>
> 本文只负责把正式 MVP 拆成可执行任务。语义权威仍是 `CONTEXT.md`、
> `docs/semantic-contract.md`、`docs/testing-strategy.md` 与现有 ADR。
> 旧隔离 Agent 树已按 [ADR 0019](adr/0019-complete-legacy-agent-retirement.md) 退役；本文只追踪现行 `src/agent/**` 正式链路，不把历史树计入证据。

> 2026-09-12 核对（当前 revision `3b83e35`）：该 revision 已包含正式 Agent Bar renderer、工具条入口、Agent run contract/controller、preload、main-owned service、model-first route、user target scheduler、交互历史与 canonical JSON 导出；真实 Electron renderer → preload → main/Agent Loop → storage worker/SQLite → 字幕系统的 S5 子边界旅程、正式 settings → Agent Bar → history 旅程、终态会话自动摄取旅程和 packaged smoke/release layout 证据已经纳入。正式设置旅程又补齐个人记忆自动处理的休眠/重新开启与旧 revision 冲突断言；完整 J21/J25/J27 与正式 MVP 总门槛仍待后续收束。以下复选框跟踪产品闭环，不表示对应目录完全没有代码。开发选测与阶段门禁统一见 `testing-strategy.md` §2.1，不要求每个小任务重复三条 lane。

> 2026-09-08 S5 执行入口：具体 proposal/design/spec/tasks 见 [`openspec/changes/implement-agent-redesign-s5-minimal-chain/`](../openspec/changes/implement-agent-redesign-s5-minimal-chain/)。本文件只保留正式 MVP 的跨切片导航；S5 的可执行任务以该 change 为准，J21/J27/完整 J25 仍是后续门禁。

## 1. 目标与范围

```text
终态字幕会话
  → 提交 ACK 后异步 context.ingest.session
  → Agent Bar 选择终态会话
  → main 冻结 transcriptVersion / inputWatermark / inputDigest
  → summary.minutes 或 qa.answer
  → Personal Context + Model Access + Agent Loop + SQLite
  → 结果展示 / 历史详情 / canonical JSON 导出
```

首版正式入口只开放 `context.ingest.session`、`summary.minutes`、`qa.answer` 和明确用户动作触发的 `context.ingest.interaction`。其余 recipe 保留静态登记，但不开放 UI。

必须保持：字幕停止不等待 Agent；Agent 失败不影响字幕显示、SQLite 字幕历史和文本导出；不保存现场音频、音频路径、reasoning、provider 原始事件、本地绝对路径或金额字段。原始提示仅在运行/信号提取的受控生命周期内暂存，终态收束并提取后清理，只留 digest（SEM-F31/F32）。

## 2. 正式模块 Interface

新增 main-owned 深模块 `src/agent/formal-run/agent-run-service.js`，renderer 只能通过 preload facade 使用：

```text
getScopes(request)
getEligibility(request)
submit(request)
cancel(request)
getHistory(request)
getInteraction(request)
exportInteraction(request)
recordSignal(request)
subscribeChanged(listener)
```

该模块内部持有 `StorageGateway`、`PersonalContextRuntime`、`ModelAccessRuntime`、`IntentRouteOrchestrator`、`AgentLoopExecutor`、`FormalAgentJobScheduler` 和 main-owned `ExportWriter` Adapter。任何 provider、SQLite、凭据、文件系统或路径都不得泄露给 renderer。

## 3. 合同修订决策

- submit 公开载荷改为 `scope + prompt + client_idempotency_key`；水位、digest、版本和 Personal Context revision 由 main 从真实快照派生。
- 资格快照在下一动作合同签发前固定 `next_action=null`。
- export 只接受 interaction ID，格式固定为 canonical JSON，renderer 不传 `format` 或路径。
- privacy validator 允许合法的 `input_token/output_token/cache_*_token` 用量字段，但拒绝 `api_token/access_token/refresh_token/token_value` 等凭据字段。
- IPC controller 必须同时校验 request 和 service response。
- `agent-run:changed` 由 main-owned service 产生单调 revision，并采用先订阅后读取。
- Agent Bar 需要会话范围列表；新增 `getScopes` 频道前，必须先登记 semantic contract、testing strategy 和 UI contract。

## 4. Todo

### P0：基线收束

- [x] 复核 2026-08-31 基线中的 integration 8 项失败；GPU、utility、renderer 启动异常必须与产品断言分离，历史数字不冒充当前结果。（实现完成·尚未验收；受限沙箱仍记录为 Electron 启动环境边界，Electron/utility 可运行环境下当前 revision 的 integration 返回码为 0。）
- [x] 复核 I3 `productPayloadSha256` 的当前输入绑定；已有 `56b0237` 刷新记录，后续产品载荷变化仍需重验，不能按旧 TODO 断言修复缺失。（实现完成·尚未验收；已按当前源码与 `TZ=UTC --segments 3600 --batch-size 100` 重建 tracked I3 非音频报告，`productPayloadSha256` 与 storage provenance 已更新，报告仍为 `result=pass`/`gateStatus=partial`。）
- [x] 独立运行并记录 core / integration / evidence 三条 lane 的真实返回码。（实现完成·尚未验收；此前打包基线 revision `cfdc5e4` 在 Electron/utility 可运行环境下为 core 880/880、integration 85/85、evidence 229/229；本轮 `2cb663c` 的受限环境 integration 为 75/85，10 项 Electron GPU/utility/renderer 启动边界失败，另有 focus J21/J25 11/11；这些边界不改写产品断言。）

### P1：合同与 facade（S5 change）

- [x] 统一 `agent-run-ui` 与旧 eligibility contract；旧入口只保留兼容投影，不再维护第二套字段定义。
- [x] 补齐 submit/cancel/history/detail/export 的 exact request/result validator（实现完成·尚未验收；export response 与正式 renderer 已接入，完整联合旅程与阶段门禁证据仍待补齐）。
- [x] 实现 `AgentRunService`：资格、范围、输入冻结、幂等、状态机、取消、revision 和错误投影（实现完成·尚未验收；model-first route 与 user target scheduler 已接入）。
- [x] 用真实 `StorageGateway`、SQLite 和 `ModelAccessRuntime` 替换 [src/main.js](../src/main.js) 的占位 service（实现完成·尚未验收；依赖缺失时仍保持字幕生命周期独立）。

### P2：执行汇合（S5 change）

- [x] 将 `PersonalContextRuntime`、`IntentRouteOrchestrator`、`AgentLoopExecutor` 和 scheduler 接入 production main（实现完成·尚未验收；formal target runner 与 model-first route 已接线）。
- [x] `summary.minutes` 与 `qa.answer` 统一经过同一个 Agent Loop（实现完成·尚未验收；本地真实 SQLite 目标旅程已分别验证 QA 与 minutes 的结果、历史、详情和导出，正式 MVP 阶段门禁仍待总验收）。
- [x] `context.ingest.session` 仅在字幕提交 ACK 后异步启动（实现完成·尚未验收；production main 已组合 Personal Context、Model Access、统一 Agent Loop、真实 StorageGateway/SQLite 与 scheduler，自动摄取仍需正式管理 UI 与完整 J21 联合旅程验收）。
- [x] 覆盖 provider 不可用、Schema 失败、超时、取消、重试、worker replacement 和迟到消息拒绝（实现完成·尚未验收；runner/orchestrator/scheduler 与本地真实 SQLite 目标旅程覆盖 Schema/预算/timeout/取消/迟到结果，worker replacement 由 `test/runtime/formal-agent-job-scheduler.test.js` 与既有 utility-process integration 证据覆盖，真实 Agent Bar IPC 旅程覆盖 provider 不可用；未把本地 S5 目标旅程写成 replacement 证明，完整 J24 总门槛仍待正式 MVP 阶段验收）。

### P3：Agent Bar（S5 change）

- [x] 提供终态会话范围列表和可见默认范围。（实现完成·尚未验收；正式 renderer 已接入 `getScopes`，真实 Electron IPC 与本地 SQLite 目标旅程均已覆盖范围投影。）
- [x] 提供纪要快捷操作和 QA 输入。（实现完成·尚未验收；请求经 exact preload facade 提交，本地真实 SQLite 目标旅程已覆盖两个开放 recipe。）
- [x] 渲染 pending/running/succeeded/failed/cancelling/cancelled。（实现完成·尚未验收；取消等待 CommandResult，未知状态 fail closed。）
- [x] 渲染概要、结论、待办、风险、来源引用和可操作错误。（实现完成·尚未验收；缺口与待确认字段也按受控结果投影，未展示内部 ID/reasoning。）
- [x] reload 后先订阅 changed，再读取权威 snapshot/history。（实现完成·尚未验收；局部 UI 回归覆盖先订阅、历史与活动详情刷新。）
- [x] 修整资格、双列表分页、交互详情、反馈草稿与操作回执的窗口内状态一致性。（实现完成·尚未验收；首次/手动/更高 revision 资格重读、旧响应拒绝、分页独立 loading、按交互草稿与迟到回执隔离、同步重复保护及未知回执幂等键复用已有定向 renderer 回归。）
- [x] 在工具条加入正式 Agent 入口。（实现完成·尚未验收；`agent` action 已接入工具条并由真实 Electron 旅程验证打开、复用、聚焦、关闭，字幕系统继续独立运行。）

### P4：历史与导出（S5 change）

- [x] 历史使用 `(terminal_at DESC, interaction_id)` keyset 分页。（实现完成·尚未验收；真实 SQLite 历史读取已有分页回归，正式联合验收仍待阶段门禁。）
- [x] `intent.route` 不进入用户历史列表。（实现完成·尚未验收；storage projection 已排除该内部 recipe。）
- [x] 详情默认折叠工具审计，展开仍受有界投影约束。（实现完成·尚未验收；Agent Bar 只显示受控工具元数据，导出保留已校验审计。）
- [x] main-owned 保存对话框写 canonical JSON；取消零写入。（实现完成·尚未验收；同目录临时文件 flush/close 后原子替换，取消与写入失败保持目标不变。）
- [x] 重复导出字节和 SHA-256 一致。（实现完成·尚未验收；真实 SQLite 旅程与 exporter 回归已覆盖。）

### P5：S5 子边界证据（不等同正式 MVP 联合验收）

- [x] J22：Agent Bar → `summary.minutes` → SQLite interaction → 结果与历史详情（实现完成·尚未验收；真实 Electron Agent Bar IPC 旅程覆盖工具条入口、provider 资格、窗口生命周期与字幕独立；本地真实 SQLite 旅程覆盖 `summary.minutes`/`qa.answer` → Agent Loop → interaction/history/detail/export；该证据只闭合 S5 子边界，完整 J22 总门槛仍待正式 MVP 阶段验收。）
- [x] J24：取消、provider 不可用、重复停止、reload、字幕独立性（实现完成·尚未验收；真实 Electron 旅程在 provider 不可用检查前覆盖字幕启动/停止，随后验证 Agent 打开/聚焦/关闭不影响已停止会话的历史/文本导出；本地真实 SQLite 旅程覆盖取消/迟到结果，取消进入 `cancelling` 后及 Schema 失败收束为 `failed` 后分别由独立 recorder 读取字幕历史/文本导出；runtime/storage 与既有 utility-process 证据覆盖重复请求、预算/timeout/replacement 失败矩阵。以上为分层子边界证据，完整 J24 总门槛仍待正式 MVP 阶段验收。）
- [x] J26：成功、失败和取消交互的确定性 JSON 导出。（实现完成·尚未验收；`AgentInteractionExporter`、同一 `StorageGateway` 快照、取消零写入、digest/顺序/隐私负扫描、真实 SQLite 重导出字节一致均有证据；系统保存对话框属于外部边界，正式 MVP 阶段门禁仍待统一记录。）
- [ ] J21：终态会话 → `context.ingest.session` → 经历/记忆候选与管理（实现完成·尚未验收；真实 `SqliteSessionRecorder` 终态通知 → `PersonalContextRuntime` → `ContextIngestSessionRunner` → `StorageGateway`/SQLite worker 自动摄取已验证，重复终态通知保持单运行/单经历，正式设置中的个人上下文管理 UI、exact preload/IPC 与 UI 回归已接入；个人记忆自动处理休眠/重新开启与旧 revision 冲突已纳入正式设置旅程，suppression、完整负矩阵与阶段门禁仍待记录）。
- [ ] J25：正式设置 → Agent Bar 运行 → 交互历史（实现完成·尚未验收；受控 loopback provider 的真实 Electron 旅程已覆盖 settings renderer/preload 写入连接、model、用途与凭据，Agent Bar DOM 手动资格刷新、刷新期间提交禁用、问答与编辑反馈提交、正式详情重读，交互信号 accept/replay，个人记忆记住/忘记/删除、休眠/重新开启、旧 revision 冲突和 remount 后读取，以及 SQLite 终态交互与 history renderer 重载；真实公网 provider、系统凭据边界和多模型比较实机证据仍待门禁记录）。
- [ ] J27：正式入口与隔离入口的 userData/SQLite 边界（实现完成·尚未验收；当前 revision `4fe62f7` 已重建 x64 smoke/release 包，smoke layout 为 pass（439 个 ASAR 条目、5 个 native binary），release installer 已生成但 packaged product-shell 在 Electron GPU 边界退出，未形成当前 packaged run binding；当前 core 895/895、integration 75/85（10 项启动/utility/renderer 边界失败）、evidence 229/229。正式/隔离入口 userData/SQLite 旅程、release layout binding、NSIS 安装和干净机手动启动仍待门禁记录，见 [`j27-current-revision-results.json`](validation/j27-current-revision-results.json)。）
- [x] `.artifacts/` 与 `docs/validation/` 通过 SEM-F14 负扫描。（实现完成·尚未验收；`npm run test:evidence` 229/229，报告只保留指标、布尔值和哈希，未写入正文、现场音频或路径。）

后续门禁索引（本 S5 不实施）：J21 完整个人上下文管理 UI 与正式入口联合覆盖；
J27 干净机手动启动与安装边界；J25 的真实公网 provider、系统凭据边界与适用实机证据
也继续由正式 MVP 总门槛追踪。

以上清单只记录 S5 子切片的实现与证据，不得据此记录「联合验收完成」。正式 MVP
仍须同时关闭 J21、J22、J24、J25、J26、J27；其中完整 J25 模型接入层仍是后续门禁。

### 2026-09-11 Agent Bar 状态修整记录（仍为实现完成·尚未验收）

本轮在不新增 IPC、公共字段、数据库表或 migration 的前提下，实施 SEM-F31/F32/F35 的窗口内状态修整：资格在首次读取、手动刷新和更高 `agent-run:changed` revision 后重读；范围与历史分页独立拒绝迟到响应并恢复 loading；详情刷新保留按交互身份保存的反馈草稿；取消、反馈和导出回执不污染后来选择的交互。提交与反馈在同一轮事件内拒绝重复调用，未知回执只在用户再次点击相同载荷时复用幂等键；固定中文错误文案不展示内部值或异常原文，导出旁显示“导出内容可能包含字幕或个人上下文”。

正式 Electron J25 旅程继续使用 production renderer/preload/main、Personal Context、Agent Loop、storage worker 与 SQLite，仅控制外部 provider；新增的 DOM 路径覆盖手动资格刷新、刷新期间提交禁用、编辑反馈提交和正式详情重读。范围扩展、其他 recipe、自动纪要、意图改选、设置跳转和资格引导仍列为后续工作；本轮未执行完整三条 lane、正式包、干净机、真实公网 provider 或系统凭据验收。

### 2026-09-12 个人上下文控制旅程补齐（仍为实现完成·尚未验收）

正式设置→个人上下文管理的真实 Electron 旅程继续使用 production renderer/preload/main、`PersonalContextController`、`ConfigStore`、`StorageGateway`/SQLite 与 Agent Bar；在记住/忘记/删除后新增关闭并重新开启“个人记忆自动处理”，随后以当前 revision 前一版请求验证 `AGENT_CONTEXT_REVISION_CONFLICT`，不产生 SQLite/ConfigStore 写入。fixture 报告只保留休眠、重新开启和冲突三个布尔值，不写正文、凭据、设备、路径或音频。

本轮受影响 focus 为 23/23（正式 Electron 旅程 1/1），`npm run test:evidence` 为 229/229，`npm run test:core` 保持 895/895；这些证据仍记录为「实现完成·尚未验收」，不替代 suppression 负矩阵、真实公网 provider、系统凭据、正式包、干净机或适用实机边界。

同一 revision 的 J27 机械记录已写入 [`j27-current-revision-results.json`](validation/j27-current-revision-results.json)：smoke layout verifier 为 pass，release x64 NSIS 已构建但因 packaged product-shell 的 Electron GPU/utility 边界未生成 binding；VMware inventory 有 2 个条目、当前无运行机，启动克隆需要外部加密口令。该记录只保留计数、布尔值、固定阻断标签和哈希，J27 仍为「实现完成·尚未验收」。

## 5. 验收门槛

只有以下条件全部满足，才允许记录正式 MVP 的“联合验收完成”：

1. 三条 lane 均返回码 0。
2. J21、J22、J24、J25、J26、J27 均有真实跨模块证据。
3. 仅替代外部 provider/网络/系统凭据 seam；SQLite、storage worker、Personal Context、Model Access、Loop、IPC 和 renderer 使用真实实现。
4. Agent 失败时字幕 stop、历史和文本导出仍成立。
5. 日志、报告和 evidence JSON 不含正文、音频、路径、凭据、设备名、绝对单调时刻、金额或 provider 原始事件。

## 6. 状态规则

- P1–P4 达到代码和定向测试条件：`实现完成·尚未验收`。
- S5 子边界的 J22/J24/J26 真实联合证据和受影响 lane 达到条件：仍为
  `实现完成·尚未验收`，不得据此晋级。
- 正式 MVP 只有在 J21、J22、J24、J25、J26、J27 总门槛和适用实机证据均成立时，
  才能记录 `联合验收完成`。
- 未满足条件时不得使用无修饰的“完成”“可用”或“测试通过”。

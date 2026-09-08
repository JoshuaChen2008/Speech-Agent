# 正式 Agent MVP 实施 Todo / Spec

> 状态：已决定
>
> 本文只负责把正式 MVP 拆成可执行任务。语义权威仍是 `CONTEXT.md`、
> `docs/semantic-contract.md`、`docs/testing-strategy.md` 与现有 ADR。
> `src/agent-mvp` 是隔离开发入口，不计入正式 MVP 证据。

> 2026-09-08 核对：当前工作树已有 Agent run contract/controller、preload 与窗口骨架；`src/main.js` 已接入 main-owned service、model-first route、user target scheduler 与真实 SQLite 执行边界，正式 renderer/export 仍是待收束项。以下复选框跟踪产品闭环，不表示对应目录完全没有代码。开发选测与阶段门禁统一见 `testing-strategy.md` §2.1，不要求每个小任务重复三条 lane。

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

- [ ] 复核 2026-08-31 基线中的 integration 8 项失败；GPU、utility、renderer 启动异常必须与产品断言分离，历史数字不冒充当前结果。
- [ ] 复核 I3 `productPayloadSha256` 的当前输入绑定；已有 `56b0237` 刷新记录，后续产品载荷变化仍需重验，不能按旧 TODO 断言修复缺失。
- [ ] 独立运行并记录 core / integration / evidence 三条 lane 的真实返回码。

### P1：合同与 facade（S5 change）

- [x] 统一 `agent-run-ui` 与旧 eligibility contract；旧入口只保留兼容投影，不再维护第二套字段定义。
- [x] 补齐 submit/cancel/history/detail/export 的 exact request/result validator（实现完成·尚未验收；export response 与正式 renderer 已接入，完整联合旅程与阶段门禁证据仍待补齐）。
- [x] 实现 `AgentRunService`：资格、范围、输入冻结、幂等、状态机、取消、revision 和错误投影（实现完成·尚未验收；model-first route 与 user target scheduler 已接入）。
- [x] 用真实 `StorageGateway`、SQLite 和 `ModelAccessRuntime` 替换 [src/main.js](../src/main.js) 的占位 service（实现完成·尚未验收；依赖缺失时仍保持字幕生命周期独立）。

### P2：执行汇合（S5 change）

- [x] 将 `PersonalContextRuntime`、`IntentRouteOrchestrator`、`AgentLoopExecutor` 和 scheduler 接入 production main（实现完成·尚未验收；formal target runner 与 model-first route 已接线）。
- [x] `summary.minutes` 与 `qa.answer` 统一经过同一个 Agent Loop（实现完成·尚未验收；完整 minutes 旅程仍待补证）。
- [ ] `context.ingest.session` 仅在字幕提交 ACK 后异步启动（局部实现完成·尚未验收；S3 runner、自动 requestor 过滤与真实 SQLite 证据已保留，但 production main 当前未注入模型接入层，J21 自动摄取接线留后续）。
- [ ] 覆盖 provider 不可用、Schema 失败、超时、取消、重试、worker replacement 和迟到消息拒绝（局部实现完成·尚未验收；timeout/cancel/late-result 已有，replacement 与完整失败矩阵仍待补齐）。

### P3：Agent Bar（S5 change）

- [x] 提供终态会话范围列表和可见默认范围。（实现完成·尚未验收；正式 renderer 已接入 `getScopes`，真实 SQLite 联合旅程仍待补证。）
- [x] 提供纪要快捷操作和 QA 输入。（实现完成·尚未验收；请求仍由 exact preload facade 提交，完整 recipe 旅程仍待补证。）
- [x] 渲染 pending/running/succeeded/failed/cancelling/cancelled。（实现完成·尚未验收；取消等待 CommandResult，未知状态 fail closed。）
- [x] 渲染概要、结论、待办、风险、来源引用和可操作错误。（实现完成·尚未验收；缺口与待确认字段也按受控结果投影，未展示内部 ID/reasoning。）
- [x] reload 后先订阅 changed，再读取权威 snapshot/history。（实现完成·尚未验收；局部 UI 回归覆盖先订阅、历史与活动详情刷新。）
- [ ] 在工具条加入正式 Agent 入口。

### P4：历史与导出（S5 change）

- [x] 历史使用 `(terminal_at DESC, interaction_id)` keyset 分页。（实现完成·尚未验收；真实 SQLite 历史读取已有分页回归，正式联合验收仍待阶段门禁。）
- [x] `intent.route` 不进入用户历史列表。（实现完成·尚未验收；storage projection 已排除该内部 recipe。）
- [x] 详情默认折叠工具审计，展开仍受有界投影约束。（实现完成·尚未验收；Agent Bar 只显示受控工具元数据，导出保留已校验审计。）
- [x] main-owned 保存对话框写 canonical JSON；取消零写入。（实现完成·尚未验收；同目录临时文件 flush/close 后原子替换，取消与写入失败保持目标不变。）
- [x] 重复导出字节和 SHA-256 一致。（实现完成·尚未验收；真实 SQLite 旅程与 exporter 回归已覆盖。）

### P5：S5 子边界证据（不等同正式 MVP 联合验收）

- [ ] J22：Agent Bar → `summary.minutes` → SQLite interaction → 结果与历史详情（局部实现完成·尚未验收；正式 Agent Bar renderer 已接通 exact facade 并有局部 UI 回归，真实 preload/SQLite 纪要纵切仍待补证）。
- [ ] J24：取消、provider 不可用、重复停止、reload、字幕独立性（局部实现完成·尚未验收；renderer 已覆盖取消等待回执、changed reload 与状态投影，provider/字幕独立性和完整联合旅程仍待补证）。
- [x] J26：成功、失败和取消交互的确定性 JSON 导出。（实现完成·尚未验收；真实 SQLite 成功重导出、取消零写入、digest/顺序/隐私负扫描已有，阶段联合证据仍待补齐。）
- [ ] J21：终态会话 → `context.ingest.session` → 经历/记忆候选与管理（局部实现完成·尚未验收；S3 摄取子边界有真实 SQLite 旅程，production main 自动摄取与完整 J21 证据仍是后续门禁）。
- [ ] J27：正式入口与隔离入口的 userData/SQLite 边界（实现完成·尚未验收；require/打包守卫已有，隔离入口联合证据仍待补齐）。
- [ ] `.artifacts/` 与 `docs/validation/` 通过 SEM-F14 负扫描。

后续门禁索引（本 S5 不实施）：J21 后台摄取、J27 正式入口与旧隔离入口的
userData/SQLite 隔离；完整 J25 模型接入层也继续由正式 MVP 总门槛追踪。

以上清单只记录 S5 子切片的实现与证据，不得据此记录「联合验收完成」。正式 MVP
仍须同时关闭 J21、J22、J24、J25、J26、J27；其中完整 J25 模型接入层仍是后续门禁。

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

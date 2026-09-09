## 1. Contract and service boundary

- [x] 1.1 Add the terminal-session scope request/response contract and register its channel in the semantic and testing ledgers.
- [x] 1.2 Add exact response validators for submit, cancel, history, interaction detail, and export; reject unknown versions, fields, credentials, paths, audio, and amount fields.
- [x] 1.3 Implement `AgentRunService` eligibility, scope projection, input freezing, idempotent submit, cancel, and monotonic changed revisions, with model-first convergence delegated through the execution host (实现完成·尚未验收；正式 preload/controller reload 旅程已纳入真实 Agent Bar IPC 旅程，完整 J22/J24 阶段门禁仍待总验收).
- [x] 1.4 Replace the placeholder main service with the real service composition and preserve the subtitle window lifecycle when Agent dependencies fail (实现完成·尚未验收；main-owned route/target scheduler and dependency fail-closed wiring已接入).
- [x] 1.5 Add contract/main tests for duplicate keys, non-terminal sessions, reload ordering, cancellation, and unavailable provider facts (SEM-F31/F32/J22/J24；实现完成·尚未验收；exact response revalidation、同 key 不同载荷拒绝、先订阅后读取、取消回执与 provider 资格投影由 contract/main/UI 回归和真实 Agent Bar IPC 旅程覆盖；`npm run test:core` 842/842、`npm run test:integration` 82/82).

## 2. Execution and SQLite convergence

- [x] 2.1 Add the production OpenAI-compatible Loop adapter behind Model Access; keep credential borrowing and origin/redirect checks inside the access layer. (局部实现完成·尚未验收；定向 Model Access/S2/S3 回归 23/23，Luna 语义审查通过；完整 J25/J24 仍待 S5-Integration)
- [x] 2.2 Connect target execution to Personal Context resolve, Intent Route Orchestrator, Agent Loop, controlled tools, budget enforcement, and the scheduler using real storage interfaces (实现完成·尚未验收；summary.minutes/qa.answer target runner 与 user claim filter 已接入，非 session scope 明确 fail closed，完整失败矩阵仍待 2.5).
- [x] 2.3 Preserve request-to-route/target identity and restart terminalization without storing prompt text, and freeze the Personal Context projection revision through an additive v8 migration (SEM-F28/J22；实现完成·尚未验收；route/target client key、interaction digest 与 prompt 清理已有定向覆盖；`personal_context_revision` guard 的 route/target 同一绑定仍待真实联合验证).
- [x] 2.4 Implement atomic interaction terminalization, result/schema validation, tool audit ordering, retry preservation, and late-generation rejection (实现完成·尚未验收；SQLite late-success rejection、取消与工具审计已有真实 storage 覆盖).
- [x] 2.5 Add runtime/storage/integration tests for minutes, QA, rules fallback, unsupported UI recipe, provider timeout, schema failure, budget exhaustion, cancellation, and replacement (SEM-F15/F16/F28/F33/J22/J24；实现完成·尚未验收；`summary.minutes`/`qa.answer`、规则兜底、provider timeout/schema/budget、取消和迟到结果由 runner/orchestrator/scheduler 及本地真实 SQLite 目标旅程覆盖；worker replacement 由 `test/runtime/formal-agent-job-scheduler.test.js` 与既有 utility-process integration 证据覆盖，未把本地 S5 目标旅程写成 replacement 证明；当前三条 lane 已按受影响范围收束，完整 J22/J24 阶段门禁仍待总验收).

## 3. Agent Bar and history

- [x] 3.1 Implement the terminal-session scope projection and empty-state behavior in the formal Agent window (实现完成·尚未验收；真实 preload/SQLite 路径已纳入 Agent Bar IPC 旅程和本地 SQLite 目标旅程，正式 MVP 阶段门禁仍待总验收).
- [x] 3.2 Implement minutes shortcut, QA input, product-language routing feedback, explicit pending/running/cancelling/terminal states, and no optimistic success (实现完成·尚未验收；正式 renderer 已消费 exact run contract，完整 recipe/失败矩阵仍待补证).
- [x] 3.3 Implement result rendering for summary, conclusions, action items, risks, gaps, open questions, and source references without exposing internal IDs or reasoning (实现完成·尚未验收；工具审计默认折叠，完整结果 schema 仍由 Core 校验).
- [x] 3.4 Implement subscribe-before-read reload and paged interaction history/detail with collapsed tool audit (实现完成·尚未验收；UI 回归与真实 preload/SQLite 旅程覆盖 reload、分页、迟到 detail 和默认折叠工具审计).
- [x] 3.5 Add the formal Agent entry to the toolbar action surface and prove open/focus/close behavior keeps subtitle windows and the active session independent (SEM-F31/J22/J24；实现完成·尚未验收；`agent` action 已接入工具条并验证打开、复用、聚焦、关闭，真实 Electron 旅程确认字幕窗口与活动会话继续工作；`test:core` 842/842、`test:integration` 82/82).
- [x] 3.6 Add UI/integration tests proving subtitle stop/history/text export remain functional when Agent is disabled, unavailable, cancelled, or fails (SEM-F31/F35/J24；实现完成·尚未验收；证据按旅程分层：`formal-agent-lifecycle-journey.test.js` 的真实 SQLite eligibility 旅程确认 `agent_disabled` 策略下先关闭字幕、再读取历史/文本导出；真实 Electron Agent Bar 旅程在 `provider_not_configured` 检查前完成字幕启动/停止，随后验证 Agent 窗口关闭后已停止会话的历史/文本导出；本地真实 SQLite S5 目标旅程确认取消回执进入 `cancelling` 后由独立 recorder 关闭字幕并读取历史/文本导出，Schema 失败收束为 `failed` 后同样由独立 recorder 关闭字幕并读取历史/文本导出。这些是分层的 SQLite/窗口边界证据，不声称单条活动 `SessionCoordinator`/Agent Bar 失败旅程覆盖全部模式，完整 J24 阶段门禁仍待总验收；`test:evidence` 229/229 且隐私负扫描无违规).

## 4. Deterministic export and evidence

- [x] 4.1 Implement main-owned save-dialog and canonical JSON export from one validated SQLite snapshot。（实现完成·尚未验收；`AgentInteractionExporter` 只由 main-owned `AgentRunService` 调用，读取单次 `StorageGateway` 交互详情。）
- [x] 4.2 Implement same-directory temporary write, atomic replacement, cancellation zero-write, old-target preservation, and cleanup on failure。（实现完成·尚未验收；文件 flush/close 后原子替换，取消与故障不触碰既有目标。）
- [x] 4.3 Add export tests for succeeded, failed, cancelled, multi-attempt, usage-known/unknown, tool order, digest mismatch, and repeated-byte equality。（SEM-F35/J26；实现完成·尚未验收；包含进程内真实 SQLite 的 J26 局部证据与 exporter/renderer 定向回归；正式 renderer/preload/保存对话框联合旅程仍待补齐。）
- [x] 4.4 Add privacy negative scans for prompt, reasoning, provider events, credentials, audio, paths, device names, absolute monotonic times, and amount fields。（实现完成·尚未验收；共享 Agent UI privacy validator 与 exporter snapshot validator 均 fail closed。）
- [x] 4.5 Record S5 sub-boundary evidence and update the minimal-chain spec/TODO with precise implementation and acceptance states; leave J21/J27/full J25 marked as follow-up。（实现完成·尚未验收；SEM-F35/J26 状态已更新，J21/J27/完整 J25 未提前晋级。）
- [x] 4.6 Run affected core/integration/evidence lanes, have the semantic/function review performed by `gpt-5.6-luna`, and commit only after the review is clean。（实现完成·尚未验收；renderer 验证、30 项受影响 focus、OpenSpec validate 与本轮 Luna 复核均通过。）
- [x] 4.7 Record current-revision S5-Integration evidence with exact commands, return codes, affected Electron boundaries, privacy scan result, and the remaining J21/J25/J27 blockers (SEM-F35/SEM-T03/J22/J24/J26；实现完成·尚未验收；S5 实现 revision `adcfa31` 记录 `npm run test:core` 842/842、Electron/utility 可运行环境下 `npm run test:integration` 82/82、`npm run test:evidence` 229/229 与 `npm run verify:renderer` 返回码 0；受限沙箱的 Electron GPU 启动失败单独归为执行环境边界，J21/J25/J27 仍为后续阻断项).

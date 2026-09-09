## 1. Contract and service boundary

- [x] 1.1 Add the terminal-session scope request/response contract and register its channel in the semantic and testing ledgers.
- [x] 1.2 Add exact response validators for submit, cancel, history, interaction detail, and export; reject unknown versions, fields, credentials, paths, audio, and amount fields.
- [x] 1.3 Implement `AgentRunService` eligibility, scope projection, input freezing, idempotent submit, cancel, and monotonic changed revisions, with model-first convergence delegated through the execution host (实现完成·尚未验收；正式 renderer/preload reload 旅程仍待 S5-UX).
- [x] 1.4 Replace the placeholder main service with the real service composition and preserve the subtitle window lifecycle when Agent dependencies fail (实现完成·尚未验收；main-owned route/target scheduler and dependency fail-closed wiring已接入).
- [ ] 1.5 Add contract/main tests for duplicate keys, non-terminal sessions, reload ordering, cancellation, and unavailable provider facts (SEM-F30/F31/F32/J22/J24；局部实现完成·尚未验收；补齐正式 preload/controller 的 response revalidation、同 key 不同载荷拒绝与 provider 资格投影，按受影响的 `test:core` 与 `test:integration` 入口验证).

## 2. Execution and SQLite convergence

- [x] 2.1 Add the production OpenAI-compatible Loop adapter behind Model Access; keep credential borrowing and origin/redirect checks inside the access layer. (局部实现完成·尚未验收；定向 Model Access/S2/S3 回归 23/23，Luna 语义审查通过；完整 J25/J24 仍待 S5-Integration)
- [x] 2.2 Connect target execution to Personal Context resolve, Intent Route Orchestrator, Agent Loop, controlled tools, budget enforcement, and the scheduler using real storage interfaces (实现完成·尚未验收；summary.minutes/qa.answer target runner 与 user claim filter 已接入，非 session scope 明确 fail closed，完整失败矩阵仍待 2.5).
- [x] 2.3 Preserve request-to-route/target identity and restart terminalization without storing prompt text, and freeze the Personal Context projection revision through an additive v8 migration (SEM-F28/J22；实现完成·尚未验收；route/target client key、interaction digest 与 prompt 清理已有定向覆盖；`personal_context_revision` guard 的 route/target 同一绑定仍待真实联合验证).
- [x] 2.4 Implement atomic interaction terminalization, result/schema validation, tool audit ordering, retry preservation, and late-generation rejection (实现完成·尚未验收；SQLite late-success rejection、取消与工具审计已有真实 storage 覆盖).
- [ ] 2.5 Add runtime/storage/integration tests for minutes, QA, rules fallback, unsupported UI recipe, provider timeout, schema failure, budget exhaustion, cancellation, and replacement (SEM-F15/F16/F28/F33/J22/J24；局部实现完成·尚未验收；QA、rules fallback、timeout、schema/cancel 子集已有，正式 renderer 纵切、minutes、预算耗尽、replacement 与迟到结果矩阵仍待补齐，按 `test:runtime`/`test:storage`/`test:integration` 入口验证).

## 3. Agent Bar and history

- [x] 3.1 Implement the terminal-session scope projection and empty-state behavior in the formal Agent window (实现完成·尚未验收；真实 preload/SQLite 联合旅程仍待 S5-Integration).
- [x] 3.2 Implement minutes shortcut, QA input, product-language routing feedback, explicit pending/running/cancelling/terminal states, and no optimistic success (实现完成·尚未验收；正式 renderer 已消费 exact run contract，完整 recipe/失败矩阵仍待补证).
- [x] 3.3 Implement result rendering for summary, conclusions, action items, risks, gaps, open questions, and source references without exposing internal IDs or reasoning (实现完成·尚未验收；工具审计默认折叠，完整结果 schema 仍由 Core 校验).
- [x] 3.4 Implement subscribe-before-read reload and paged interaction history/detail with collapsed tool audit (实现完成·尚未验收；局部 UI 回归覆盖 reload/迟到 detail，真实 SQLite 联合旅程仍待 S5-Integration).
- [ ] 3.5 Add the formal Agent entry to the toolbar action surface and prove open/focus/close behavior keeps subtitle windows and the active session independent (SEM-F30/J22/J24；验证 `test:ui` 与 `test:integration` 的真实窗口路由边界).
- [ ] 3.6 Add UI/integration tests proving subtitle stop/history/text export remain functional when Agent is disabled, unavailable, cancelled, or fails (SEM-F00/F31/F35/J24；验证 `test:integration` 与 `test:evidence` 的字幕系统独立性和隐私负路径).

## 4. Deterministic export and evidence

- [x] 4.1 Implement main-owned save-dialog and canonical JSON export from one validated SQLite snapshot。（实现完成·尚未验收；`AgentInteractionExporter` 只由 main-owned `AgentRunService` 调用，读取单次 `StorageGateway` 交互详情。）
- [x] 4.2 Implement same-directory temporary write, atomic replacement, cancellation zero-write, old-target preservation, and cleanup on failure。（实现完成·尚未验收；文件 flush/close 后原子替换，取消与故障不触碰既有目标。）
- [x] 4.3 Add export tests for succeeded, failed, cancelled, multi-attempt, usage-known/unknown, tool order, digest mismatch, and repeated-byte equality。（SEM-F35/J26；实现完成·尚未验收；包含进程内真实 SQLite 的 J26 局部证据与 exporter/renderer 定向回归；正式 renderer/preload/保存对话框联合旅程仍待补齐。）
- [x] 4.4 Add privacy negative scans for prompt, reasoning, provider events, credentials, audio, paths, device names, absolute monotonic times, and amount fields。（实现完成·尚未验收；共享 Agent UI privacy validator 与 exporter snapshot validator 均 fail closed。）
- [x] 4.5 Record S5 sub-boundary evidence and update the minimal-chain spec/TODO with precise implementation and acceptance states; leave J21/J27/full J25 marked as follow-up。（实现完成·尚未验收；SEM-F35/J26 状态已更新，J21/J27/完整 J25 未提前晋级。）
- [x] 4.6 Run affected core/integration/evidence lanes, have the semantic/function review performed by `gpt-5.6-luna`, and commit only after the review is clean。（实现完成·尚未验收；renderer 验证、44 项受影响 focus、OpenSpec validate 与 Luna 复核均通过。）
- [ ] 4.7 Record current-revision S5-Integration evidence with exact commands, return codes, affected Electron boundaries, privacy scan result, and the remaining J21/J25/J27 blockers (SEM-F35/SEM-T03/J22/J24/J26；按 `test:core`、`test:integration`、`test:evidence` 记录当前 revision；不使用 local fixture 或进程内 helper 结果作为联合证据).

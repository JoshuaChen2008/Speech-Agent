## 1. Contract and service boundary

- [x] 1.1 Add the terminal-session scope request/response contract and register its channel in the semantic and testing ledgers.
- [x] 1.2 Add exact response validators for submit, cancel, history, interaction detail, and export; reject unknown versions, fields, credentials, paths, audio, and amount fields.
- [x] 1.3 Implement `AgentRunService` eligibility, scope projection, input freezing, idempotent submit, cancel, and monotonic changed revisions, with model-first convergence delegated through the execution host (实现完成·尚未验收；正式 renderer/preload reload 旅程仍待 S5-UX).
- [x] 1.4 Replace the placeholder main service with the real service composition and preserve the subtitle window lifecycle when Agent dependencies fail (实现完成·尚未验收；main-owned route/target scheduler and dependency fail-closed wiring已接入).
- [ ] 1.5 Add contract/main tests for duplicate keys, non-terminal sessions, reload ordering, cancellation, and unavailable provider facts (局部实现完成·尚未验收；重复 key、非终态、取消与 provider 资格已有定向覆盖，正式 renderer reload 仍待 S5-UX).

## 2. Execution and SQLite convergence

- [x] 2.1 Add the production OpenAI-compatible Loop adapter behind Model Access; keep credential borrowing and origin/redirect checks inside the access layer. (局部实现完成·尚未验收；定向 Model Access/S2/S3 回归 23/23，Luna 语义审查通过；完整 J25/J24 仍待 S5-Integration)
- [x] 2.2 Connect target execution to Personal Context resolve, Intent Route Orchestrator, Agent Loop, controlled tools, budget enforcement, and the scheduler using real storage interfaces (实现完成·尚未验收；summary.minutes/qa.answer target runner 与 user claim filter 已接入，非 session scope 明确 fail closed，完整失败矩阵仍待 2.5).
- [x] 2.3 Preserve request-to-route/target identity and restart terminalization without storing prompt text, and freeze the Personal Context projection revision through an additive v8 migration (实现完成·尚未验收；route/target client key、interaction digest、prompt 清理与 `personal_context_revision` 一致性 guard 已由定向测试覆盖).
- [x] 2.4 Implement atomic interaction terminalization, result/schema validation, tool audit ordering, retry preservation, and late-generation rejection (实现完成·尚未验收；SQLite late-success rejection、取消与工具审计已有真实 storage 覆盖).
- [ ] 2.5 Add runtime/storage/integration tests for minutes, QA, rules fallback, unsupported UI recipe, provider timeout, schema failure, budget exhaustion, cancellation, and replacement (局部实现完成·尚未验收；QA、rules fallback、timeout、schema/cancel 子集已有，minutes/export/replacement 仍待补齐).

## 3. Agent Bar and history

- [ ] 3.1 Implement the terminal-session scope projection and empty-state behavior in the formal Agent window.
- [ ] 3.2 Implement minutes shortcut, QA input, product-language routing feedback, explicit pending/running/cancelling/terminal states, and no optimistic success.
- [ ] 3.3 Implement result rendering for summary, conclusions, action items, risks, gaps, open questions, and source references without exposing internal IDs or reasoning.
- [ ] 3.4 Implement subscribe-before-read reload and paged interaction history/detail with collapsed tool audit.
- [ ] 3.5 Add UI/integration tests proving subtitle stop/history/export remain functional when Agent is disabled or fails.

## 4. Deterministic export and evidence

- [ ] 4.1 Implement main-owned save-dialog and canonical JSON export from one validated SQLite snapshot.
- [ ] 4.2 Implement same-directory temporary write, atomic replacement, cancellation zero-write, old-target preservation, and cleanup on failure.
- [ ] 4.3 Add export tests for succeeded, failed, cancelled, multi-attempt, usage-known/unknown, tool order, digest mismatch, and repeated-byte equality.
- [ ] 4.4 Add privacy negative scans for prompt, reasoning, provider events, credentials, audio, paths, device names, absolute monotonic times, and amount fields.
- [ ] 4.5 Record S5 sub-boundary evidence and update the minimal-chain spec/TODO with precise implementation and acceptance states; leave J21/J27/full J25 marked as follow-up.
- [ ] 4.6 Run affected core/integration/evidence lanes, have the semantic/function review performed by `gpt-5.6-luna`, and commit only after the review is clean.

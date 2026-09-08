## 1. Contract and service boundary

- [x] 1.1 Add the terminal-session scope request/response contract and register its channel in the semantic and testing ledgers.
- [ ] 1.2 Add exact response validators for submit, cancel, history, interaction detail, and export; reject unknown versions, fields, credentials, paths, audio, and amount fields.
- [ ] 1.3 Implement `AgentRunService` eligibility, scope projection, input freezing, idempotent submit, cancel, and monotonic changed revisions.
- [ ] 1.4 Replace the placeholder main service with the real service composition and preserve the subtitle window lifecycle when Agent dependencies fail.
- [ ] 1.5 Add contract/main tests for duplicate keys, non-terminal sessions, reload ordering, cancellation, and unavailable provider facts.

## 2. Execution and SQLite convergence

- [ ] 2.1 Add the production OpenAI-compatible Loop adapter behind Model Access; keep credential borrowing and origin/redirect checks inside the access layer.
- [ ] 2.2 Connect target execution to Personal Context resolve, Intent Route Orchestrator, Agent Loop, controlled tools, budget enforcement, and the scheduler using real storage interfaces.
- [ ] 2.3 Add the smallest migration or storage command needed to preserve request-to-route/target identity and restart terminalization without storing prompt text.
- [ ] 2.4 Implement atomic interaction terminalization, result/schema validation, tool audit ordering, retry preservation, and late-generation rejection.
- [ ] 2.5 Add runtime/storage/integration tests for minutes, QA, rules fallback, unsupported UI recipe, provider timeout, schema failure, budget exhaustion, cancellation, and replacement.

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

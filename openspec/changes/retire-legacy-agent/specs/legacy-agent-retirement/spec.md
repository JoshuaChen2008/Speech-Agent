## ADDED Requirements

### Requirement: Exact retirement with immutable history
System SHALL remove old execution trees agent-core, agent-mvp, agent-provider, agent-runtime and exclusively old operations/tools/tests/docs after migrating applicable assertions. It MUST retain current support modules and SQL/checksums v1-v9. The only retired tables are agent_jobs, agent_claim_receipts, agent_artifacts, memory_scopes, memory_items, memory_revisions, memory_evidence, memory_suppressions, memory_deletion_receipts, agent_debug_threads, agent_debug_messages, recognition_terms, recognition_term_sets, recognition_term_set_members, recognition_session_configs and their exclusive indexes/triggers.
#### Scenario: Upgrade or fresh database
- **WHEN** the next formal migration commits
- **THEN** old objects are absent and subtitle, formal_agent_*, agent_model_*, personal_context_* and deletion tombstones are retained; removed operations are rejected.

### Requirement: Verified private snapshot before migrations
System MUST snapshot an existing not-yet-retired database before any migration in that startup, including committed WAL content, using SQLite VACUUM INTO. Unique backups SHALL inherit private directory permissions in migration-backups, never overwrite, upload, enter Git/logs/evidence, or expire automatically. Verification MUST reopen and check integrity, foreign keys, migration identity and deterministic data summaries.
#### Scenario: Backup fails
- **WHEN** permission, disk write or validation fails
- **THEN** no migration executes and no old table is deleted; a bounded classified failure is visible.
#### Scenario: WAL and retry
- **WHEN** committed WAL exists or a failed retirement is retried after restart
- **THEN** a fresh verified snapshot contains current committed data; prior valid backups remain.

### Requirement: Atomic retirement and explicit recovery boundary
System MUST remove objects, write migration record and update version in one transaction with foreign keys enabled. It SHALL handle nonempty cyclic memory and self-referential artifacts and keyword relations. Failure SHALL roll back and open only a validated committed catalog for subtitles/history/export, disabling Agent, ingestion and session deletion, with restart-to-retry status. Checksum corruption and unknown higher versions MUST fail closed.
#### Scenario: Migration interruption
- **WHEN** migration throws mid-transaction
- **THEN** prior data is intact and no unverified fallback suppresses retirement status.
#### Scenario: Successful restart
- **WHEN** retirement was committed before restart
- **THEN** no new retirement backup or deletion occurs.
#### Scenario: Restore
- **WHEN** the user explicitly restores a backup with the application fully exited
- **THEN** restoration follows documented manual instructions; no automatic overwrite of subsequent data occurs and independent MVP userData is untouched.

### Requirement: Session deletion compatibility
One formal deletion transaction SHALL preserve exact input/output, eligibility, idempotency, conflicts, tombstones and historical counts. New deletions SHALL set five old counts to zero, delete subtitle and current Agent/context associations, preserve shared context and invalidate deleted sources without legacyStore.
#### Scenario: Replay and conflict
- **WHEN** a prior key is replayed or reused for another session
- **THEN** the original receipt is returned unchanged or the existing conflict is rejected respectively, including nonzero historical counts.
#### Scenario: Atomic cleanup
- **WHEN** a terminal session is deleted or a cleanup failure occurs
- **THEN** current associations are deleted atomically with shared context retained, or the whole transaction rolls back; nonterminal sessions are refused.

### Requirement: Evidence and independent review
Delivery MUST preserve preexisting user changes, list dispositions, document backup/restore and actual test results, and include two independent read-only gpt-5.6-luna/max reviews (execution and semantics), with findings reviewed again by their author after fixes. Model substitution is forbidden. Full three lanes, production renderer and formal packaging SHALL target delivery state; environment failures are separate. Status remains 实现完成·尚未验收 if full lanes/packaging are not established, with no machine/release promotion.
#### Scenario: Delivery audit
- **WHEN** implementation is presented for delivery
- **THEN** no blocking finding remains for commit, residual old references are restricted to immutable history, retirement migration/tests/record/guards, and evidence contains no bodies, credentials, absolute paths or audio.

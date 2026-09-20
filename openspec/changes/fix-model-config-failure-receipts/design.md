## Context

`ModelAccessRuntime.configure()` serializes model configuration commands and uses a credential vault journal for `setCredential`, `clearCredential`, and profile deletion. Its lost-reply recovery helper currently receives every failed command on the clear path, so a failed non-credential command can be compared against an empty credential state and incorrectly treated as committed.

## Goals / Non-Goals

**Goals:**

- Make command settlement depend on the command's actual side effects.
- Keep vault prepare/commit/rollback and lost-reply recovery unchanged for credential operations.
- Prove the behavior through the existing production settings journey and focused runtime coverage.

**Non-Goals:**

- No new error codes, IPC channels, database columns, migrations, or provider behavior.
- No redesign of model settings UI or credential storage.

## Decisions

- **Command-scoped recovery:** Only `setCredential` may reconcile a prepared set token; only `clearCredential` and `deleteProfile` may reconcile a prepared clear token. Other commands propagate their storage failure directly. This is safer than inferring command success from a profile snapshot because an empty credential is not evidence that a profile update committed.
- **Token guard:** If no vault token was prepared, no credential reconciliation is attempted. Existing rollback behavior remains the fallback for a prepared token when the storage result cannot be observed.
- **Journey-first verification:** Add the rejection scenario to the existing J25 real settings journey, then retain focused runtime tests for the independent vault invariant. This avoids replacing a cross-module user capability with an isolated unit test.

## Risks / Trade-offs

- [Risk] A storage reply lost after a non-credential write could be harder to classify than a credential write. → The runtime will return the existing configuration failure rather than claim success; no new persistence protocol is introduced.
- [Risk] A regression could weaken credential lost-reply recovery. → Keep and rerun the existing committed-write-after-lost-reply and rollback tests.

## Migration Plan

No migration. Rollback is a code revert; existing vault journals and SQLite revisions remain compatible.

## Open Questions

None for this fix.

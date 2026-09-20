## 1. Registration and baseline

- [x] 1.1 Register the command-scoped failure semantics in `docs/semantic-contract.md` and the J25 failure matrix in `docs/testing-strategy.md` before code changes.
- [x] 1.2 Record the current revision (`709ebffd01e62d05f23ae413828b8f981d551c17`), focused targets (`test/main/model-access-vault-runtime.test.js`, `test/integration/agent-redesign-j25-formal-settings-journey.test.js`, `npm run verify:renderer`), and unrelated untracked path (`openspec/changes/fix-settings-input-styles/`); preserve them throughout the change.

## 2. Runtime fix

- [x] 2.1 Add a red runtime regression for a rejected non-credential configuration command on an uncredentialed profile.
- [x] 2.2 Restrict uncertain-write reconciliation to the command that prepared the corresponding credential-vault token, with a no-token guard.
- [x] 2.3 Run the existing credential rollback, lost-reply, stale-revision, and vault privacy tests and resolve any regression. Focused runtime result: 25/25, including direct persistent/session-only set, clear and delete lost-reply coverage.

## 3. Real journey and delivery checks

- [x] 3.1 Extend the production J25 settings journey to cover the rejected uncredentialed connection update and input retention.
- [x] 3.2 Run renderer verification and affected focused tests; renderer verification returned 0, focused runtime returned 22/22, and formal J25 returned 1/1. The run emitted only known Electron GPU virtualization diagnostics; no product assertion failed.
- [x] 3.3 Run the Luna/max semantic and logic review, address findings, then re-run the affected checks. The review found no P0/P1 drift; the J25 fixture proves the exact `MODEL_CONFIG_INVALID` receipt, unchanged revision, unchanged authoritative profile, retained input, and no model-changed broadcast after the rejected uncredentialed update. Re-checks: runtime 25/25, formal J25 1/1, and `git diff --check`.

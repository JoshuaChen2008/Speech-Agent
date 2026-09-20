## Why

The model settings path can treat a rejected non-credential configuration command as successfully settled when the profile has no credential. This produces a false success response and can make the settings surface close or advance even though the authoritative SQLite configuration and revision did not change.

## What Changes

- Keep non-credential configuration failures on the normal storage error path.
- Restrict credential reconciliation to credential-bearing commands whose vault token was prepared.
- Preserve existing revision-conflict, credential rollback, lost-reply recovery, and renderer input-retention behavior.
- Add a real J25 settings journey for an uncredentialed profile receiving a rejected connection update.

## Capabilities

### New Capabilities
- `model-config-failure-receipts`: Accurate failure and recovery semantics for main-owned model configuration commands.

### Modified Capabilities
- None.

## Impact

- Affects `ModelAccessRuntime` command settlement and the existing model-access/J25 tests.
- No IPC shape, SQLite schema, migration, credential-vault format, or public error-code expansion is required.

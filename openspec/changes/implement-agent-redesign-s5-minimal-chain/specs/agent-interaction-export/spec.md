## ADDED Requirements

### Requirement: Deterministic single-interaction export
The formal Agent service SHALL export one terminal interaction as a versioned canonical JSON snapshot read from one validated SQLite snapshot, including model identity, input and result digests, terminal reason, usage, relative duration, final result, and complete ordered tool-call audit.

#### Scenario: Successful export
- **WHEN** the user explicitly exports a succeeded interaction and chooses a save target
- **THEN** main validates the terminal snapshot and writes canonical JSON atomically, and repeated exports of the same interaction produce identical bytes and SHA-256

#### Scenario: Cancelled or failed export
- **WHEN** the selected interaction is cancelled or failed
- **THEN** the export remains allowed, preserves the terminal reason and null result where applicable, and never fabricates output

#### Scenario: User cancels or disk write fails
- **WHEN** the user cancels the save dialog or the temporary write/replace fails
- **THEN** no new target is written, an existing target remains unchanged, and no chosen filesystem path is persisted in SQLite, logs, or evidence

### Requirement: Export privacy boundary
The export SHALL exclude prompt text, intermediate assistant text, reasoning, provider events, credentials, audio or audio paths, local absolute paths, save-target paths, and price/cost/currency fields; usage is either a valid provider usage object or wholly unknown.

#### Scenario: Privacy validation
- **WHEN** a snapshot or generated export contains a forbidden field or an invalid digest/order/schema
- **THEN** export fails closed before writing and the service returns a stable bounded error projection

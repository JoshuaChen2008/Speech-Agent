## Context

S3/S4 already provide the fixed recipe registry, unified Agent Loop, controlled read-only tools, model-access runtime, personal-context runtime, scheduler, and v7 interaction/tool/presentation storage. The production main process currently exposes the Agent run channels through a placeholder service, while the `agent` window and preload facade are only a shell. The implementation must join those pieces without allowing renderer code to access SQLite, providers, credentials, or filesystem paths.

## Goals / Non-Goals

**Goals:**

- Freeze a terminal-session input from a real storage snapshot and create one idempotent formal Agent request.
- Run `summary.minutes` and `qa.answer` through intent convergence, model binding, the same Agent Loop, bounded tools, and the existing SQLite execution store.
- Expose authoritative status, result, history, tool audit, and deterministic export projections through exact main/preload contracts.
- Keep cancellation, replacement, reload, privacy, and subtitle-independence behavior observable in deterministic journeys.

**Non-Goals:**

- Do not add a second execution path, dynamic recipe registration, new tool, or new memory schema.
- Do not make application restart resume a request whose prompt cannot be reconstructed; such a request is explicitly terminal and can be submitted again.
- Do not implement the full J21 background ingest/interaction-signal management UI, J27 isolated-entry evidence, or open additional recipes in the Agent Bar.

## Decisions

1. **Main-owned orchestration service.** `AgentRunService` is the only production caller-facing composition root. It owns scope/eligibility snapshots, input freezing, request idempotency, changed revisions, cancellation, history/detail projections, and export coordination. Renderer-facing methods never return a provider, storage handle, credential, prompt text, or filesystem path.

2. **One durable request identity.** A submitted client key maps to a stable request identity and its route/target runs. Repeated identical submits return the existing request; a different payload with the same key is rejected. Route and target rows remain ordinary SQLite rows, while `intent.route` is excluded only from user-facing history/export projections.

3. **Real provider boundary with deterministic tests.** The production model adapter is OpenAI-compatible and uses the frozen model binding and credential borrow supplied by Model Access. Tests replace only the provider/network boundary with a bounded adapter; they do not replace SQLite, personal context, the Loop, IPC, or the renderer.

4. **Snapshot-first read path.** Scope resolution, personal-context resolution, interaction detail, and export read from one storage-worker transaction/snapshot. The service re-validates the result before returning it or writing an export, so a late replacement or malformed child response fails closed.

5. **Atomic export.** The main process owns the save dialog and target path. Canonical JSON is generated from a validated snapshot, written to a same-directory temporary file, flushed/closed, and atomically replaced. Cancel, validation failure, or write failure leaves the previous target untouched and removes the temporary file.

6. **Explicit restart terminal.** On a fresh main process, a running request whose input prompt is not recoverable is terminalized with the stable worker/restart failure projection and no result. No prompt is copied into a durable recovery table; the user can submit a new request against the same committed transcript.

## Risks / Trade-offs

- [Risk] The provider may resolve after cancellation or replacement. → Carry a generation/AbortSignal through Loop, tool calls, and commit; reject late results and retain only already-started audit rows.
- [Risk] Existing storage commands have exact schemas and differing camel/snake projections. → Add service-local adapters with exact validators and test every command/response at the IPC boundary.
- [Risk] The current window is only a page shell. → Build the smallest session-scope Agent Bar and history/detail surface first; leave unopened scopes visibly unavailable rather than inventing data.
- [Risk] Electron launch failures can mask product failures in CI. → Keep deterministic service/integration tests separate from Electron startup evidence and report the affected lane precisely.

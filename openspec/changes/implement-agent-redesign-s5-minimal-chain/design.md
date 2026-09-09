## Context

S3/S4 provide the fixed recipe registry, unified Agent Loop, controlled read-only tools, model-access runtime, personal-context runtime, scheduler, and v7/v8 interaction storage. The current worktree also contains the formal `agent` window, exact preload facade, main-owned `AgentRunService`, terminal-session scope projection, Agent Bar renderer, history/detail projections, and canonical exporter. The remaining work is to expose the toolbar entry and prove the path with real internal modules across the renderer, preload, main service, storage worker/SQLite, and subtitle lifecycle. Renderer code must never receive SQLite handles, providers, credentials, prompts, or filesystem paths.

## Goals / Non-Goals

**Goals:**

- Make the existing toolbar `agent` action open and close the formal Agent Bar without changing subtitle window focus, input, or stop behavior.
- Prove `summary.minutes` and `qa.answer` from a committed terminal session through the same Agent Loop, bounded tools, model binding, scheduler, SQLite interaction state, history/detail, and export projections.
- Cover cancellation, reload, idempotency, provider/Schema/budget failure, storage replacement, and late-result rejection at the real product boundary.
- Produce current-revision evidence that clearly separates local/fixture behavior from the S5-Integration journey.

**Non-Goals:**

- Do not add a second execution path, dynamic recipe registration, new controlled tool, new migration, or new memory schema.
- Do not make a fresh main process resume a request when its prompt cannot be reconstructed; terminalize it without a result and allow a new request against the same committed transcript.
- Do not implement J21 background ingestion, complete J25 settings/model comparison, J27 isolated-entry evidence, automatic report presentation, or additional Agent Bar recipes.

## Decisions

1. **Reuse the existing toolbar action.** The toolbar presents one product-language entry that sends the existing `agent` action. Main owns creation, focus, close, and destruction of the non-modal, non-penetrating Agent window; the toolbar and subtitle windows remain independent. A new toolbar-specific IPC channel or second window lifecycle is rejected because it would duplicate the existing action and security policy.

2. **Keep `AgentRunService` as the only caller-facing composition root.** Scope, eligibility, frozen input, idempotency, changed revisions, cancellation, history/detail, and export remain main-owned. Renderer-facing methods return only exact, privacy-bounded projections.

3. **Use one real vertical journey.** The integration harness must use the real renderer/preload/IPC, Personal Context, Model Access, Agent Loop, scheduler, storage worker, and SQLite. Only the registered external seams may be substituted: Agent model provider/network, system save dialog, and other unavailable system boundaries. Existing process-local host forwarding, manual execution adapters, and fixture facades remain local evidence only.

4. **Freeze identity before execution.** A submitted client key maps to one request, route/target identity, recipe/version, model binding, scope, transcript version, watermark, digest, and Personal Context revision. Retries reuse the binding and preserve prior `(attempt, call_order)` audit rows; a late generation cannot rewrite a terminal interaction.

5. **Read and export from one validated snapshot.** Scope, detail, and export use the StorageGateway snapshot boundary. The service revalidates identity, schema, digest, usage, result, and tool order before returning or writing. The main-owned save dialog supplies the target only to the writer, and cancel/validation/write failure leaves the previous target untouched.

6. **Keep explicit restart terminalization.** If a fresh main cannot recover the prompt, it records the stable restart/worker failure projection and removes in-memory prompt state. It never copies the prompt into a durable recovery table or renderer history.

## Risks / Trade-offs

- [Risk] A provider, tool, or storage response may arrive after cancellation or replacement. → Carry generation and cancellation through the Loop and commit, retain started audit rows, and reject late results.
- [Risk] The toolbar may open while the Agent service is unavailable. → Keep the action bounded and show the stable unavailable projection; do not block or mutate subtitle state.
- [Risk] Existing process-local integration helpers can look like a full product journey. → Label them as local evidence and require the real renderer/preload/storage-worker path for S5-Integration.
- [Risk] Electron launch failures can obscure product failures. → Keep deterministic contract/runtime checks separate from Electron startup evidence and report the affected lane with its actual return code.

## Migration Plan

No SQLite migration is required. Implement the toolbar action and integration coverage against the existing v8 schema and exact contracts. If a change later requires persistent fields, it must become a separate additive migration with unchanged prior checksums; rollback for this slice is limited to reverting the toolbar route, renderer wiring, and tests.

## Open Questions

There are no unresolved product decisions for this slice. J21, full J25, and J27 remain explicit follow-up gates, and no implementation choice in this change may promote them or add a second user journey.

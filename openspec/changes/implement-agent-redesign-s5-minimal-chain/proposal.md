## Why

The formal Agent window is currently wired to a placeholder service, so the product cannot carry a committed transcript from an Agent Bar request through model execution, SQLite history, and a deterministic export. The S3/S4 execution host and storage primitives now exist; this change joins them through the production main/preload/renderer boundary while preserving the subtitle system's independent lifecycle.

## What Changes

- Add a main-owned formal Agent run service for terminal-session scopes, eligibility, idempotent submission, cancellation, history, detail, and monotonic change notifications.
- Connect `summary.minutes` and `qa.answer` to the existing intent convergence, model binding, controlled tools, unified Agent Loop, scheduler, and SQLite execution store.
- Add the real terminal-session scope projection and minimal Agent Bar surface; keep other registered recipes unavailable in the UI with an explicit product response.
- Add bounded interaction detail with collapsed tool-call audit and a main-owned canonical JSON export with atomic writes and deterministic bytes.
- Add recovery and privacy evidence for cancellation, provider/schema/budget failure, renderer reload, storage replacement, late-result rejection, prompt cleanup, and subtitle independence.
- Record the remaining J21 background-ingest, J27 isolated-entry evidence, and full J25 acceptance as follow-up work; this change does not relabel those journeys as accepted.

## Capabilities

### New Capabilities

- `formal-agent-run`: production formal Agent request lifecycle from a committed transcript scope through result/history projections.
- `agent-interaction-export`: deterministic, privacy-bounded export of one terminal formal Agent interaction.

### Modified Capabilities

None. Existing semantic-contract requirements remain authoritative; this change supplies their missing production implementation and evidence.

## Impact

- Main composition in `src/main.js`, formal Agent service, model execution adapter, scheduler and storage gateway wiring.
- Versioned Agent run contracts, IPC channels, preload facade, Agent renderer, SQLite command projections, and canonical export writer.
- New integration/evidence tests under the existing `test/{main,runtime,storage,ui,integration,validation}` lanes.
- No changes to subtitle event semantics, audio persistence policy, recipe registry, model-purpose vocabulary, or the old isolated Agent entry point.

## Why

S5 Core has now supplied the formal Agent service, exact preload boundary, unified Agent Loop wiring, interaction history, and canonical single-interaction exporter. The remaining gap is the product-facing proof: the toolbar must open the formal Agent Bar, and one current-revision journey must cross the real renderer, preload, main service, storage worker/SQLite, and subtitle independence boundaries. This change keeps those requirements in one executable slice without relabeling the unfinished J21, J25, or J27 journeys.

## What Changes

- Add the formal Agent Bar entry to the existing toolbar action and preserve the independent subtitle window lifecycle when the entry or Agent service is unavailable.
- Turn the current S5 request surface into one verifiable vertical journey for `summary.minutes` and `qa.answer`, using the existing terminal-session scope, eligibility, frozen input, model binding, Personal Context, controlled tools, Agent Loop, scheduler, and SQLite projections.
- Complete the remaining contract/main/runtime/storage/UI coverage for idempotency, unsupported recipes, provider and Schema failure, budget exhaustion, cancellation, reload, replacement, and late-result rejection.
- Keep interaction history, bounded detail, collapsed tool-call audit, and canonical JSON export aligned with the existing exact contracts; add the formal save-dialog handoff and subtitle-independence evidence.
- Record implementation versus local evidence versus S5-Integration evidence by current revision. J21 background ingestion, complete J25 settings/model comparison, and J27 isolated-entry userData/SQLite evidence remain follow-up gates.

## Capabilities

### New Capabilities

- `formal-agent-run`: formal Agent request lifecycle from a committed transcript scope through result, history, reload, cancellation, and product-entry projections.
- `agent-interaction-export`: deterministic, privacy-bounded export of one terminal formal Agent interaction from the formal terminal detail.

### Modified Capabilities

None. Existing semantic-contract requirements and J21/J22/J24/J25/J26/J27 definitions remain authoritative; this change adds the remaining S5 product-entry and integration behavior without creating a new journey identifier.

## Impact

- Toolbar command presentation and the existing `agent` window lifecycle in main/preload/renderer composition.
- S5 exact contracts, `AgentRunService`, execution-host/storage-worker/SQLite integration, formal Agent Bar renderer, and export handoff.
- Focused contract, main, runtime, storage, UI, integration, and evidence checks under the existing test lanes, plus current-revision status records.
- No new migration, recipe, controlled tool, provider category, subtitle event semantic, audio persistence behavior, or isolated Agent entry-point behavior.

## Current status (2026-09-09, implementation revision `adcfa31`)

The implementation now exposes the toolbar Agent entry and records the production Electron Agent Bar IPC path. The Electron journey completes subtitle start/stop before the `provider_not_configured` check, then verifies that closing Agent leaves the stopped session's history/export readable. A local real SQLite target journey covers `summary.minutes`/`qa.answer`, Agent Loop execution, history/detail, full tool audit, deterministic export, cancellation, and terminal Schema failure; its cancellation and post-failure subtitle recorder/history/export checks are local evidence rather than a production `SessionCoordinator`/Agent Bar failure-preservation journey. The existing eligibility journey records the `agent_disabled` subtitle history/export boundary. The current state remains `实现完成·尚未验收`. J21 background ingest, complete J25 settings/model comparison, J27 isolated-entry userData/SQLite evidence, and the full J22/J24/J26 stage gates remain follow-up conditions.

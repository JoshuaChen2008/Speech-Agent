## ADDED Requirements

### Requirement: Terminal-session scope projection
The formal Agent service SHALL expose only committed terminal sessions as the first Agent Bar scope directory, with the exact request/response projection `{contract_id, contract_version, limit, cursor}` → `{contract_id, contract_version, ok, error, scopes, next_cursor, default_scope, revision}`. Each `scopes[]` item SHALL contain only `{scope:{kind:'session',reference}, display_name, started_at, ended_at, state:'terminal'}`; `display_name` is a bounded non-empty string, `started_at` and `ended_at` are nullable RFC 3339 UTC wall-clock strings, `ended_at` is non-null for `terminal`, `cursor` is opaque keyset state, `limit` is bounded, and `default_scope` is either one returned session scope or `null`. The service SHALL derive the default recent scope from main-owned storage rather than renderer state.

#### Scenario: Recent terminal scopes
- **WHEN** the scope directory is requested and committed terminal sessions exist
- **THEN** the service returns a bounded, keyset-paged list of session identifiers and display-safe session metadata, with the newest terminal session selected as the default scope and no transcript text, device name, path, or audio field

#### Scenario: No eligible scope
- **WHEN** the scope directory is requested and no committed terminal session is available
- **THEN** the service returns an empty list with an explicit empty-state projection, no fabricated scope, and no model or storage write

### Requirement: Terminal-session Agent requests
The formal Agent service SHALL accept only a committed, terminal session scope for the first production Agent Bar slice, derive the raw transcript version, input watermark, input digest, and personal-context revision from main-owned storage, and expose only exact privacy-bounded projections to renderer code.

#### Scenario: Eligible terminal session
- **WHEN** the requested session is terminal and has at least one persisted first-pass final, Agent settings and provider credentials are eligible
- **THEN** the service returns a `ready` eligibility snapshot and a submission creates one frozen formal Agent request without exposing transcript text to the renderer

#### Scenario: Non-terminal or empty session
- **WHEN** the requested session is active, missing, or has no committed first-pass final
- **THEN** eligibility returns `session_not_terminal` or `no_committed_transcript`, no model run is created, and the next action remains `null`

### Requirement: Idempotent fixed-recipe execution
The service SHALL route a user intent through the registered convergence policy, run `summary.minutes` or `qa.answer` only through the unified Agent Loop with the registered tool grants and turn limit, and preserve one model binding across retries.

#### Scenario: Minutes request
- **WHEN** an eligible user submits a meeting-minutes intent for a terminal session
- **THEN** the service freezes the scope, creates the route/target formal runs, executes `summary.minutes` through the same Agent Loop used by other recipes, validates the exact output schema, and atomically stores the terminal interaction and result

#### Scenario: Route fallback
- **WHEN** model routing is unavailable, invalid, or returns a recipe outside the registered closed set
- **THEN** the service records `routing_mode=rules`, applies the documented deterministic rules, and when no rule matches converges to `qa.answer`; it never turns a routing failure into an unavailable capability and never invents a second execution path

#### Scenario: Unsupported UI capability
- **WHEN** the user intent explicitly selects a recipe that is registered but not open in this S5 Agent Bar
- **THEN** the service returns a stable bounded Agent Bar command projection with error code `AGENT_RUN_UNAVAILABLE`, does not create a target execution, does not write that UI code into `formal_agent_runs.error_code` or an interaction terminal reason, and does not reinterpret the request as another recipe

#### Scenario: QA request
- **WHEN** an eligible user submits a single question for a terminal session
- **THEN** the service freezes the same input contract, executes `qa.answer` through the same Agent Loop and `search_context` grant, validates `QaAnswerV1`, and exposes the result through the same history, detail, and export projections as a minutes interaction

#### Scenario: Duplicate submission
- **WHEN** the same client idempotency key and exact payload are submitted again
- **THEN** the service returns the existing request identity and does not create another target run, interaction, or presentation

### Requirement: Terminal cancellation and late-result rejection
The service SHALL make cancellation terminal, preserve already-started attempt and tool-call audit rows, and reject late provider, tool, or storage responses by generation.

#### Scenario: Cancel a running request
- **WHEN** the user cancels a pending or running request
- **THEN** the request reaches `cancelled`, has no fabricated result, remains readable in history/detail, and a later provider response cannot rewrite it

#### Scenario: Provider or schema failure
- **WHEN** the provider times out, exits, exceeds a budget, or returns an invalid registered output
- **THEN** the interaction reaches the matching stable task error, partial result is not committed, and the subtitle session/history remain unaffected

### Requirement: Authoritative change and history projections
The service SHALL publish a monotonic `agent-run:changed` revision, support subscribe-before-read reload, paginate user-visible interactions by `(terminal_at DESC, interaction_id ASC)`, and exclude `intent.route` from the user history list.

#### Scenario: Renderer reload
- **WHEN** the Agent window reloads while a request is pending or terminal
- **THEN** the renderer subscribes before reading the authoritative snapshot/history and an older revision cannot overwrite a newer state

#### Scenario: Interaction detail
- **WHEN** the user opens a terminal interaction
- **THEN** the detail contains the bounded result, model identity, usage state, source references, and complete `(attempt, call_order)` tool audit with the audit collapsed by default; it contains no prompt, reasoning, credential, provider event, path, audio, or amount field

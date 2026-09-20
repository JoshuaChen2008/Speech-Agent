## ADDED Requirements

### Requirement: Two-stage real-audio qualification
I2 and I3 real-audio qualification SHALL resolve the 临时字幕识别器, 权威识别器, VAD and required 精修模型资源 from one explicit read-only model root and SHALL pass both recognizers to the production realtime runtime. A run with a missing resource or a 临时字幕识别器 fault MUST NOT qualify the complete two-stage path.

#### Scenario: Complete two-stage model root
- **WHEN** all four approved resources and their model readiness proofs exist under the explicit model root
- **THEN** the runner uses the same captured frames for the 临时字幕识别器 and 权威识别器 and records only their identities, hashes, counters and bounded fault facts

#### Scenario: Missing or faulted draft recognizer
- **WHEN** the 临时字幕识别器 is missing, invalid, fails to start or degrades during the evidence run
- **THEN** the run fails closed for two-stage qualification without changing the authoritative transcript or saving transcript text or audio

### Requirement: Unattended bounded orchestration
The repository SHALL provide one unattended command that serially performs environment preflight, deterministic non-audio checks, a 75-second `loopback` I3 qualification and an exact five-run `loopback` I2 series. The command MUST terminate within fixed per-stage and overall bounds and MUST NOT request interactive recovery.

#### Scenario: All prerequisites are present
- **WHEN** the existing environment satisfies preflight and every stage succeeds
- **THEN** the command completes all stages, strictly verifies every report and produces a candidate-bound summary

#### Scenario: A prerequisite is absent
- **WHEN** a dependency, model readiness proof, controlled fixture or usable Electron environment is absent
- **THEN** the command records a stable environment blocker, skips only dependent stages and continues independent checks

#### Scenario: A product or evidence stage fails
- **WHEN** a child exits non-zero, times out, fails a product assertion, omits a report or produces a report rejected by its strict verifier
- **THEN** the command records the corresponding stable failure class, cleans up only processes and temporary resources it created, and does not substitute a retry or selected run

### Requirement: Privacy-safe qualification summary
The unattended summary SHALL contain only fixed identifiers, relative artifact references, enums, booleans, finite metrics and SHA-256 digests. It MUST reject transcript text, captured audio, credentials, device names, absolute paths, absolute monotonic timestamps and clock offsets.

#### Scenario: Safe summary reconstruction
- **WHEN** a verifier reconstructs a summary from the exact stage reports and exit sidecars
- **THEN** every digest and status matches and the privacy negative scan succeeds

#### Scenario: Unsafe or stale evidence
- **WHEN** a report contains a forbidden field, an unexpected file, a stale product identity or a mismatched digest
- **THEN** strict verification fails and the candidate is not reported as qualified

### Requirement: Qualification does not replace acceptance
Successful unattended qualification SHALL remain `实现完成·尚未验收` evidence and MUST NOT mark I2, I3 or I4 complete while their remaining physical and operator-observed scenarios are absent.

#### Scenario: Automated stages all pass
- **WHEN** the non-audio checks, 75-second qualification and five-run loopback series all pass
- **THEN** the summary lists `mic`, device removal, sleep/wake, native pointer and display matrices, two-hour soak and clean-machine release as remaining boundaries

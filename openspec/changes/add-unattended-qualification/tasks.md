## 1. Registration and runner baseline

- [x] 1.1 Register the unattended qualification boundary in the semantic contract and testing strategy before implementation.
- [x] 1.2 Add failing validation coverage proving the current I2/I3 runner omits the 临时字幕识别器 and that new evidence rejects this path.

## 2. Two-stage real-audio evidence

- [x] 2.1 Resolve all four approved resources from an explicit model root and pass the 临时字幕识别器 to the production realtime adapter in I2 and I3.
- [x] 2.2 Version the I2 child/series and I3 qualification evidence with model readiness and 临时字幕识别器 fault facts while keeping historical report verification compatible.
- [x] 2.3 Extend strict verifier tests for missing models, draft startup/runtime faults, identity mismatch, tampering and SEM-F14 privacy rejection.

## 3. Unattended orchestration

- [x] 3.1 Implement a bounded preflight and serial orchestrator for deterministic non-audio checks, I3 qualification and the exact five-run I2 loopback series.
- [x] 3.2 Add the package script and strict summary verifier with stable `pass/blocked/failed/skipped` outcomes, fresh-output enforcement and dependent-stage skipping.
- [x] 3.3 Cover absent resources, Electron launch failure, timeout, non-zero exit, missing/tampered reports, concurrency rejection and privacy scanning in existing validation/integration lanes.

## 4. Validation and delivery

- [x] 4.1 Focused runner/verifier tests pass 41/41; `npm run test:evidence` passes 236/236 after renderer typecheck/build.
- [x] 4.2 `npm run verify:unattended -- --output .artifacts/unattended-qualification-20260920` completed without changing the environment: deterministic non-audio stage passed and strict reconstruction passed; preflight recorded `model-bundle-missing`, so I3 qualification and I2 series were skipped as dependent stages. Overall result is `blocked`, not a product pass or failure.
- [x] 4.3 Luna/max completed three read-only review rounds. All P1 findings were resolved: unattended schema enforcement, four-resource I2 readiness evidence, output scanning, failure-artifact cleanup and dependency-state validation. Final review reported P0=0/P1=0; I2/I3/I4 remain 实现完成·尚未验收.

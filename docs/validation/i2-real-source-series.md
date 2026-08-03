# I2 real-source ASR evidence bundle — 2026-07-31

## Decision

The authoritative exit-bound bundle records five separate `loopback` runs and five separate `mic` acoustic-fixture runs through the real Electron audio host, X-ASR online model, Silero VAD, offline refinement worker and `SessionCoordinator` acceptance boundary. Every schema-v5 child report is paired with a schema-v1 exit sidecar written only after the external runner observed that exact Electron child exit with code 0 and did not terminate it; each source is then closed by one recursive schema-v6 series. All 10 runs produced a final and a refined caption; maximum final/refined CER is 0/0 for loopback and 0.035714/0 for mic, captured/sent/ingested frame counts match in every run, and all 12 recorded loss maxima are 0.

This is valid repeated-run, real-product-path evidence, but **I2 is not closed**. Frozen caption visibility P95 is 1158ms for `loopback` and 1005ms for `mic`, exceeding the unchanged `<1000ms` acceptance line by 158ms and 5ms respectively. I2 remains a per-source and scenario-complete gate. User-driven dragging, real pause/refine, device removal/change, sleep/wake and hard-crash recovery also remain unverified. I3 and I4 remain pending.

## Authoritative tracked bundle

The tracked evidence is one exact Gate 0C preflight, 10 exact child reports, 10 report-bound exit sidecars and two deterministic summaries. Each source directory contains exactly five report/sidecar pairs plus one series that recursively embeds all five pairs:

- [`i2-live-v5/gate-0c-preflight.json`](i2-live-v5/gate-0c-preflight.json), SHA-256 `0f9f7668751c64fbce922883421ead41680226126800e0b7f6b3da81b39840ef`, run `gate-0c-2026-07-31T09-52-00-521Z`, executed at `2026-07-31T09:52:13.999Z`;
- [`i2-live-v5/loopback/run-01.json`](i2-live-v5/loopback/run-01.json) through [`run-05.json`](i2-live-v5/loopback/run-05.json), the matching `run-01.exit.json` through `run-05.exit.json`, plus [`loopback/series.json`](i2-live-v5/loopback/series.json);
- [`i2-live-v5/mic/run-01.json`](i2-live-v5/mic/run-01.json) through [`run-05.json`](i2-live-v5/mic/run-05.json), the matching `run-01.exit.json` through `run-05.exit.json`, plus [`mic/series.json`](i2-live-v5/mic/series.json).

All three schemas are strict. Raw UTF-8 JSON is rejected before object validation when it has a BOM, invalid encoding, duplicate keys including escape-equivalent keys, non-finite numbers or trailing input; unknown or missing fields then fail closed. A schema-v1 sidecar binds `sourceId`, the exact schema-v5 report SHA-256 and the sole accepted outcome `exited-zero-without-runner-termination`. The schema-v6 series accepts exactly five ordered, unique report/sidecar pairs for one source and recursively verifies both digests and payloads. CI rebuilds both summaries from the exact tracked Gate report, 10 tracked children and 10 tracked sidecars, then requires byte-for-byte equality with the committed summaries.

This binding prevents an in-process `pass` report followed by a hang, timeout or runner kill from being counted green. It is not a cryptographic signature, remote attestation, hardware attestation or proof of a crash's root cause; it records only what the external runner observed for its exact child. Hosted CI checks the tracked evidence structure and reproducibility, but does not replay or attest local audio hardware.

## Frozen acceptance value and diagnostic trace

The only first-caption acceptance value remains **frozen caption visibility latency**: controlled playback source start plus the frozen 140ms corpus speech-onset offset, through the same first partial accepted by `SessionCoordinator` and delivered to its observer. Schema v5 does not change that origin, endpoint or `<1000ms` per-source P95 gate.

For diagnosis only, seven-sample minimum-RTT NTP-style calibration maps monotonic clocks across the playback renderer, audio-host renderer, realtime utility process and main process. Calibration finishes before a common future `source t0` is reserved; the capture probe is armed against that same time before playback is scheduled, so setup IPC cannot consume the frozen corpus's 140ms onset budget. Each child splits the exact accepted partial into six non-negative integer intervals that telescope exactly to its frozen latency. Persisted reports contain interval durations and safe calibration quality summaries only; they contain no clock offset or absolute monotonic timestamp.

| Source | Frozen visibility P50/P95/min/max | Frozen onset → VAD-start-frame receipt P95 | VAD-start frame → partial-trigger frame P95 | Trigger frame → utility ingress P95 | Utility ingress → publish P95 | Utility publish → main worker host P95 | Main worker host → Coordinator observer P95 |
|---|---:|---:|---:|---:|---:|---:|---:|
| `loopback` | 1133 / 1158 / 1092 / 1158ms | 729ms | 405ms | 1ms | 33ms | 1ms | 1ms |
| `mic` fixture | 875 / 1005 / 822 / 1005ms | 557ms | 500ms | 1ms | 28ms | 1ms | 1ms |

Percentiles in different columns can come from different child runs and must not be added as though they were one trace. Exact telescoping is enforced inside each child. The distribution indicates that the dominant budget is before and during the audio needed to trigger a partial, not utility publication or cross-process routing.

The audio-host energy threshold is a separate **captured energy onset** diagnostic and does not attribute energy to the corpus or a speaker. Its observation window has a fixed 40ms post-source guard: it ignores only the interval before `source t0 + 40ms`, while the authoritative acceptance origin remains `source t0 + 140ms`. The guard prevents pre-source ambient energy and sub-millisecond cross-clock uncertainty from becoming the diagnostic onset; it does not move the source clock, alter the frozen onset rule or remove any latency from the acceptance value. In this bundle, loopback `capturedOnsetMinusFrozenEstimateMs` P95 is +140ms and mic P95 is -99ms. The mic value means energy was already present immediately after the diagnostic guard, not that corpus speech started early; it must never reduce the frozen acceptance latency.

## Mic fixture boundary and privacy

Gate 0C classified the selected input using a label heuristic as `physical-preferred` and selected a `physical-speaker-preferred` output for acoustic replay. Each mic child binds the exact Gate report digest, run identity, anonymous input/output label hashes, fixture classification and generated-corpus/reference digests. The runtime then requires exactly one matching input label hash. This prevents an endpoint label from silently switching after preflight.

The canonical term is **physical-preferred label-heuristic acoustic fixture**. It is not hardware attestation: a label heuristic cannot rule out an unknown virtual endpoint or a spoofed virtual label, and the report does not claim that it can. Product startup still uses the system-selected default microphone; the anonymous hash selector is an evidence hook, not a product setting.

Captured PCM and decoded text remain in bounded memory. Reports contain metrics, fixed identifiers, privacy flags and hashes, but no transcript text, captured audio, audio path, device label, absolute clock or clock offset. The speech WAV is generated locally and ignored by Git; only its generator/reference inputs are tracked. Each report binds both the generated WAV digest and the reference digest, so a different generated stimulus or expected text cannot silently satisfy the evidence.

## Result summary

| Source | Runs | Final/refined | Max final/refined CER | Final after stimulus end P95 | Frame equality | 12 loss maxima | Report-bound external exit proof |
|---|---:|---:|---:|---:|---:|---:|---:|
| `loopback` | 5/5 pass | 5 / 5 | 0 / 0 | 710ms | all runs | all 0 | 5/5 |
| `mic` physical-preferred label-heuristic acoustic fixture | 5/5 pass | 5 / 5 | 0.035714 / 0 | 792ms | all runs | all 0 | 5/5 |

Accuracy, refinement, lossless transport, exact accepted-partial binding and report-bound external exit checks pass. The current loopback and mic batches exceed the frozen latency line by 158ms and 5ms respectively. Performance remains explicit I2 debt, and the remaining interaction/recovery scenarios also keep I2 open; neither a green schema result, captured-onset diagnostic nor Gate 0B naked-model benchmark closes it.

## 2026-08-03 exact-revision `loopback` supplement

Revision `b96b8fe7db5ba4db3ac36c4ee85371a4381b521f` restores the I2 evidence composition after the optional-refinement lifecycle began requiring both the session-frozen `refinementEnabled` preference and the runtime-frozen `refinementAvailable` capability. The runner now fails closed when the approved refinement model is absent. If a first-pass final exists after the fixed tail-silence window but its refined transcript version does not, the child observes the real offline refinement reply for at most 15,000ms on a monotonic clock. A timeout is sticky: even a reply arriving during the subsequent Stop flush cannot erase `refined-caption-missing`.

Diagnostic attempts made before both gates were explicitly frozen produced `refined-caption-missing` and were excluded from the series. The committed implementation then produced exactly five schema-v5 children, five report-bound schema-v1 exit sidecars and one schema-v6 recursive summary under [`i2-live-b96b8fe-loopback/`](i2-live-b96b8fe-loopback/). The summary SHA-256 is `2a365e3c6a1075336b9c7df65ad5b3ca36094a991d5b68532d15e65556ab1b48`; reconstruction from the exact child and sidecar bytes returns `pass`.

| Evidence boundary | Result |
|---|---:|
| Runs / exact-child exits | 5 / 5 |
| First-pass finals / refined transcript versions | 5 / 5 |
| Maximum final / refined CER | 0 / 0 |
| Frozen visibility P50 / P95 / min / max | 1144 / 1242 / 1054 / 1242ms |
| Six diagnostic P95 intervals | 814 / 400 / 1 / 28 / 1 / 1ms |
| All recorded transport loss maxima | 0 |
| Captured audio, transcript text, audio path or input path persisted | false |

The dominant diagnostic budget remains the interval from the frozen onset to VAD-start-frame receipt, followed by the audio needed from VAD start to the partial trigger. The six percentile columns can come from different children and are not additive. The unchanged acceptance value is the per-child frozen caption visibility latency, whose P95 is 1242ms and therefore still exceeds `<1000ms`.

This supplement proves the fixed `loopback` refinement composition, accuracy, transport, privacy and exit binding for the exact revision. It does not provide a same-revision `mic` series, physical-microphone evidence, user-driven native dragging, actual device removal, system sleep/wake, I3 or I4. It also does not replace the earlier two-source authoritative bundle. I2 remains 实现完成·尚未验收.

## 2026-08-03 realtime model replacement decision

The five exact children now make the next performance action explicit without moving the frozen origin or line. Their `audioNeededAfterCapturedOnsetMs` values are 776.562, 744.812, 735.375, 734.625 and 712.625ms. The slowest child telescopes to 1242ms as 814/400/0/27/0/1ms. In that same child, subtracting the 776.562ms model-audio duration and the 28ms after the trigger leaves an observed 437.438ms capture/VAD pre-trigger budget; meeting `<1000ms` under that observed composition requires a realtime model audio need below 534.562ms.

Gate 0B's tracked naked-model result for the same `zh-en-code-switch` corpus records P95=697.4775ms and maximum audio need=660ms for `x-asr-160ms`. The bounded provisional path is already the current implementation; local text-free runner diagnostics confirmed one 300ms provisional candidate was reused in each of the five runs, but those ignored logs are diagnostic support rather than new acceptance evidence. The tracked child reports and Gate 0B inputs are the evidence used for the decision.

This comparison is not proof of a physical model floor and does not rule out a separately registered capture-topology change. It supports a narrower engineering choice based on the current observed composition.

Status: **已决定** to stop this parameter-tuning round for the current realtime candidate and reopen Gate 0B replacement evaluation. No replacement model has been selected. A replacement must first satisfy the same corpus, quality, RTF and first-partial Gate 0B criterion, then rerun five `loopback` and five `mic` I2 children. `source t0 + 140ms`, `<1000ms`, Silero threshold/minimum durations, the 4×100ms pre-roll and 12×100ms provisional cap remain unchanged. The six trace intervals remain diagnostic and cannot replace the frozen acceptance value.

## Reproduction

Refresh the memory-only preflight first:

```powershell
.\scripts\run-electron-smoke.ps1 `
  -EntryPoint scripts\gate-0c\main.js `
  -EntryArguments @('--work-dir','.artifacts\gate-0c','--report','.artifacts\gate-0c\report.json','--duration-ms','2600')
node scripts\gate-0c\verify-report.js --report .artifacts\gate-0c\report.json
```

Run each source separately; XOR forbids concurrent `loopback` and `mic` sessions:

```powershell
.\scripts\run-i2-live-series.ps1 `
  -Source loopback -RunCount 5 `
  -OutputDirectory .artifacts\i2-live-series

.\scripts\run-i2-live-series.ps1 `
  -Source mic -RunCount 5 `
  -OutputDirectory .artifacts\i2-live-series `
  -PhysicalMicPreflight .artifacts\gate-0c\report.json
```

`run-i2-live-series.ps1` first delegates each exact Electron child to `run-electron-smoke.ps1`; that inner runner returns only after exit code 0, while timeout remains failure and cleanup targets only the exact process object rather than enumerating Electron by name. The series runner then applies `verify-i2-live-report.js` to the schema-v5 child and invokes `write-i2-exact-child-exit.js` for the schema-v1 sidecar. `summarize-i2-live-series.js` finally requires five report/sidecar pairs and rebuilds a schema-v6 deterministic recursive summary. None of these runners saves captured audio.

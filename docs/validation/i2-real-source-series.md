# I2 real-source ASR evidence bundle — 2026-07-31

## Decision

The authoritative schema-v4 bundle records five separate `loopback` runs and five separate `mic` acoustic-fixture runs through the real Electron audio host, X-ASR online model, Silero VAD, offline refinement worker and exact-process shutdown. All 10 runs produced a final and a refined caption, both sources have maximum final/refined CER 0, captured/sent/ingested frame counts are equal, and all 12 recorded loss maxima are 0.

This is a valid repeated-run, real-product-path evidence set, but **I2 is not closed**. First-partial P95 from estimated speech onset is 1126 ms for `loopback` and 1024 ms for `mic`; both exceed the frozen naked-model `<1000 ms` line. User-driven dragging, real pause/refine, device removal/change, sleep/wake and hard-crash recovery also remain unverified. I3 and I4 remain pending.

## Authoritative tracked bundle

The tracked evidence is one exact Gate 0C preflight, 10 exact child reports and two deterministic summaries that recursively embed their five child reports:

- [`i2-live-v4/gate-0c-preflight.json`](i2-live-v4/gate-0c-preflight.json), SHA-256 `43e97770e3508c88ff5843df2c897825f7e8b717bc1010fccb750c5beb2d1f0b`;
- [`i2-live-v4/loopback/run-01.json`](i2-live-v4/loopback/run-01.json) through [`run-05.json`](i2-live-v4/loopback/run-05.json), plus [`loopback/series.json`](i2-live-v4/loopback/series.json);
- [`i2-live-v4/mic/run-01.json`](i2-live-v4/mic/run-01.json) through [`run-05.json`](i2-live-v4/mic/run-05.json), plus [`mic/series.json`](i2-live-v4/mic/series.json).

The schema-v4 validator is strict and recursive: raw UTF-8 JSON is rejected before object validation when it has a BOM, invalid encoding, duplicate keys (including escape-equivalent keys), non-finite numbers or trailing input; unknown or missing fields then fail closed. Each child digest and invariant is checked; each summary's embedded child must equal the tracked child byte-for-byte after deterministic serialization. The authoritative series runner accepts exactly five children per source, validates every child before accepting it and self-validates its summary. CI rebuilds both embedded summaries from the exact tracked Gate report and 10 tracked children, then requires byte-for-byte equality with the committed summaries. These checks establish evidence integrity; hosted CI does not replay or attest the local audio hardware.

## Mic fixture boundary and privacy

Gate 0C classified the selected input using a label heuristic as `physical-preferred` and selected a `physical-speaker-preferred` output for acoustic replay. Each mic child binds the exact Gate report digest, run identity, anonymous input/output label hashes, fixture classification and generated-corpus/reference digests. The runtime then requires exactly one matching input label hash. This prevents an endpoint label from silently switching after preflight.

The canonical term is **physical-preferred label-heuristic acoustic fixture**. It is not hardware attestation: a label heuristic cannot rule out an unknown virtual endpoint or a spoofed virtual label, and the report does not claim that it can. Product startup still uses the system-selected default microphone; the anonymous hash selector is an evidence hook, not a product setting.

Captured PCM and decoded text remain in bounded memory. Reports contain metrics, fixed identifiers, privacy flags and hashes, but no transcript text, captured audio or audio path. The speech WAV is generated locally and ignored by Git; only its generator/reference inputs are tracked. Each report binds both the generated WAV digest and the reference digest, so a different generated stimulus or expected text cannot silently satisfy the evidence.

## Results

| Source | Runs | Final/refined | Max final/refined CER | First partial from estimated onset P50/P95/min/max | Final after stimulus end P95 | Frame equality | 12 loss maxima |
|---|---:|---:|---:|---:|---:|---:|---:|
| `loopback` | 5/5 pass | 5 / 5 | 0 / 0 | 1112 / 1126 / 1042 / 1126 ms | 722 ms | all runs | all 0 |
| `mic` physical-preferred label-heuristic acoustic fixture | 5/5 pass | 5 / 5 | 0 / 0 | 843 / 1024 / 819 / 1024 ms | 772 ms | all runs | all 0 |

The accuracy, refinement and lossless-transport checks pass. The latency acceptance line does not: even the mic product-path P95 exceeds the frozen naked-model line by 24 ms. Performance therefore remains explicit I2 debt for both sources; neither a green schema result nor the Gate 0B naked-model benchmark closes it.

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

`verify-i2-live-report.js` fails closed on every schema-v4 child. `summarize-i2-live-series.js` then rebuilds and validates the deterministic recursive summary. Neither runner saves captured audio.

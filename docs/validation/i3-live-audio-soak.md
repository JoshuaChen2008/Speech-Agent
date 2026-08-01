# I3 real audio soak acceptance

## 2026-08-01 qualification status

Two real loopback qualification runs were completed before any two-hour run was allowed to start:

| Run | Listening wall time | Playback/final/refined | Result |
| --- | ---: | ---: | --- |
| `.artifacts/audio-acceptance-20260801/i3-qualification-loopback-v3/report.json` | 61,426 ms | 23 / 23 / 21 | `fail/partial` |
| `.artifacts/audio-acceptance-20260801/i3-qualification-loopback-v4/report.json` | 60,479 ms | 24 / 24 / 22 | `fail/partial` |
| `.artifacts/audio-acceptance-20260801/i3-qualification-loopback-v5/report.json` | 77,243 ms | 31 / 31 / 29 | `pass/partial` |

The two historical 60-second runs passed every then-current qualification check except `captionsPersisted`. After the principled 75-second redesign below, v5 passed the strict qualification verifier with 31 finals: 14 before the forced worker exit and 17 after recovery, plus 29 refined segments. SQLite integrity, paging and all three exports, bounded resources, loss-free transport, exact worker hard-exit/Retry, post-recovery captions, and isolated-main stale-session recovery all passed. The qualification does not require or claim a native drag; no two-hour acceptance has started yet.

The fixed crash/recovery consumes a much larger fraction of a 60-second qualification than of the 7,200-second acceptance. The qualification is therefore now a fixed 75-second wall-clock run: it retains the 25-final total floor, injects the worker hard-exit at 30 seconds, and additionally requires at least 12 pre-recovery and 8 post-recovery finals. With the 2,180 ms scheduled cycle, 60 seconds left only 5,500 ms beyond 25 cycles, while 75 seconds leaves 20,500 ms; this allocates time for the fixed recovery without reducing a throughput threshold. The acceptance gate remains independently fixed at 3,000 finals in 7,200 seconds. Qualification reports remain `partial` and cannot close I3 acceptance.

All three reports state `capturedAudioPersisted: false`; after v5 the acceptance artifact tree was again scanned for captured `.wav/.mp3/.flac/.ogg/.m4a/.aac/.webm` files and contained none. The tracked/generated controlled stimulus is input test data, not captured audio.

`scripts/i3-live-audio-soak.js` is the I3 acceptance executor. It is not a shortened version of `i3-nonaudio-soak.js`:

- The default and only acceptance duration is a measured 7,200-second wall-clock listening period.
- It starts `SubtitleApplicationRuntime`, the real SQLite utility process, `SessionCoordinator`, `RealtimeRuntimeAdapter`, audio host, realtime ASR worker, and refinement worker when the approved refinement model is present.
- It replays a tracked short controlled utterance through a real WebAudio playback window. The fixture deterministically copies the first 1,000 ms of `models/gate-0b/corpus/zh-roadmap.wav` (including its 140 ms leading silence; expected audible prefix: “我们下周”), then appends 1,100 ms of digital silence. The WAV is 2,100 ms and each iteration has an explicit 80 ms WebAudio scheduling lead, so the real scheduled cycle is 2,180 ms: 3,302 theoretical cycles in two hours, safely above the 3,000-final acceptance threshold. The report binds the source-corpus SHA-256, source and derived reference SHA-256 values, slice length/sample count, scheduling lead, and derived-WAV SHA-256. Loopback and microphone runs are mutually exclusive. Microphone runs require a passing Gate 0C physical-preferred preflight and use that same label-hash-selected speaker for acoustic replay.
- A separate visible, long-lived BrowserWindow renders status. An operator must drag it once through the native window UI; programmatic movement is not accepted.
- Around the half-way point it intentionally terminates the realtime ASR utility process, waits for the recoverable product error, calls the product retry path, and requires post-recovery final captions.
- After the audio session ends, an isolated Electron main process commits an active SQLite session and exits without graceful cleanup. A fresh product runtime must recover that stale session as `interrupted`.
- It pages history, produces TXT/Markdown/SRT through `HistoryService`, hashes/counts them, then removes those temporary exports by default. Captured PCM is never written; the report includes no transcript text, device label, or absolute path.

The runner writes a safe progress JSON file beside the report by default. During the run it records `phase`, elapsed wall time, visible-window drag state, and worker-crash state only. This is the handoff point for controlled UI observation; it does not expose audio or transcript content.

The measured two-hour interval starts only after `SessionCoordinator` has returned success and published `listening`; it freezes immediately before the real coordinator stop call. Model loading, window setup, SQLite export/history work, and the later recovery proof are deliberately outside that number.

## Run

This operation plays the controlled speech repeatedly for roughly two hours and accesses the selected audio capture source. Obtain the operator's audio permission first. Do not run it in parallel with another loopback or microphone evidence run.

Generate (or regenerate) the ignored, deterministic I3 stimulus first. The generator has no SAPI or text-to-speech dependency: it reads the hash-pinned Gate 0B WAV, copies the tracked PCM slice, and appends zero-valued PCM silence. It never plays or captures audio. The acceptance runner rejects a missing file, a metadata mismatch, or a source/derived hash mismatch.

```powershell
.\scripts\generate-i3-live-stimulus.ps1
```

`ModelUserData` is a read-only model root, separate from this run's fresh Electron profile and SQLite directory. The default points to the workspace-local audited model-install artifact. The runner disables environment/repository model fallback, requires all realtime/refinement/VAD `.ready.json` markers, and records only marker and manifest SHA-256 values in its report—never the model path.

```powershell
.\scripts\run-i3-live-audio-soak.ps1 `
  -Source loopback `
  -ModelUserData .artifacts\model-install-live-20260731-3\user-data `
  -Report .artifacts\audio-acceptance\i3-loopback.json
```

For the acoustic microphone topology, a current passing Gate 0C preflight is mandatory:

```powershell
.\scripts\run-i3-live-audio-soak.ps1 `
  -Source mic `
  -ModelUserData .artifacts\model-install-live-20260731-3\user-data `
  -PhysicalMicPreflight .artifacts\audio-acceptance\gate-0c\report.json `
  -Report .artifacts\audio-acceptance\i3-mic.json
```

The wrapper has a 155-minute watchdog (the ordinary smoke wrapper is intentionally unsuitable because it caps runs at ten minutes). It runs the strict verifier after Electron exits:

```powershell
node .\scripts\verify-i3-live-audio-report.js .artifacts\audio-acceptance\i3-loopback.json
```

## Real-audio qualification short run

Run this before committing to the two-hour acceptance session when the generated short stimulus, device route, or model/VAD setup has changed. It is exactly 75 seconds and uses the same real Electron audio, ASR/VAD, SQLite/history/export, worker forced-exit/retry, and isolated SQLite stale-session recovery paths. The hard-exit is injected after the first completed cycle at or beyond the fixed 30-second point. It requires at least 25 final SQLite segments overall, including at least 12 before and 8 after recovery (and refined output when refinement is enabled), but it **cannot** satisfy I3 acceptance.

```powershell
.\scripts\run-i3-live-audio-soak.ps1 `
  -Mode qualification -TimeoutMinutes 10 `
  -Source loopback `
  -ModelUserData .artifacts\model-install-live-20260731-3\user-data `
  -Report .artifacts\audio-acceptance\i3-qualification-loopback.json
```

Its report has `kind: i3-live-audio-qualification`, `mode: qualification`, and `gateStatus: partial`. Use the opt-in qualification verifier:

```powershell
node .\scripts\verify-i3-live-audio-report.js --qualification `
  .artifacts\audio-acceptance\i3-qualification-loopback.json
```

The default verifier intentionally rejects that report as a full acceptance document.

## Non-audio test fixture

For parser/schema tests only, the executor has an explicit mode that does not initialize Electron audio, BrowserWindows, models, SQLite, or a capture source:

```powershell
.\node_modules\electron\dist\electron.exe .\scripts\i3-live-audio-soak.js `
  --mode synthetic-fixture --synthetic-segments 12 `
  --report .artifacts\i3-fixture.json
```

It writes `kind: i3-live-audio-soak-synthetic-fixture` with no full-acceptance boundary. `verify-i3-live-audio-report.js` rejects it by design.

## Full-pass boundary

The strict verifier accepts only `kind: i3-live-audio-soak`, `mode: acceptance`, and `result: pass`. It additionally requires all of the following:

- at least 7,200,000 measured listening milliseconds and at least 3,000 final SQLite segments;
- a real, visible, long-lived BrowserWindow with a native drag observation;
- no captured-audio artifact, bounded process/CPU/memory/gateway/history-query metrics, and loss-free post-recovery transport counters. The intentionally killed worker generation is reported separately; any in-flight loss there remains visible rather than being summed away or mislabeled as healthy;
- SQLite WAL/integrity, complete paged history and all three export hashes;
- worker hard-exit error/retry with post-recovery captions; and
- stale-session recovery after an isolated main-process forced exit.

Any shorter run, synthetic fixture, failed drag, missing recovery evidence, transcript/path leak, or unverifiable/provenance-drifted report remains non-acceptance evidence.

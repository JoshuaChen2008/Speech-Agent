# Gate 0B model validation

This directory keeps the reproducible parts of the Windows CPU model spike. Model archives, generated WAV files, and raw logs belong under ignored `models/gate-0b/` and must not be committed.

## Generate the controlled corpus

The generator requires the built-in Windows SAPI voices named in `corpus.json` and produces PCM16, 16 kHz, mono WAV files.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/gate-0b/generate-corpus.ps1
```

## Run the streaming latency benchmark

Install the official v1.13.4 N-API packages without changing the project manifest:

```powershell
npm install --no-save --package-lock=false sherpa-onnx-node@1.13.4 sherpa-onnx-win-x64@1.13.4
```

Then run, repeating `--wav` for each case:

```powershell
node scripts/gate-0b/streaming-bench.js `
  --model-dir models/gate-0b/extracted/x-asr/<model-directory> `
  --wav models/gate-0b/corpus/zh-en-code-switch.wav `
  --runs 5 `
  --chunk-ms 40 `
  --output models/gate-0b/runs/streaming.json
```

For older Zipformer archives whose metadata identifies `zipformer`, add `--model-type zipformer`; the script also detects their `encoder-epoch-*.int8.onnx` file names.

`firstPartialLatencyMs` is measured from the first two consecutive 20 ms windows above -45 dBFS to the first non-empty partial under wall-clock-paced input. `processingRtf` excludes pacing sleeps and measures the synchronous accept/decode/result work. Model initialization is reported separately as `modelLoadMs`.

The official CLI remains the source of the selection-level RTF used by Gate 0B. The N-API run adds the first-partial measurement and verifies that the production binding can load the selected model; it does not validate Electron worker integration.

## Reproduce CLI and refinement evidence

After extracting the five archives at the paths used by `run-cli-suite.js`, run the complete fixed suite. Parsed, path-free evidence is written to the tracked JSON; verbatim CLI logs stay in the ignored model directory and are tied to the report by SHA256.

```powershell
node scripts/gate-0b/run-cli-suite.js `
  --asset-root models/gate-0b `
  --raw-dir models/gate-0b/runs/cli-raw `
  --output docs/validation/gate-0b-cli-observations.json
```

Generate the refinement comparison directly from the fixed corpus and CLI observations—there is no manually transcribed intermediate file:

```powershell
node scripts/gate-0b/evaluate-transcripts.js `
  --corpus scripts/gate-0b/corpus.json `
  --observations docs/validation/gate-0b-cli-observations.json `
  --output docs/validation/gate-0b-controlled-metrics.json
```

## Reproduce the re-judgment evidence (M2/M3)

The 2026-07-27 re-judgment in `gate-0b-results.json` is backed by two tracked, path-free evidence files. Regenerate the M2 sweep summary from the ignored raw sweep outputs:

```powershell
node scripts/gate-0b/summarize-m2-sweep.js `
  --sweep-dir models/gate-0b/runs/m2-sweep `
  --output docs/validation/gate-0b-m2-sweep.json
```

Regenerate the M3 offline-refinement evaluation (runs the offline CLI, so it needs the extracted `x-asr-offline` model and the M2 sweep file for the x160-t4 baseline):

```powershell
node scripts/gate-0b/m3-offline-refine.js `
  --asset-root models/gate-0b `
  --observations docs/validation/gate-0b-cli-observations.json `
  --sweep models/gate-0b/runs/m2-sweep/x160-cli-threads.json `
  --raw-dir models/gate-0b/runs/m3 `
  --output docs/validation/gate-0b-m3-evaluation.json
```

`test/gate-0b/metrics.test.js` asserts that the re-judgment decision numbers equal these files, so a regeneration that changes results fails the suite instead of silently drifting.

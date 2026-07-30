# Gate 0C audio topology validation

This spike runs outside the product windows. It creates a dedicated non-persistent Electron session, a hidden audio-host window, and an independent zero-opacity player window. The player emits a fixed 997 Hz challenge through the Windows output mixer; the host captures loopback and a physical-preferred microphone through separate Web Audio graphs. A third diagnostic route sends the same challenge through VB-Cable and captures its audioinput endpoint, proving the deterministic microphone/Web Audio transport without pretending that a room microphone must acoustically hear the current output device.

Current Gate 0C runs never save captured audio. Each source probe is analyzed in memory and released; the runner writes only a structured report, progress log, and isolated Electron user-data directory under `.artifacts/gate-0c/`.

## Run on Windows

The repository's Electron dependency must already be installed. The test may play two short, faded audible tones; the VB-Cable challenge is virtual.

```powershell
$gate0cProcess = Start-Process `
  -FilePath '.\node_modules\electron\dist\electron.exe' `
  -ArgumentList 'scripts\gate-0c\main.js','--work-dir','.artifacts\gate-0c','--report','.artifacts\gate-0c\report.json','--duration-ms','2600' `
  -WindowStyle Hidden `
  -PassThru `
  -Wait

if ($gate0cProcess.ExitCode -ne 0) { throw "Gate 0C runner exited with $($gate0cProcess.ExitCode)" }
```

Verify the metrics-only report without any audio artifact:

```powershell
node scripts\gate-0c\verify-report.js `
  --report .artifacts\gate-0c\report.json
```

`capture-worklet.mjs` averages channels to mono, keeps resampling phase across 128-sample render quanta, and emits 1,600-sample (100 ms) frames at 16 kHz. The runner waits for the first Worklet frame before starting its wall-clock measurement, so device startup latency cannot shorten the recorded challenge.

## Pass conditions

- The display-media handler sees the dedicated host main frame, `file://` origin, audio + video requests, and `userGesture: true`; it returns a `desktopCapturer` screen source plus `audio: 'loopback'`.
- The host remains invisible at every required checkpoint: ready, trigger, all three first-PCM events, control probe, and completion. Missing checkpoints fail closed.
- All three separately executed source probes report a mono 16 kHz in-memory buffer with consistent sample and pipeline counts.
- Frame sequences and timestamps have no gaps/regressions, and captured duration stays within 10% of wall time.
- Loopback and the VB-Cable audioinput probe contain the independently played 997 Hz challenge. The physical microphone must come from a `physical-preferred` endpoint and contain non-DC activity; the deterministic probe must select both VB-Cable endpoints. All three routes must have no pre-clamp overflow, full-scale run, non-finite sample, clipping, or large adjacent/frame-boundary jump.

The virtual cable is diagnostic evidence only. Production microphone capture still uses the user-selected real input; Gate 0C requires both the live physical capture and the separately challenged audioinput pipeline to pass.

The no-user-gesture call is a control only. On the validated Electron/Windows combination it also resolved through the explicit display-media handler, but the selected production topology retains `executeJavaScript(..., true)` and records the handler's actual `request.userGesture`.

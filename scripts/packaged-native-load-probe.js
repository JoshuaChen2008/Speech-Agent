'use strict'

// @ts-check

/* Test-only utility entry. It proves that JS in app.asar can load the N-API
   addon and its adjacent unpacked DLLs. Only fixed booleans cross the port;
   native errors, paths and loader diagnostics are never persisted. */

let loaded = false
let apiSurfaceReady = false
try {
  const sherpa = require('sherpa-onnx-node')
  loaded = !!sherpa && typeof sherpa === 'object'
  apiSurfaceReady = loaded &&
    typeof sherpa.OnlineRecognizer === 'function' &&
    typeof sherpa.OfflineRecognizer === 'function' &&
    typeof sherpa.Vad === 'function'
} catch {
  loaded = false
  apiSurfaceReady = false
}

try {
  process.parentPort.postMessage({
    type: 'packaged-native-load-result',
    loaded,
    apiSurfaceReady
  })
} finally {
  setImmediate(() => process.exit(loaded && apiSurfaceReady ? 0 : 1))
}

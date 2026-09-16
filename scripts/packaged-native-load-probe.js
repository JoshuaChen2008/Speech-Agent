'use strict'

// @ts-check

/* Test-only utility entry. It proves that JS in app.asar can load the sherpa
   addon and the caption input N-API addon from their unpacked locations. Only
   fixed booleans cross the port; native errors, paths and loader diagnostics
   are never persisted. */

let loaded = false
let apiSurfaceReady = false
try {
  const { loadCaptionInputNative } = require('../src/main/caption-input-native')
  const sherpa = require('sherpa-onnx-node')
  const sherpaLoaded = !!sherpa && typeof sherpa === 'object'
  const sherpaApiReady = sherpaLoaded &&
    typeof sherpa.OnlineRecognizer === 'function' &&
    typeof sherpa.OfflineRecognizer === 'function' &&
    typeof sherpa.Vad === 'function'
  const captionAddon = loadCaptionInputNative({
    isPackaged: true,
    resourcesPath: process.resourcesPath
  })
  const captionLoaded = !!captionAddon && typeof captionAddon === 'object'
  const captionApiReady = captionLoaded &&
    typeof captionAddon.attach === 'function' &&
    typeof captionAddon.isAttached === 'function' &&
    typeof captionAddon.detach === 'function'
  loaded = sherpaLoaded && captionLoaded
  apiSurfaceReady = sherpaApiReady && captionApiReady
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

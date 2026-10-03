'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const { createRequire } = require('node:module')
const { EventEmitter } = require('node:events')
const { WORKER_PATH } = require('../../src/runtime/realtime-worker/worker-host')

test('SEM-F17/F21/J20 cloud worker ignores local configuration without loading native entry modules', () => {
  const parentPort = new EventEmitter()
  const messages = []
  const nativeLoads = []
  const realRequire = createRequire(WORKER_PATH)
  parentPort.postMessage = message => messages.push(message)
  // Loader observation only: every product module is its real implementation.
  const observedRequire = id => {
    if (['./sherpa-recognizer', './silero-vad', 'sherpa-onnx-node'].includes(id)) nativeLoads.push(id)
    return realRequire(id)
  }
  new Function('require', 'process', fs.readFileSync(WORKER_PATH, 'utf8'))(observedRequire, { parentPort, exit () {} })
  parentPort.emit('message', { data: { type: 'configure', sessionId: 'cloud', sourceIds: ['mic'],
    cloudAudio: true, recognizerProfile: 'missing-model', recognizer: { modelDir: 'missing' },
    draftRecognizer: { modelDir: 'missing' }, vad: { modelPath: 'missing' } } })
  assert.deepEqual(messages, [{ type: 'configured' }])
  assert.deepEqual(nativeLoads, [])
  parentPort.emit('message', { data: { type: 'configure', cloudAudio: true } })
  assert.equal(messages.at(-1).type, 'configure-failed')
  parentPort.emit('message', { data: { type: 'shutdown' } })
  assert.equal(messages.at(-1).type, 'stopped')
})

'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { REQUIRED_NLS_ENTRIES } = require('../../scripts/verify-package-layout')
const metadata = require('../../package.json')
const lock = require('../../package-lock.json')

test('SEM-F18/T12 J20 B5 NLS dependency entries are required and pinned as production dependencies', () => {
  for (const name of ['ws', '@alicloud/pop-core']) {
    assert.equal(lock.packages[''].dependencies[name], metadata.dependencies[name])
    assert.equal(lock.packages[`node_modules/${name}`].dev, undefined)
    for (const file of ['package.json', 'index.js']) assert.equal(REQUIRED_NLS_ENTRIES.includes(`/node_modules/${name}/${file}`), true)
  }
})

test('SEM-F18/T12 J20 B5 packaged load probe exercises NLS transitive dependency imports without connections', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../scripts/packaged-native-load-probe.js'), 'utf8')
  for (const missing of [null, 'ws', '@alicloud/pop-core']) {
    let result; let exitCode
    const imports = []
    vm.runInNewContext(source, {
      require: name => {
        imports.push(name)
        if (name === missing) throw new Error('missing package fixture')
        if (name === '../src/main/caption-input-native') return { loadCaptionInputNative: () => ({ attach () {}, isAttached () {}, detach () {} }) }
        if (name === 'sherpa-onnx-node') return { OnlineRecognizer () {}, OfflineRecognizer () {}, Vad () {} }
        return require(name)
      },
      process: { parentPort: { postMessage: value => { result = value } }, exit: code => { exitCode = code } },
      setImmediate: callback => callback()
    })
    assert.equal(exitCode, missing ? 1 : 0)
    assert.equal(result.apiSurfaceReady, !missing)
    assert.equal(imports.includes('ws'), true)
    if (missing !== 'ws') assert.equal(imports.includes('@alicloud/pop-core'), true)
    assert.deepEqual(Object.keys(result).sort(), ['apiSurfaceReady', 'loaded', 'type'])
  }
})

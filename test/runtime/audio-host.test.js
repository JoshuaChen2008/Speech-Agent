'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const test = require('node:test')
const { pathToFileURL } = require('node:url')
const path = require('node:path')

const CHANNELS = require('../../src/runtime/audio-host/channels')
const {
  MAX_DIAGNOSTIC_MS,
  MIN_DIAGNOSTIC_MS,
  evaluateDisplayRequest,
  isPermissionAllowed,
  publicError,
  scrubLocalPaths,
  selectScreenSource,
  validateDiagnosticOptions
} = require('../../src/runtime/audio-host/policy')
const {
  analyzeLevels,
  evaluateDiagnostic
} = require('../../src/runtime/audio-host/pcm-metrics')
const { AudioHostController, coerceSamples } = require('../../src/runtime/audio-host/audio-host-controller')

/* 假 electron：让 controller 生命周期与 IPC sender 校验可以脱离 Electron 测试。 */
function fakeElectron (overrides = {}) {
  return {
    ipcMain: { handle () {}, on () {}, removeHandler () {}, removeListener () {} },
    session: {
      fromPartition: () => ({
        setPermissionCheckHandler () {},
        setPermissionRequestHandler () {},
        setDisplayMediaRequestHandler () {}
      })
    },
    desktopCapturer: { getSources: async () => [] },
    screen: { getPrimaryDisplay: () => ({ id: 1 }) },
    BrowserWindow: class { constructor () { throw new Error('BrowserWindow unavailable in tests') } },
    ...overrides
  }
}

function validSavePayload (sessionId, sourceId) {
  return {
    sessionId,
    sourceId,
    samples: new Float32Array(26 * 1600 + 1000).fill(0.1),
    pipeline: {
      inputSampleRate: 48000,
      outputSampleRate: 16000,
      frameSamples: 1600,
      frameCount: 27,
      fullFrameCount: 26,
      tailFrameSamples: 1000,
      sequenceGapCount: 0,
      timestampRegressionCount: 0,
      sampleCount: 26 * 1600 + 1000,
      wallElapsedSeconds: 2.66,
      audioContextElapsedSeconds: 2.66
    }
  }
}

const moduleUrl = (name) =>
  pathToFileURL(path.join(__dirname, '..', '..', 'src', 'runtime', 'audio-host', name)).href

function sine (frequency, sampleRate, count, amplitude = 0.5) {
  const samples = new Float32Array(count)
  for (let index = 0; index < count; index += 1) {
    samples[index] = amplitude * Math.sin((2 * Math.PI * frequency * index) / sampleRate)
  }
  return samples
}

function validPipeline (overrides = {}) {
  return {
    inputSampleRate: 48000,
    outputSampleRate: 16000,
    frameSamples: 1600,
    frameCount: 27,
    fullFrameCount: 26,
    tailFrameSamples: 1000,
    sequenceGapCount: 0,
    timestampRegressionCount: 0,
    sampleCount: 26 * 1600 + 1000,
    wallElapsedSeconds: 2.66,
    audioContextElapsedSeconds: 2.66,
    ...overrides
  }
}

test('product resampler matches one-shot resampling across arbitrary block boundaries', async () => {
  const { StreamingLinearResampler } = await import(moduleUrl('streaming-resampler.mjs'))
  const input = sine(440, 48000, 4800)
  const oneShot = new StreamingLinearResampler(48000, 16000).push(input)

  const chunked = new StreamingLinearResampler(48000, 16000)
  const output = []
  const cuts = [1, 7, 128, 480, 1000, 1601, 1584]
  let offset = 0
  for (const cut of cuts) {
    output.push(...chunked.push(input.subarray(offset, offset + cut)))
    offset += cut
  }
  output.push(...chunked.push(input.subarray(offset)))

  assert.ok(Math.abs(output.length - oneShot.length) <= 1)
  for (let index = 0; index < Math.min(output.length, oneShot.length); index += 1) {
    assert.ok(Math.abs(output[index] - oneShot[index]) < 1e-6, `sample ${index} diverged`)
  }
})

test('frame assembler produces monotonic fixed frames with a flushed tail', async () => {
  const { FrameAssembler } = await import(moduleUrl('frame-assembler.mjs'))
  const assembler = new FrameAssembler({ frameSamples: 1600, sampleRate: 16000 })

  const first = assembler.push(new Float32Array(1599))
  assert.deepEqual(first, [])
  const second = assembler.push(new Float32Array(1601))
  assert.equal(second.length, 2)
  assert.deepEqual(second.map((frame) => frame.sequence), [0, 1])
  assert.deepEqual(second.map((frame) => frame.timestampSeconds), [0, 0.1])
  assert.ok(second.every((frame) => frame.samples.length === 1600))

  const tail = assembler.flush()
  assert.equal(tail.length, 0)

  assembler.push(new Float32Array(900))
  const flushed = assembler.flush()
  assert.equal(flushed.length, 1)
  assert.equal(flushed[0].sequence, 2)
  assert.equal(flushed[0].samples.length, 900)
  assert.equal(flushed[0].timestampSeconds, 0.2)
  assert.equal(assembler.totalSamples, 1600 * 2 + 900)
})

test('frame assembler rejects invalid configuration', async () => {
  const { FrameAssembler } = await import(moduleUrl('frame-assembler.mjs'))
  assert.throws(() => new FrameAssembler({ frameSamples: 0 }), /frameSamples/)
  assert.throws(() => new FrameAssembler({ sampleRate: -1 }), /sampleRate/)
})

test('level analysis counts clipping runs, over-range and non-finite samples', () => {
  const samples = new Float32Array(16000)
  samples.set(sine(440, 16000, 8000, 0.4))
  samples[9000] = 1.5
  samples[9001] = Number.NaN
  samples[9100] = 1
  samples[9101] = 0.9995
  samples[9102] = -1

  const levels = analyzeLevels(samples)
  assert.equal(levels.overRangeCount, 1)
  assert.equal(levels.nonFiniteCount, 1)
  assert.ok(levels.clippingCount >= 4)
  assert.ok(levels.longestFullScaleRun >= 3)
  assert.equal(levels.signalObserved, true)

  const silence = analyzeLevels(new Float32Array(16000))
  assert.equal(silence.signalObserved, false)
  assert.equal(silence.nonFiniteCount, 0)
})

test('diagnostic evaluation passes clean pipelines and fails each broken axis', () => {
  const cleanLevels = analyzeLevels(sine(440, 16000, validPipeline().sampleCount, 0.3))
  const clean = evaluateDiagnostic(validPipeline(), cleanLevels, 2600)
  assert.equal(clean.pass, true)
  assert.equal(clean.pipelinePass, true)
  assert.equal(clean.integrityPass, true)

  const silentLevels = analyzeLevels(new Float32Array(validPipeline().sampleCount))
  assert.equal(evaluateDiagnostic(validPipeline(), silentLevels, 2600).pass, true, '静音不是诊断失败')

  const gap = evaluateDiagnostic(validPipeline({ sequenceGapCount: 1 }), cleanLevels, 2600)
  assert.equal(gap.pass, false)
  const regress = evaluateDiagnostic(validPipeline({ timestampRegressionCount: 2 }), cleanLevels, 2600)
  assert.equal(regress.pass, false)
  const shortCapture = evaluateDiagnostic(validPipeline(), cleanLevels, 6000)
  assert.equal(shortCapture.pass, false, '采集时长覆盖不足必须失败')
  const badRate = evaluateDiagnostic(validPipeline({ outputSampleRate: 44100 }), cleanLevels, 2600)
  assert.equal(badRate.pass, false)

  const corrupt = new Float32Array(validPipeline().sampleCount)
  corrupt[0] = Number.POSITIVE_INFINITY
  const corruptResult = evaluateDiagnostic(validPipeline(), analyzeLevels(corrupt), 2600)
  assert.equal(corruptResult.integrityPass, false)
  assert.equal(corruptResult.pass, false)

  /* 其余判定轴逐一失败。 */
  assert.equal(evaluateDiagnostic(validPipeline({ wallElapsedSeconds: 3.5 }), cleanLevels, 2600).pass, false, '时钟覆盖过低')
  assert.equal(evaluateDiagnostic(validPipeline({ wallElapsedSeconds: 2.0 }), cleanLevels, 2600).pass, false, '时钟覆盖过高')
  assert.equal(evaluateDiagnostic(validPipeline({ tailFrameSamples: 0 }), cleanLevels, 2600).pass, false)
  assert.equal(evaluateDiagnostic(validPipeline({ tailFrameSamples: 1601 }), cleanLevels, 2600).pass, false)
  assert.equal(evaluateDiagnostic(validPipeline({ frameCount: 28 }), cleanLevels, 2600).pass, false, 'frameCount 与 full+tail 不符')
  assert.equal(evaluateDiagnostic(validPipeline({ frameSamples: 800 }), cleanLevels, 2600).pass, false)
  assert.equal(evaluateDiagnostic(validPipeline({ inputSampleRate: 0 }), cleanLevels, 2600).pass, false)
  assert.equal(evaluateDiagnostic(validPipeline({ fullFrameCount: 0, frameCount: 1, sampleCount: 1000 }),
    analyzeLevels(new Float32Array(1000)), 2600).pass, false, '不足一个整帧')
  const mismatch = evaluateDiagnostic(validPipeline({ sampleCount: validPipeline().sampleCount - 1 }), cleanLevels, 2600)
  assert.equal(mismatch.pass, false, 'pipeline 样本数与实际样本数不符')
})

test('preload inlines the exact channel names and never requires local modules', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'runtime', 'audio-host', 'preload.js'), 'utf8')
  /* 宿主窗运行在默认 Chromium sandbox 下，preload 不能 require 本地模块；
     内联字符串必须与 channels.js 的【每一个】通道保持一致。 */
  for (const value of Object.values(CHANNELS)) {
    assert.ok(source.includes(`'${value}'`), `preload must inline channel '${value}'`)
  }
  assert.ok(!/require\(['"]\.{1,2}\//.test(source), 'sandboxed preload must not require local modules')

  /* host.js 内联的端口消息名同样必须与 channels.js 一致。 */
  const hostSource = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'runtime', 'audio-host', 'host.js'), 'utf8')
  assert.ok(hostSource.includes(`'${CHANNELS.PCM_PORT}'`), 'host.js must inline the PCM_PORT channel name')
})

test('audio host window keeps the Chromium sandbox enabled', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', '..', 'src', 'runtime', 'audio-host', 'audio-host-controller.js'), 'utf8')
  assert.ok(!/sandbox\s*:\s*false/.test(source), 'the media-privileged host renderer must keep the default sandbox')
  assert.doesNotMatch(source, /removeAllListeners/,
    'retiring one audio host must not remove a newer controller generation\'s IPC listeners')
  assert.match(source, /removeListener\(CHANNELS\.MARK, this\.markListener\)/)
  assert.match(source, /removeListener\(CHANNELS\.CONTROL, this\.controlListener\)/)
})

test('diagnostic payloads are rejected from untrusted senders and wrong sessions', () => {
  const controller = new AudioHostController({ electron: fakeElectron() })
  const hostContents = { id: 1 }
  controller.hostWindow = { isDestroyed: () => false, webContents: hostContents }
  const event = (sender) => ({ sender, senderFrame: null })

  assert.throws(() => controller.acceptDiagnostic(event({ id: 2 }), validSavePayload('s-1', 'mic')), /untrusted/)
  assert.throws(() => controller.acceptDiagnostic(event(hostContents), validSavePayload('s-1', 'mic')), /no diagnostic/)

  controller.activeDiagnostic = {
    options: { sessionId: 's-1', sourceIds: ['mic'], durationMs: 2600 },
    saved: {},
    reject: () => {}
  }
  assert.throws(() => controller.acceptDiagnostic(event(hostContents), validSavePayload('other', 'mic')), /sessionId mismatch/)
  assert.throws(() => controller.acceptDiagnostic(event(hostContents), validSavePayload('s-1', 'loopback')), /invalid or duplicate/)

  const accepted = controller.acceptDiagnostic(event(hostContents), validSavePayload('s-1', 'mic'))
  assert.equal(accepted.checks.pass, true)
  assert.throws(() => controller.acceptDiagnostic(event(hostContents), validSavePayload('s-1', 'mic')), /invalid or duplicate/)

  /* 非 main frame 拒绝。 */
  controller.activeDiagnostic.saved = {}
  const subFrameEvent = { sender: { ...hostContents, mainFrame: 'main' }, senderFrame: 'iframe' }
  controller.hostWindow.webContents = subFrameEvent.sender
  assert.throws(() => controller.acceptDiagnostic(subFrameEvent, validSavePayload('s-1', 'mic')), /main frame/)
})

/* 可完整走通 runDiagnosticCapture 的假 electron：loadFile/executeJavaScript/
   isVisible/destroy 全部可用，webContents 事件 handler 暴露给测试触发。 */
function workingFakeElectron (captureResult, hooks = {}) {
  const listeners = {}
  const win = {
    destroyed: false,
    on (name, handler) { listeners[`window:${name}`] = handler },
    webContents: {
      mainFrame: 'main',
      setWindowOpenHandler () {},
      on (name, handler) { listeners[name] = handler }
    },
    loadFile: async () => { if (hooks.duringLoad) await hooks.duringLoad() },
    isVisible: () => false,
    isDestroyed: () => win.destroyed,
    destroy: () => { win.destroyed = true }
  }
  win.webContents.executeJavaScript = async () => {
    if (hooks.beforeCaptureResolves) await hooks.beforeCaptureResolves()
    return structuredClone(captureResult)
  }
  const electron = fakeElectron({ BrowserWindow: function () { return win } })
  return { electron, listeners, win }
}

test('audio host role evidence follows the exact hidden WebContents lifecycle', () => {
  const { electron, listeners, win } = workingFakeElectron({})
  const registrations = []
  const gone = []
  const preloadErrors = []
  const unresponsive = []
  let unregisterCount = 0
  const controller = new AudioHostController({
    electron,
    registerWebContents: (webContents) => {
      registrations.push(webContents)
      return () => { unregisterCount += 1 }
    },
    onRenderProcessGone: (webContents, details) => gone.push({ webContents, details }),
    onPreloadError: (webContents) => preloadErrors.push(webContents),
    onUnresponsive: (webContents) => unresponsive.push(webContents)
  })

  controller.hostWindow = controller.createHostWindow()
  const details = { reason: 'crashed', exitCode: -2147483645 }
  listeners['preload-error']({}, 'private-path', new Error('private error'))
  listeners['window:unresponsive']()
  listeners['render-process-gone']({}, details)

  assert.deepEqual(registrations, [win.webContents])
  assert.deepEqual(preloadErrors, [win.webContents])
  assert.deepEqual(unresponsive, [win.webContents])
  assert.deepEqual(gone, [{ webContents: win.webContents, details }])
  controller.destroyHostWindow()
  assert.equal(unregisterCount, 1)
  assert.equal(win.destroyed, true)
  controller.destroyHostWindow()
  assert.equal(unregisterCount, 1, 'evidence role cleanup is exactly once')
})

test('the full single-source diagnostic returns metrics and scrubs console text', async () => {
  const capture = {
    loopback: { status: 'ok' }
  }
  let controller
  const { electron, listeners, win } = workingFakeElectron(capture, {
    beforeCaptureResolves: async () => {
      listeners['console-message']({ message: 'warn at D:\\A1Project\\Speech-Agent2.0\\src\\x.js:1' })
      controller.acceptDiagnostic(
        { sender: win.webContents, senderFrame: null },
        validSavePayload('s-1', 'loopback')
      )
    }
  })
  const evidence = []
  controller = new AudioHostController({ electron, onEvidence: (event) => evidence.push(event) })

  const outcome = await controller.runDiagnosticCapture({
    sessionId: 's-1',
    sourceIds: ['loopback'],
    durationMs: 2600
  })
  assert.equal(outcome.result, 'pass')
  assert.equal(outcome.sources.loopback.diagnostic.checks.pass, true)
  assert.equal(Object.hasOwn(outcome.sources.loopback.diagnostic, 'artifact'), false)
  /* console 文本必须在 main 边界脱敏。 */
  const consoleEvidence = evidence.find((event) => event.stage === 'host-console')
  assert.ok(consoleEvidence.detail.message.includes('<local-path>'))
  assert.ok(!consoleEvidence.detail.message.includes('A1Project'))
  assert.equal(win.destroyed, true, '诊断结束必须销毁宿主窗')
})

test('dispose during host page load rejects cleanly without unhandled rejections', async () => {
  const unhandled = []
  const listener = (reason) => unhandled.push(reason)
  process.on('unhandledRejection', listener)
  try {
    let controller
    const { electron } = workingFakeElectron({}, { duringLoad: async () => { controller.dispose() } })
    controller = new AudioHostController({ electron })
    await assert.rejects(
      controller.runDiagnosticCapture({ sessionId: 's-1', sourceIds: ['mic'], durationMs: 2000 }),
      /disposed/
    )
    await new Promise((resolve) => setImmediate(resolve))
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(unhandled, [], 'aborted promise 不得产生 unhandledRejection')
  } finally {
    process.removeListener('unhandledRejection', listener)
  }
})

test('diagnostics and continuous capture are mutually exclusive', async () => {
  const controller = new AudioHostController({ electron: fakeElectron() })
  controller.activeCapture = { options: { sessionId: 's-1', sourceIds: ['loopback'], maxQueueMs: 2000 }, phase: 'capturing' }
  await assert.rejects(
    controller.runDiagnosticCapture({ sessionId: 's-2', sourceIds: ['mic'], durationMs: 2000 }),
    /busy/
  )
  await assert.rejects(
    controller.startCapture({ sessionId: 's-3', sourceIds: ['mic'], port: { postMessage () {} } }),
    /busy/
  )
})

test('replacePort is rejected until capture start completes', () => {
  const controller = new AudioHostController({ electron: fakeElectron() })
  const port = { postMessage () {} }
  assert.throws(() => controller.replacePort(port), /no active capture/)
  controller.activeCapture = { options: { sessionId: 's-1' }, phase: 'starting' }
  controller.hostWindow = { isDestroyed: () => false, webContents: { postMessage () {} } }
  assert.throws(() => controller.replacePort(port), /before capture start completes/)
  controller.activeCapture.phase = 'capturing'
  assert.doesNotThrow(() => controller.replacePort(port))
})

test('a setup failure does not wedge the controller for later diagnostics', async () => {
  const controller = new AudioHostController({ electron: fakeElectron() })
  await assert.rejects(
    controller.runDiagnosticCapture({ sessionId: 's-1', sourceIds: ['mic'], durationMs: 2000 }),
    /BrowserWindow unavailable/
  )
  /* 第二次调用必须报同一个原始错误，而不是 'already running'。 */
  await assert.rejects(
    controller.runDiagnosticCapture({ sessionId: 's-2', sourceIds: ['mic'], durationMs: 2000 }),
    /BrowserWindow unavailable/
  )
  controller.dispose()
  await assert.rejects(
    controller.runDiagnosticCapture({ sessionId: 's-3', sourceIds: ['mic'], durationMs: 2000 }),
    /disposed/
  )
})

test('permission policy only allows media for the trusted host sender', () => {
  assert.equal(isPermissionAllowed('media', true), true)
  assert.equal(isPermissionAllowed('media', false), false)
  assert.equal(isPermissionAllowed('geolocation', true), false)
  assert.equal(isPermissionAllowed('notifications', true), false)
  assert.equal(isPermissionAllowed('speaker-selection', true), false)
})

test('display requests must come from the host main frame with video+audio', () => {
  const valid = {
    frameMatchesHost: true,
    securityOrigin: 'file:///D:/app/host.html',
    videoRequested: true,
    audioRequested: true
  }
  assert.equal(evaluateDisplayRequest(valid).allowed, true)
  assert.equal(evaluateDisplayRequest({ ...valid, frameMatchesHost: false }).allowed, false)
  assert.equal(evaluateDisplayRequest({ ...valid, securityOrigin: 'https://evil.example' }).allowed, false)
  assert.equal(evaluateDisplayRequest({ ...valid, videoRequested: false }).allowed, false)
  assert.equal(evaluateDisplayRequest({ ...valid, audioRequested: false }).allowed, false)
  assert.equal(evaluateDisplayRequest(null).allowed, false)
})

test('screen source selection prefers the primary display', () => {
  const sources = [
    { id: 'screen:1', display_id: '100' },
    { id: 'screen:2', display_id: '200' }
  ]
  assert.equal(selectScreenSource(sources, 200).id, 'screen:2')
  assert.equal(selectScreenSource(sources, 999).id, 'screen:1')
  assert.equal(selectScreenSource([], 100), null)
  assert.equal(selectScreenSource(null, 100), null)
})

test('diagnostic options are validated and normalized', () => {
  const normalized = validateDiagnosticOptions({ sessionId: 's-1', sourceIds: ['loopback'], durationMs: 2600 })
  assert.deepEqual(normalized, { sessionId: 's-1', sourceIds: ['loopback'], durationMs: 2600 })

  assert.throws(() => validateDiagnosticOptions(null), /options/)
  assert.throws(() => validateDiagnosticOptions({ sessionId: ' ', sourceIds: ['mic'], durationMs: 2000 }), /sessionId/)
  assert.throws(() => validateDiagnosticOptions({ sessionId: 's', sourceIds: [], durationMs: 2000 }), /sourceIds/)
  assert.throws(() => validateDiagnosticOptions({ sessionId: 's', sourceIds: ['speaker'], durationMs: 2000 }), /unknown sourceId/)
  assert.throws(() => validateDiagnosticOptions({ sessionId: 's', sourceIds: ['mic', 'loopback'], durationMs: 2000 }), /exactly one/)
  assert.throws(() => validateDiagnosticOptions({ sessionId: 's', sourceIds: ['mic', 'mic'], durationMs: 2000 }), /exactly one/)
  assert.throws(() => validateDiagnosticOptions({ sessionId: 's', sourceIds: ['mic'], durationMs: MIN_DIAGNOSTIC_MS - 1 }), /durationMs/)
  assert.throws(() => validateDiagnosticOptions({ sessionId: 's', sourceIds: ['mic'], durationMs: MAX_DIAGNOSTIC_MS + 1 }), /durationMs/)
  assert.throws(() => validateDiagnosticOptions({ sessionId: 's', sourceIds: ['mic'], durationMs: 2000.5 }), /durationMs/)
})

test('diagnostic API refuses every audio persistence option', async () => {
  const controller = new AudioHostController({ electron: fakeElectron() })
  await assert.rejects(
    controller.runDiagnosticCapture({
      sessionId: 's-1',
      sourceIds: ['mic'],
      durationMs: 2000,
      dumpDir: '.artifacts/audio-host'
    }),
    /persistence is not supported/
  )
})

test('public errors and console text scrub local paths and clamp length', () => {
  const scrubbed = publicError(new Error('failed at C:\\Users\\someone\\secret\\file.wav during capture'))
  assert.ok(!scrubbed.message.includes('Users'))
  assert.ok(scrubbed.message.includes('<local-path>'))
  const long = publicError(new Error('x'.repeat(1000)))
  assert.ok(long.message.length <= 300)

  assert.equal(scrubLocalPaths('at D:/A1Project/x.js:10 boom'), 'at <local-path> boom')
  assert.equal(scrubLocalPaths(undefined), '')
  assert.ok(scrubLocalPaths('y'.repeat(1000)).length <= 300)
})

test('diagnostic sample payloads are coerced defensively', () => {
  const float = new Float32Array([0.1, -0.2])
  const copied = coerceSamples(float)
  assert.deepEqual([...copied], [...float])
  copied[0] = 9
  assert.equal(float[0], Math.fround(0.1), 'coercion must copy, not alias')

  const fromBuffer = coerceSamples(float.buffer.slice(0))
  assert.equal(fromBuffer.length, 2)
  assert.throws(() => coerceSamples('nope'), /Float32/)
  assert.throws(() => coerceSamples(null), /Float32/)
})

test('I2 anonymous device selectors fail closed on duplicate labels and recheck the acquired routes', () => {
  const host = fs.readFileSync(path.resolve(__dirname, '../../src/runtime/audio-host/host.js'), 'utf8')
  const player = fs.readFileSync(path.resolve(__dirname, '../../scripts/i2-live-caption-player.js'), 'utf8')
  assert.match(host, /matches\.length !== 1/)
  assert.match(host, /digestText\(audioTrack\.label\) !== micLabelSha256/)
  assert.match(host, /deviceId: \{ exact: selected\.deviceId \}/)
  assert.match(player, /matches\.length !== 1/)
  assert.match(player, /setSinkId\(selected\.device\.deviceId\)/)
  assert.match(player, /matchedLabelHashCount: matches\.length/)
})

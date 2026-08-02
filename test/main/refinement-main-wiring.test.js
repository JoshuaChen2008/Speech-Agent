'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const root = path.resolve(__dirname, '..', '..')
const source = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8')

test('main wires refinement fallback state, bounded diagnostics, and a memory-only post-session notice', () => {
  const main = source('src/main.js')

  assert.match(main, /created\.onCaptionState\(\(state\) => send\(captionWin, CHANNELS\.CAPTION_STATE_CHANGED, state\)\)/)
  assert.match(main, /created\.onRefinementFault\(\(fault\) => \{[\s\S]+refinementFaultLog\.record\(\{[\s\S]+code: fault\.code,[\s\S]+stage: fault\.stage,[\s\S]+faultAtMs: fault\.faultAtMs/)
  assert.match(main, /new RefinementFaultLog\(\{[\s\S]+path\.join\(userDataDir, 'logs', 'refinement'\)/)
  assert.match(main, /if \(refinementFaultLog\) shutdownTasks\.push\(refinementFaultLog\.close\(\)\)/)

  assert.match(main, /const refinementNoticeStore = new RefinementNoticeStore/)
  assert.match(main, /REFINEMENT_NOTICE_GET/)
  assert.match(main, /historyService\.getSessionPage\(\{ sessionId, limit: 1, cursor: null \}\)/)
  assert.match(main, /name === 'stop'[\s\S]+before\.phase !== 'error'/)
  assert.match(main, /name === 'start'[\s\S]+refinementNoticeStore\.clear\(\)/)
  assert.match(main, /action === 'history'[\s\S]+refinementNoticeStore\.clear\(\)[\s\S]+openHistoryWindow/)
  assert.match(main, /action === 'dismiss-refinement-notice'/)

  assert.doesNotMatch(main, /new Notification|showMessageBox|\.play\(|systemPreferences/)
  assert.doesNotMatch(source('src/main/services/refinement-notice.js'), /writeFile|readFile|appendFile/)
})

test('toolbar notice remains a single fixed-height inline status with explicit actions', () => {
  const main = source('src/main.js')
  const script = source('src/toolbar/toolbar.js')
  const css = source('src/toolbar/toolbar.css')

  assert.match(main, /const TB_H = 40 \+ TB_MARGIN \* 2/)
  assert.match(script, /getRefinementNotice/)
  assert.match(script, /onRefinementNotice/)
  assert.match(script, /label: '查看历史'/)
  assert.match(script, /act: 'dismiss-refinement-notice'/)
  assert.match(script, /可查看历史或关闭提示/)
  assert.match(css, /\.status\.refinement-notice[\s\S]+max-width:/)
  assert.match(css, /white-space: nowrap/)
  assert.doesNotMatch(script, /setBounds|setSize|resizeTo|requestFullscreen/)
})

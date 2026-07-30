'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const root = path.resolve(__dirname, '..', '..')

function source (relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8')
}

test('history window exposes terminal text review and txt/md/srt export without audio controls', () => {
  const html = source('src/history/index.html')
  const script = source('src/history/history.js')

  assert.match(html, /id="sessionList"[^>]+role="list"/)
  assert.match(html, /id="timeline"/)
  assert.match(html, /data-export="txt"/)
  assert.match(html, /data-export="md"/)
  assert.match(html, /data-export="srt"/)
  assert.match(html, /文本复盘，不包含录音/)
  assert.match(html, /临时字幕、译文和音频都不会进入历史/)
  assert.doesNotMatch(html, /<audio\b|\bplayback\b|data-action="play"/i)

  assert.match(script, /api\.listSessions\(PAGE_SIZE,/)
  assert.match(script, /api\.getSession\(sessionId\)/)
  assert.match(script, /api\.exportSession\(selectedSessionId, format\)/)
  assert.match(script, /listItem\.setAttribute\('role', 'listitem'\)/)
  assert.doesNotMatch(script, /audioPath|translation\s*[.:[]|require\(['"](?:node:)?fs|require\(['"]electron/)
})

test('history preload is a narrow IPC façade without SQL, arbitrary paths or filesystem powers', () => {
  const preload = source('src/preload/history.js')
  const toolbar = source('src/toolbar/toolbar.js')

  assert.match(preload, /HISTORY_LIST/)
  assert.match(preload, /HISTORY_GET/)
  assert.match(preload, /HISTORY_EXPORT/)
  assert.match(preload, /sessionId: String/)
  assert.match(preload, /format: String/)
  assert.doesNotMatch(preload, /filePath|databasePath|\bsql\b|readFile|writeFile|showSaveDialog/i)
  assert.match(toolbar, /history: \(\) => bridge\.action\('history'\)/)
  assert.match(toolbar, /act: 'history'.+label: '历史记录'/)
})

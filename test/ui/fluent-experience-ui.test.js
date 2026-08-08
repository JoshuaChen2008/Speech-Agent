'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const root = path.resolve(__dirname, '..', '..')
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8')

test('SEM-F23/J18: shared tokens provide keyboard focus, theme and reduced-motion contracts to every renderer', () => {
  const tokens = read('src/ui/shared/tokens.css')
  assert.match(tokens, /:where\(button, a\[href\], input, select, textarea, \[tabindex\]\):focus-visible/)
  assert.match(tokens, /outline:\s*var\(--focus-width\) solid var\(--focus-color\)/)
  assert.match(tokens, /@media \(forced-colors: active\)/)
  assert.match(tokens, /@media \(prefers-reduced-motion: reduce\)/)

  for (const [role, entry, styles] of [
    ['caption', 'src/caption/index.html', 'src/caption/caption.css'],
    ['toolbar', 'src/toolbar/index.html', 'src/toolbar/toolbar.css'],
    ['settings', 'src/settings/settings.html', 'src/settings/settings.css'],
    ['history', 'src/history/index.html', 'src/history/history.css']
  ]) {
    assert.match(read(entry), /\.\.\/ui\/shared\/tokens\.css/, `${role} must consume the shared token contract`)
    assert.match(read(styles), /@media \(prefers-reduced-motion: reduce\)/, `${role} must define a reduced-motion contour`)
    assert.match(read(styles), /@media \(forced-colors: active\)/, `${role} must define a forced-colors contour`)
  }
})

test('SEM-F23/J18: React views and the direct toolbar expose native keyboard controls with accessible state', () => {
  const settings = read('src/settings/settings-view.tsx')
  const history = read('src/history/history-view.tsx')
  const toolbar = read('src/toolbar/toolbar.ts')
  assert.match(settings, /<nav className="nav" aria-label="设置类别">/)
  assert.match(settings, /role="radiogroup" aria-label="监听模式"/)
  assert.match(settings, /aria-busy=\{corePending \|\| coreBusy\}/)
  assert.match(settings, /role="status" aria-live="polite"/)
  assert.match(history, /role="radiogroup" aria-label="转写版本"/)
  assert.match(history, /aria-posinset=/)
  assert.match(history, /aria-setsize=/)
  assert.match(history, /role="status" aria-live="polite"/)
  assert.match(toolbar, /el\('button', 'act'/)
  assert.match(toolbar, /setAttribute\('aria-label'/)
})

'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const root = path.resolve(__dirname, '..', '..')
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8')

const { applyAppearance } = require(path.join(root, 'src', 'ui', 'shared', 'appearance.js'))

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

test('SEM-F23/J18: toolbar palette stays fixed while caption color and toolbar opacity remain isolated', () => {
  const tokens = read('src/ui/shared/tokens.css')
  const phases = read('src/ui/shared/phases.css')
  const toolbar = read('src/toolbar/toolbar.css')
  const settings = read('src/settings/settings-view.tsx')

  for (const token of [
    'surface-toolbar', 'text-toolbar', 'text-toolbar-hover', 'tint-hover', 'tint-active',
    'tint-sep', 'hairline', 'icon-halo', 'shadow-bar', 'tone-neutral', 'tone-busy',
    'tone-live', 'tone-warn', 'tone-danger'
  ]) {
    assert.match(phases, new RegExp(`--${token}:\\s*var\\(--overlay-${token}\\)`))
  }
  assert.match(tokens, /--overlay-surface-toolbar:\s*rgba\(var\(--overlay-toolbar-bg\), var\(--toolbar-alpha\)\)/)
  assert.doesNotMatch(tokens.match(/:root\[data-theme="light"\]\s*\{[\s\S]*?\n\}/)?.[0] || '', /--overlay-/)
  /* 「用什么颜色」由固定覆盖层决定（上面几条），「画不画外壳」由锁定状态决定。
     两件事正交，各自单独断言 —— 用跨规则的宽松正则会让两边互相掩护。
     未锁定：嵌入字幕卡，不画属于自己的表面；锁定：脱离卡片，必须自己长出来。 */
  const embedded = toolbar.match(/^\.toolbar\s*\{([^}]*)\}/m)?.[1] || ''
  assert.match(embedded, /background:\s*transparent;/)
  assert.match(embedded, /box-shadow:\s*none;/)
  assert.doesNotMatch(embedded, /opacity:\s*1;/)

  const detached = toolbar.match(/\.wrap\[data-locked="on"\]\s+\.toolbar\s*\{([^}]*)\}/)?.[1] || ''
  assert.match(detached, /background:\s*var\(--surface-toolbar\);/)
  assert.match(detached, /opacity:\s*1;/)

  assert.match(settings, />字幕背景颜色 </)
  assert.match(settings, /aria-label="字幕背景颜色"/)

  const values = new Map([['--toolbar-bg', 'legacy']])
  const element = {
    dataset: {},
    style: {
      setProperty: (name, value) => values.set(name, value),
      removeProperty: (name) => values.delete(name)
    }
  }
  applyAppearance(element, {
    theme: 'light', systemDark: false, fontSize: 30, radius: 10,
    opacity: 0.86, toolbarOpacity: 0.31, barColor: '#123456'
  })
  assert.equal(values.get('--bar-bg'), '18, 52, 86')
  assert.equal(values.get('--toolbar-alpha'), '0.31')
  assert.equal(values.has('--toolbar-bg'), false)
})

/* 字幕卡是半透明浮在任意画面上的，底下是视频 / 网页 / 桌面，和应用主题无关。
   所以字幕文字色是一根独立受控的轴：深色和浅色主题都不许碰它。 */
test('SEM-F20/J18: caption text colour is theme independent, user overridable and falls back to the default', () => {
  const tokens = read('src/ui/shared/tokens.css')
  const settings = read('src/settings/settings-view.tsx')

  assert.match(tokens, /--caption-text:\s*var\(--c-white\)/)
  assert.match(tokens, /--text-caption:\s*rgb\(var\(--caption-text\)\)/)
  assert.match(tokens, /--text-caption-partial:\s*rgba\(var\(--caption-text\), 0\.60\)/)

  /* 注释里会提到这些 token 名，先剥掉再断言，免得说明文字自己把测试喂饱 */
  const lightTheme = (tokens.match(/:root\[data-theme="light"\]\s*\{[\s\S]*?\n\}/)?.[0] || '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
  assert.notEqual(lightTheme, '', 'light theme block must exist')
  for (const token of ['--text-caption', '--text-caption-partial', '--text-shadow-caption']) {
    assert.doesNotMatch(lightTheme, new RegExp(`${token}:`), `${token} must not follow the theme`)
  }

  assert.match(settings, />字幕文字颜色 </)
  assert.match(settings, /aria-label="字幕文字颜色"/)
  assert.match(settings, /captionTextColor: null/)

  const values = new Map()
  const element = {
    dataset: {},
    style: {
      setProperty: (name, value) => values.set(name, value),
      removeProperty: (name) => values.delete(name)
    }
  }
  const base = {
    theme: 'light', systemDark: false, fontSize: 30, radius: 10,
    opacity: 0.86, toolbarOpacity: 0.82, barColor: null
  }

  applyAppearance(element, { ...base, captionTextColor: '#ffcc00' })
  assert.equal(values.get('--caption-text'), '255, 204, 0')

  /* 还原默认必须是 removeProperty。写回默认值会让内联样式盖住 tokens.css，
     等于把这一项永久钉死在「当时的默认」上。 */
  applyAppearance(element, { ...base, captionTextColor: null })
  assert.equal(values.has('--caption-text'), false)
  applyAppearance(element, { ...base, captionTextColor: 'not-a-colour' })
  assert.equal(values.has('--caption-text'), false)
})

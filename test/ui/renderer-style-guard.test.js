'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

/* SEM-F23 / J18 的 renderer 样式守卫子边界（不是新旅程）。

   这份守卫按目录扫描，不按窗口点名 —— 未来正式 agent 窗口的样式一出现就被覆盖，
   不依赖任何人记得回来改名单。要放宽任何一条，先改 docs/semantic-contract.md 的
   SEM-F23 与 docs/testing-strategy.md 的同名小节，再改这里的闭集。

   它只是静态样式边界：全绿不表示任何 renderer 已实现或已验收，真实 Mica、
   系统 DPI 和跨背景可读性仍然只能由 J15a/I2 的实机观察给出。 */

const root = path.resolve(__dirname, '..', '..')

/** 扫描范围之外的树。构建产物与隔离 Agent 内核开发入口不是产品 renderer。 */
const EXCLUDED_TREES = [
  'src/renderer-dist',
  'src/agent-provider',
  'src/agent-runtime',
  'node_modules'
]

/** 视觉单一真相：只有它可以持有调色板原始值与主题分支。 */
const TOKEN_TRUTH = 'src/ui/shared/tokens.css'

/** 开发预览页：受一套更窄的规则约束，见本文件末尾。 */
const PREVIEW_TREE = 'src/ui/preview'

/** 共享层目录本身不是 renderer，不要求自带入口。 */
const SHARED_TREE = 'src/ui/shared'

/** 扫描下限。写错扫描表达式导致零文件被检查时必须变红，不得空过。 */
const REQUIRED_IN_SCOPE = [
  'src/caption/caption.css',
  'src/toolbar/toolbar.css',
  'src/settings/settings.css',
  'src/history/history.css',
  'src/ui/shared/phases.css'
]

/** 已登记的无限循环动画闭集。新增任何一条默认变红。
    临时字幕光标与 starting/recovering 转圈都是状态绑定的过渡指示，
    不是常驻装饰动画；两者在 reduced-motion 下各自转静态。 */
const REGISTERED_INFINITE_ANIMATIONS = new Map([
  ['src/caption/caption.css', ['caret']],
  ['src/ui/shared/phases.css', ['phase-spin']]
])

const BANNED_NAMED_COLORS = [
  'white', 'black', 'red', 'blue', 'green', 'gray', 'grey', 'yellow', 'orange',
  'purple', 'silver', 'maroon', 'navy', 'teal', 'olive', 'lime', 'aqua', 'fuchsia'
]

const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8')
const toPosix = (value) => value.split(path.sep).join('/')

function walk (relativeDir, out = []) {
  for (const entry of fs.readdirSync(path.join(root, relativeDir), { withFileTypes: true })) {
    const relative = `${relativeDir}/${entry.name}`
    if (EXCLUDED_TREES.some((tree) => relative === tree || relative.startsWith(`${tree}/`))) continue
    if (entry.isDirectory()) walk(relative, out)
    else out.push(relative)
  }
  return out
}

/** 注释里出现色值是说明，不是声明。判断前先剥掉。 */
const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '')

const allFiles = walk('src').map(toPosix)
const componentStyles = allFiles.filter((file) => (
  file.endsWith('.css') &&
  file !== TOKEN_TRUTH &&
  !file.startsWith(`${PREVIEW_TREE}/`)
))

test('SEM-F23/J18: 样式守卫的扫描范围本身可信，不会空过', () => {
  assert.ok(componentStyles.length > 0, '扫描结果为空说明扫描表达式写错了')
  for (const required of REQUIRED_IN_SCOPE) {
    assert.ok(
      componentStyles.includes(required),
      `${required} 必须落在扫描范围内；这是下限而不是名单，新增 renderer 同样被扫描`
    )
  }
})

test('SEM-F23/J18: 组件样式层只消费语义 token，不持有调色板原始值或主题分支', () => {
  for (const file of componentStyles) {
    const css = stripComments(read(file))

    assert.doesNotMatch(css, /#[0-9a-fA-F]{3,8}\b/, `${file} 不得出现字面色值`)
    assert.doesNotMatch(
      css,
      /\b(?:rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch)\(\s*[0-9.]/,
      `${file} 不得出现字面色值；透明度复合必须走语义 token 的三元组`
    )
    for (const name of BANNED_NAMED_COLORS) {
      assert.doesNotMatch(
        css,
        new RegExp(`(^|[\\s:,(])${name}(?=[\\s;,)!]|$)`, 'i'),
        `${file} 不得使用具名颜色 ${name}`
      )
    }
    assert.doesNotMatch(css, /--c-[a-z]/, `${file} 不得直接引用调色板原始值 --c-*，只能消费语义层`)
    assert.doesNotMatch(css, /\[data-theme/, `${file} 不得出现主题分支，主题在 ${TOKEN_TRUTH} 的 token 层切换`)
  }
})

test('SEM-F23/J18: 组件样式层不使用渐变、玻璃体与常驻模糊表面', () => {
  for (const file of componentStyles) {
    const css = stripComments(read(file))
    assert.doesNotMatch(
      css,
      /(?:linear|radial|conic|repeating-linear|repeating-radial)-gradient\(/,
      `${file} 不得使用渐变`
    )
    assert.doesNotMatch(css, /backdrop-filter\s*:/, `${file} 不得使用常驻模糊表面`)
  }
})

test('SEM-F23/J18: 无限循环动画只允许出现在已登记闭集内', () => {
  for (const file of componentStyles) {
    const css = stripComments(read(file))
    const declarations = css.match(/animation[^;{}]*infinite[^;{}]*/g) || []
    const registered = REGISTERED_INFINITE_ANIMATIONS.get(file) || []

    if (registered.length === 0) {
      assert.equal(
        declarations.length, 0,
        `${file} 新增了无限循环动画；要放行必须先改 SEM-F23 与测试策略同名小节，再改本守卫的闭集`
      )
      continue
    }
    for (const declaration of declarations) {
      assert.ok(
        registered.some((name) => declaration.includes(name)),
        `${file} 的无限循环动画不在已登记闭集 ${registered.join(' / ')} 内：${declaration.trim()}`
      )
    }
  }
})

test('SEM-F23/J18: 每个 renderer 目录自带 reduced-motion 与 forced-colors 轮廓', () => {
  const byDirectory = new Map()
  for (const file of componentStyles) {
    const directory = file.slice(0, file.lastIndexOf('/'))
    if (!byDirectory.has(directory)) byDirectory.set(directory, [])
    byDirectory.get(directory).push(file)
  }

  for (const [directory, files] of byDirectory) {
    const merged = files.map(read).join('\n')
    assert.match(merged, /@media \(prefers-reduced-motion: reduce\)/, `${directory} 必须声明 reduced-motion 轮廓`)
    assert.match(merged, /@media \(forced-colors: active\)/, `${directory} 必须声明 forced-colors 轮廓`)
  }
})

test('SEM-F23/J18: 每个含样式的 renderer 目录都有入口引用共享 token', () => {
  const directories = new Set(componentStyles
    .map((file) => file.slice(0, file.lastIndexOf('/')))
    .filter((directory) => directory !== SHARED_TREE))

  assert.ok(directories.size > 0, '至少要有一个 renderer 目录被扫描到')

  for (const directory of directories) {
    const entries = allFiles.filter((file) => file.startsWith(`${directory}/`))
    const referencesTokens = entries.some((file) => read(file).includes('ui/shared/tokens.css'))
    assert.ok(
      referencesTokens,
      `${directory} 没有任何入口引用 ${TOKEN_TRUTH}；新增 renderer 必须消费共享视觉真相`
    )
  }
})

test('SEM-F23/J18: 开发预览页共用同一视觉真相，且不重新定义语义 token', () => {
  const previewFiles = allFiles.filter((file) => file.startsWith(`${PREVIEW_TREE}/`))
  assert.ok(previewFiles.length > 0, '预览树不存在时应删除本断言，而不是让它空过')

  const entries = previewFiles.filter((file) => file.endsWith('.html'))
  assert.ok(entries.length > 0, '预览树必须有 HTML 入口')
  for (const entry of entries) {
    const html = read(entry)
    assert.match(html, /shared\/tokens\.css/, `${entry} 必须引用共享 token`)
    assert.match(html, /shared\/phases\.css/, `${entry} 必须引用共享 phase 样式`)
  }

  const declaredInTokens = new Set(
    (stripComments(read(TOKEN_TRUTH)).match(/--[a-z0-9-]+\s*:/g) || [])
      .map((declaration) => declaration.replace(/\s*:$/, ''))
  )
  for (const file of previewFiles.filter((name) => name.endsWith('.css'))) {
    const css = stripComments(read(file))
    assert.doesNotMatch(css, /--c-[a-z]/, `${file} 不得直接引用调色板原始值`)
    for (const declaration of css.match(/--[a-z0-9-]+\s*:/g) || []) {
      const name = declaration.replace(/\s*:$/, '')
      assert.ok(
        !declaredInTokens.has(name),
        `${file} 重新定义了共享语义 token ${name}；预览页只能消费，不能另立视觉真相`
      )
    }
  }
})

test('SEM-F23/J18: Agent Bar 预览页自述为设计基准，不冒充旅程证据', () => {
  const page = 'src/ui/preview/agent-bar.html'
  assert.ok(fs.existsSync(path.join(root, page)), `${page} 缺失`)
  const html = read(page)
  assert.match(html, /设计基准/, '预览页必须自述为设计基准')
  assert.match(html, /不构成 J22\/J24 证据/, '预览页必须写明它不构成旅程证据')
  assert.doesNotMatch(html, /agent-run:/, '前置 contract 未冻结，预览页不得展示 agent-run 频道形状')
})

test('SEM-F23/J18: Agent Bar 设计基准与设置页共用同一套控件，不另起炉灶', () => {
  const html = read('src/ui/preview/agent-bar.html')
  assert.match(
    html,
    /settings\/settings\.css/,
    'Agent Bar 设计基准必须直接引用设置窗样式表；抄一份控件样式就等于放任两边各自漂移'
  )

  /* 设置页拥有的控件类。设计基准只许组合，不许重新定义外观。 */
  const SETTINGS_OWNED_CONTROLS = [
    'group', 'row', 'label', 'hint', 'note', 'sub', 'seg', 'field', 'switch',
    'primary-btn', 'secondary-btn', 'link-btn', 'settings-status', 'model-error',
    'resource-list', 'resource-row', 'resource-status', 'resource-actions'
  ]

  const css = stripComments(read('src/ui/preview/agent-bar.css'))
  for (const control of SETTINGS_OWNED_CONTROLS) {
    assert.doesNotMatch(
      css,
      new RegExp(`(^|,)\\s*\\.${control}(?![a-z0-9-])`, 'm'),
      `agent-bar.css 重新定义了设置页的 .${control}；控件外观必须留在 settings.css，这里只做布局组合`
    )
  }

  /* 反过来也要成立：基准页真的在用这套词汇，而不是只 link 了样式表。 */
  const script = read('src/ui/preview/agent-bar.js')
  for (const control of ['group', 'row', 'label', 'hint', 'seg', 'primary-btn', 'secondary-btn', 'link-btn', 'resource-list', 'resource-row']) {
    assert.ok(
      script.includes(`'${control}'`) || script.includes(`'${control} `) || script.includes(` ${control}'`),
      `agent-bar.js 没有使用设置页的 .${control}；设计基准必须由既有控件搭出来`
    )
  }
})

test('SEM-F23/J18: 下拉选择列表由共享控件层统一提供主题与入口', () => {
  const shared = 'src/ui/shared/select.css'
  assert.ok(fs.existsSync(path.join(root, shared)), `${shared} 缺失`)
  const css = stripComments(read(shared))
  assert.match(css, /select\s*\{[^}]*color-scheme:\s*var\(--select-color-scheme\)/s)
  assert.match(css, /select\s*\{[^}]*color:\s*var\(--text-select-option\)/s)
  assert.match(css, /select\s*\{[^}]*background:\s*var\(--surface-input\)/s)
  assert.match(css, /select\s*\{[^}]*border:\s*1px\s+solid\s+var\(--border-input\)/s)
  assert.match(css, /select\s*\{[^}]*border-radius:\s*var\(--radius-control\)/s)
  assert.match(css, /select\s*\{[^}]*padding:\s*var\(--select-control-padding-block\)\s+var\(--select-control-padding-inline\)/s)
  assert.match(css, /select\s*\{[^}]*min-height:\s*var\(--select-control-min-height\)/s)
  assert.match(css, /select\s+option\s*\{[^}]*color:\s*var\(--text-select-option\)/s)
  assert.match(css, /select\s+option\s*\{[^}]*background:\s*var\(--surface-select-menu\)/s)
  assert.match(css, /select\s+option\s*\{[^}]*padding:\s*var\(--select-option-padding-block\)\s+var\(--select-option-padding-inline\)/s)
  assert.match(css, /select\s+option:hover[\s\S]*background:\s*var\(--surface-select-option-hover\)/s)
  assert.match(css, /select\s+option:checked[\s\S]*color:\s*var\(--text-select-option-selected\)/s)
  assert.match(css, /select\s+option:checked[\s\S]*background:\s*var\(--surface-select-option-selected\)/s)
  assert.match(css, /select\s+option:disabled[\s\S]*color:\s*var\(--text-select-option-disabled\)/s)
  assert.match(css, /select\s+option:disabled[\s\S]*background:\s*var\(--surface-select-option-disabled\)/s)
  assert.match(css, /select::picker\(select\)[\s\S]*border:\s*1px\s+solid\s+var\(--border-select-menu\)/s)
  assert.match(css, /select::picker\(select\)[\s\S]*box-shadow:\s*var\(--shadow-select-menu\)/s)
  assert.match(css, /select::picker\(select\)[\s\S]*padding:\s*var\(--select-picker-padding\)/s)
  assert.match(css, /select option:disabled[\s\S]*color:\s*GrayText/)
  assert.match(css, /select\[aria-invalid="true"\][\s\S]*border-color:\s*CanvasText/)
  assert.match(css, /select::picker\(select\)[\s\S]*color:\s*FieldText[\s\S]*background:\s*Field[\s\S]*border-color:\s*CanvasText[\s\S]*box-shadow:\s*none/)
  assert.match(css, /select::picker-icon[\s\S]*color:\s*FieldText/)
  assert.match(css, /@media \(forced-colors: active\)/)
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/)

  const tokens = stripComments(read(TOKEN_TRUTH))
  for (const token of [
    '--surface-select-menu', '--text-select-option', '--surface-select-option-hover',
    '--surface-select-option-selected', '--text-select-option-selected', '--select-color-scheme',
    '--select-control-min-height',
    '--select-control-padding-block', '--select-control-padding-inline',
    '--select-option-padding-block', '--select-option-padding-inline',
    '--select-option-min-height', '--select-picker-padding'
  ]) assert.match(tokens, new RegExp(`${token}\\s*:`), `${token} 必须在共享 token 层定义`)

  const htmlEntries = allFiles.filter((file) => file.endsWith('.html') && read(file).includes('tokens.css'))
  assert.ok(htmlEntries.length > 0, 'renderer HTML 入口不存在')
  for (const entry of htmlEntries) {
    const links = [...read(entry).matchAll(/<link\b[^>]*href=["']([^"']+\.css)["'][^>]*>/gi)].map(([, href]) => href)
    const tokenIndex = links.findIndex((href) => /(?:^|\/)tokens\.css$/.test(href))
    const selectIndex = links.findIndex((href) => /(?:^|\/)select\.css$/.test(href))
    const pageIndex = links.findIndex((href) => !/(?:^|\/)(?:tokens|phases|select)\.css$/.test(href))
    assert.ok(selectIndex >= 0, `${entry} 必须引用共享选择控件样式`)
    assert.ok(tokenIndex >= 0 && selectIndex > tokenIndex, `${entry} 必须先加载 tokens.css，再加载 select.css`)
    assert.ok(pageIndex < 0 || selectIndex < pageIndex, `${entry} 必须在页面自身样式前加载 select.css`)
  }

  const selectSources = allFiles.filter((file) => (
    /\.(?:html|tsx?|jsx?)$/.test(file) && /<select\b/.test(read(file))
  ))
  assert.ok(selectSources.length > 0, '没有发现原生 select 源码；扫描表达式可能失效')
  const rendererRoot = (file) => {
    const parts = file.split('/')
    return parts[1] === 'ui' && parts[2] === 'preview'
      ? 'src/ui/preview'
      : parts.slice(0, 2).join('/')
  }
  for (const source of selectSources) {
    const rootDirectory = rendererRoot(source)
    const entries = allFiles.filter((file) => file.endsWith('.html') && file.startsWith(`${rootDirectory}/`))
    assert.ok(
      entries.some((entry) => /select\.css/.test(read(entry))),
      `${source} 所属 renderer 必须从 HTML 入口加载共享选择控件样式`
    )
  }

  /* 普通主题下 select/option 的外观只能由 shared/select.css 负责；局部文件可以保留布局宽度。
     高对比系统色也必须经过共享 owner，避免某个 renderer 覆盖 picker 的文字/表面。 */
  const visualProperty = /^(?:appearance|background(?:-.+)?|border(?:-.+)?|box-shadow|color(?:-.+)?|color-scheme|cursor|font(?:-.+)?|outline(?:-.+)?|padding(?:-.+)?|opacity|transition(?:-.+)?)$/
  const cssRule = /([^{}]+)\{([^{}]*)\}/g
  const rendererCss = allFiles.filter((file) => file.endsWith('.css') && file !== TOKEN_TRUTH && file !== shared)
  for (const file of rendererCss) {
    const local = stripComments(read(file))
    for (const match of local.matchAll(cssRule)) {
      const selector = match[1].trim()
      if (!/\b(?:select|option)\b/.test(selector)) continue
      const properties = [...match[2].matchAll(/([a-z-]+)\s*:/gi)].map(([, name]) => name.toLowerCase())
      const duplicate = properties.filter((name) => visualProperty.test(name))
      assert.deepEqual(
        duplicate,
        [],
        `${file} 的 ${selector} 不得重新定义选择控件外观；布局规则可保留，外观必须进入 ${shared}`
      )
    }
  }
})

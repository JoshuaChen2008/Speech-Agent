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
  'src/agent-mvp',
  'src/agent-core',
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

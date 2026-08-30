'use strict'

/* test/ui 的设置窗载入器：把 TSX/TS 源就地编译成 CJS，在 node:test 进程里直接
   求值，不引入打包步骤，也不要求源文件为测试留任何适配代码。
   settings-view.tsx 需要 oxc 转 JSX；src/ui/shared 下的纯视图模型只需剥类型。 */

const fs = require('node:fs')
const Module = require('node:module')
const path = require('node:path')

const { transpileRenderer } = require('./transpile-renderer')

const root = path.resolve(__dirname, '..', '..')
const VIEW_MODEL_PATH = path.join(root, 'src', 'ui', 'shared', 'personal-context-ui.ts')
const SETTINGS_VIEW_PATH = path.join(root, 'src', 'settings', 'settings-view.tsx')

function compile (filename, source) {
  const loaded = new Module(filename, module)
  loaded.filename = filename
  loaded.paths = Module._nodeModulePaths(path.dirname(filename))
  loaded._compile(source, filename)
  return loaded.exports
}

/** 剥类型后把 ESM 命名导出转成 module.exports，保持导出集合与源一致。 */
function loadViewModel (filename = VIEW_MODEL_PATH) {
  const stripped = transpileRenderer(filename)
  const names = [...stripped.matchAll(/^export (?:const|function) ([A-Za-z0-9_]+)/gm)].map((match) => match[1])
  const source = `${stripped.replace(/^export (const|function) /gm, '$1 ')}\nmodule.exports = { ${names.join(', ')} };\n`
  return compile(filename, source)
}

/* 图标只在生产里注入 SVG 标记，测试用哑实现替换，避免断言依赖图形资源。
   视图模型走同一份 src 源，不做第二份测试替身，否则标签与请求形状会 drift。 */
async function loadSettingsView (filename = SETTINGS_VIEW_PATH) {
  const { transformWithOxc } = await import('vite')
  const transformed = await transformWithOxc(fs.readFileSync(filename, 'utf8'), filename, { lang: 'tsx' })
  const source = transformed.code
    .replace(/import \{([^}]+)\} from "react";/, (_, names) => `const {${names.replaceAll(' as ', ': ')}} = require("react");`)
    .replace(/import Icons from "\.\.\/ui\/shared\/fluent-icons";/,
      'const Icons = { iconMarkup: () => `<svg aria-hidden="true"></svg>` };')
    .replace(/import \* as PC from "\.\.\/ui\/shared\/personal-context-ui";/,
      `const PC = require(${JSON.stringify(__filename)}).loadViewModel();`)
    .replace(/import \{([^}]+)\} from "react\/jsx-runtime";/,
      (_, names) => `const {${names.replaceAll(' as ', ': ')}} = require("react/jsx-runtime");`)
    .replace('export function SettingsView', 'function SettingsView') + '\nmodule.exports = { SettingsView };\n'
  return compile(filename, source).SettingsView
}

module.exports = { SETTINGS_VIEW_PATH, VIEW_MODEL_PATH, loadSettingsView, loadViewModel }

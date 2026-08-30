'use strict'

// 递归装载 renderer 的 .tsx/.ts 模块图，供 node:test 直接 require。
// 单文件场景可以手工内联转换（见既有 settings-react-ui.test.js 的旧写法）；
// 一旦某个 renderer 文件 import 了本仓库内的其它相对模块（如
// agent-model-pane.tsx → agent-model-view-model.ts），就需要这里的递归版本：
// 每个文件各自剥离类型/编译 JSX 一次，编译结果注册进 Module._cache，
// 让父模块编译后的 require(...) 调用按 Node 正常解析规则命中缓存。

const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const { stripTypeScriptTypes } = require('node:module')

let extensionsRegistered = false
function registerNoopExtensions () {
  if (extensionsRegistered) return
  extensionsRegistered = true
  const noop = () => {}
  Module._extensions['.ts'] = noop
  Module._extensions['.tsx'] = noop
}

function resolveRelative (fromFile, specifier) {
  const base = path.resolve(path.dirname(fromFile), specifier)
  for (const candidate of [base, `${base}.tsx`, `${base}.ts`]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate
  }
  throw new Error(`cannot resolve renderer module "${specifier}" from ${fromFile}`)
}

function convertReactImports (code) {
  return code
    .replace(/import \{([^}]+)\} from "react";/, (_, names) => `const {${names.replaceAll(' as ', ': ')}} = require("react");`)
    .replace(/import \{([^}]+)\} from "react\/jsx-runtime";/,
      (_, names) => `const {${names.replaceAll(' as ', ': ')}} = require("react/jsx-runtime");`)
    .replace(/import Icons from "\.\.\/ui\/shared\/fluent-icons";/,
      'const Icons = { iconMarkup: () => `<svg aria-hidden="true"></svg>` };')
}

function relativeImportSpecifiers (code) {
  const specifiers = new Set()
  for (const match of code.matchAll(/from "(\.[^"]+)"/g)) specifiers.add(match[1])
  return [...specifiers]
}

function convertRelativeImports (code) {
  return code.replace(/import \{([^}]+)\} from "(\.[^"]+)";/g,
    (_, names, specifier) => `const {${names.replaceAll(' as ', ': ')}} = require("${specifier}");`)
}

function collectExportedNames (code) {
  const names = []
  const stripped = code.replace(/export (function|const) (\w+)/g, (_, kind, name) => { names.push(name); return `${kind} ${name}` })
  return { code: stripped, names }
}

async function loadRendererModule (absoluteFilename) {
  registerNoopExtensions()
  if (Module._cache[absoluteFilename]) return Module._cache[absoluteFilename].exports

  const source = fs.readFileSync(absoluteFilename, 'utf8')
  let code
  if (absoluteFilename.endsWith('.tsx')) {
    const { transformWithOxc } = await import('vite')
    code = (await transformWithOxc(source, absoluteFilename, { lang: 'tsx' })).code
  } else {
    code = stripTypeScriptTypes(source, { mode: 'strip' })
  }

  code = convertReactImports(code)
  for (const specifier of relativeImportSpecifiers(code)) {
    if (specifier.includes('fluent-icons')) continue
    await loadRendererModule(resolveRelative(absoluteFilename, specifier))
  }
  code = convertRelativeImports(code)
  const { code: finalCode, names } = collectExportedNames(code)
  const withExports = `${finalCode}\nmodule.exports = Object.assign(module.exports || {}, { ${names.join(', ')} });\n`

  const mod = new Module(absoluteFilename, module)
  mod.filename = absoluteFilename
  mod.paths = Module._nodeModulePaths(path.dirname(absoluteFilename))
  Module._cache[absoluteFilename] = mod
  mod._compile(withExports, absoluteFilename)
  return mod.exports
}

module.exports = { loadRendererModule }

'use strict'

// @ts-check

/* 把 src/contracts/fixtures/ 打成 renderer 可用的全局脚本。
   renderer 走 file://，CSP 是 script-src 'self'，fetch 和 ES module 都被 CORS 挡掉，
   <script> 标签是唯一的跨目录数据通道，所以需要这一步。

   消费者有两个：预览页，以及工具条在 B1 之前的演示模式。
   每条 fixture 在写出前都用契约本身校验一遍 —— 两者因此都不可能显示出
   后端产不出来的数据。fixtures 变了就重跑：npm run preview:fixtures */

const fs = require('node:fs')
const path = require('node:path')

const {
  assertRuntimeSnapshot,
  assertCaptionEvent,
  assertCommandResult,
  assertCapabilities
} = require('../src/contracts')
const fixtures = require('../src/contracts/fixtures')

const VALIDATORS = {
  runtime: assertRuntimeSnapshot,
  captions: assertCaptionEvent,
  commands: assertCommandResult,
  capabilities: assertCapabilities
}

const OUT = path.join(__dirname, '..', 'src', 'ui', 'shared', 'fixtures.generated.js')

function main () {
  let count = 0
  for (const [group, entries] of Object.entries(fixtures)) {
    const validate = VALIDATORS[group]
    if (!validate) throw new Error(`没有为 fixtures.${group} 配置校验器`)
    for (const [name, value] of Object.entries(entries)) {
      try {
        validate(value, `fixtures.${group}.${name}`)
      } catch (err) {
        console.error(`✗ fixtures.${group}.${name} 不满足契约：${err.message}`)
        process.exitCode = 1
        return
      }
      count += 1
    }
  }

  const banner = [
    '/* 自动生成，请勿手改。',
    '   来源：src/contracts/fixtures/ · 生成器：scripts/build-preview-fixtures.js',
    '   重新生成：npm run preview:fixtures */',
    ''
  ].join('\n')

  const body = `window.FIXTURES = Object.freeze(${JSON.stringify(fixtures, null, 2)})\n`

  fs.mkdirSync(path.dirname(OUT), { recursive: true })
  fs.writeFileSync(OUT, banner + body, 'utf8')
  console.log(`✓ ${count} 条 fixture 通过契约校验 → ${path.relative(process.cwd(), OUT)}`)
}

main()

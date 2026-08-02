'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const ROOT = path.resolve(__dirname, '../..')

test('acceptance navigation projects every remaining subtitle MVP machine gate', () => {
  const navigation = fs.readFileSync(path.join(ROOT, 'docs', 'validation', 'README.md'), 'utf8')
  const semantic = fs.readFileSync(path.join(ROOT, 'docs', 'semantic-contract.md'), 'utf8')
  const strategy = fs.readFileSync(path.join(ROOT, 'docs', 'testing-strategy.md'), 'utf8')

  for (const gate of ['J9-CI', 'J15a', 'I2', 'I3', 'I4']) {
    assert.match(navigation, new RegExp(`\\b${gate}\\b`))
  }
  for (const status of ['已决定', '实现完成·尚未验收', '联合验收完成', '实机验收完成']) {
    assert.match(navigation, new RegExp(status))
  }
  assert.match(navigation, /是否发声\/采集/)
  assert.match(navigation, /当前证据/)
  assert.match(navigation, /下一动作/)
  assert.match(semantic, /device-removal-retry/)
  assert.match(semantic, /sleep-wake-retry/)
  assert.match(strategy, /I4 音频发布子门禁/)
})

test('current acceptance projections record the exact failed CI run instead of the stale no-run claim', () => {
  const files = [
    'README.md',
    'PLAN.md',
    path.join('docs', 'semantic-contract.md'),
    path.join('docs', 'testing-strategy.md'),
    path.join('docs', 'validation', 'b5-packaging.md'),
    path.join('docs', 'validation', 'README.md')
  ]
  for (const file of files) {
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8')
    assert.match(source, /30750568366/, `${file} must name the exact failed run`)
    assert.doesNotMatch(source, /尚未提交\/推送|尚未在本工作树对应提交上取得 GitHub Actions 结果/,
      `${file} must not keep the superseded no-run status`)
  }
})

test('J9-CI status projects the authoritative implemented-but-unaccepted qualification boundary', () => {
  const navigation = fs.readFileSync(path.join(ROOT, 'docs', 'validation', 'README.md'), 'utf8')
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8')
  const semantic = fs.readFileSync(path.join(ROOT, 'docs', 'semantic-contract.md'), 'utf8')
  const strategy = fs.readFileSync(path.join(ROOT, 'docs', 'testing-strategy.md'), 'utf8')

  const navigationRow = navigation.split(/\r?\n/).find((line) => line.includes('| J9-CI ')) || ''
  const readmeRow = readme.split(/\r?\n/).find((line) => line.includes('| 远端 Windows CI 资格 ')) || ''
  const semanticRow = semantic.split(/\r?\n/).find((line) => line.includes('**SEM-T03**')) || ''
  const strategyRow = strategy.split(/\r?\n/).find((line) => line.includes('| J9-CI |')) || ''

  for (const row of [navigationRow, readmeRow, semanticRow, strategyRow]) {
    assert.match(row, /实现完成·尚未验收/)
    assert.match(row, /30750568366/)
  }
  assert.match(navigationRow, /Electron `43\.2\.0`/)
  assert.match(readmeRow, /修复为已决定/)
})

test('I4 projections separate the implemented non-audio child from the decided complete gate', () => {
  const navigation = fs.readFileSync(path.join(ROOT, 'docs', 'validation', 'README.md'), 'utf8')
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8')
  const plan = fs.readFileSync(path.join(ROOT, 'PLAN.md'), 'utf8')
  const strategy = fs.readFileSync(path.join(ROOT, 'docs', 'testing-strategy.md'), 'utf8')

  const navigationChildRow = navigation.split(/\r?\n/).find((line) => line.includes('| I4 非音频子门禁 ')) || ''
  const navigationCompleteRow = navigation.split(/\r?\n/).find((line) => line.includes('| I4 完整干净机发布验收 ')) || ''
  const readmeChildRow = readme.split(/\r?\n/).find((line) => line.includes('| I4 非音频干净 Windows 子门禁 ')) || ''
  const readmeCompleteRow = readme.split(/\r?\n/).find((line) => line.includes('| 完整 I4 干净机发布验收 ')) || ''
  const planRow = plan.split(/\r?\n/).find((line) => line.includes('I4 Packaged Subtitle MVP')) || ''
  const strategyRow = strategy.split(/\r?\n/).find((line) => line.includes('| J9-I4 |')) || ''

  assert.match(navigationChildRow, /^\| I4 非音频子门禁 \| 实现完成·尚未验收 \|/)
  assert.match(readmeChildRow, /^\| I4 非音频干净 Windows 子门禁 \| 实现完成·尚未验收 \|/)
  assert.match(navigationCompleteRow, /^\| I4 完整干净机发布验收 \| 已决定 \|/)
  assert.match(readmeCompleteRow, /^\| 完整 I4 干净机发布验收 \| 已决定 \|/)
  assert.match(planRow, /^\| \*\*I4 Packaged Subtitle MVP（已决定）\*\* \|/)
  assert.match(strategyRow, /非音频子门禁为实现完成·尚未验收/)
  assert.match(strategyRow, /完整 I4 为已决定/)
})

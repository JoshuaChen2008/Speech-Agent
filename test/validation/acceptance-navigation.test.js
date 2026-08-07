'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const ROOT = path.resolve(__dirname, '../..')
const REMOTE_COUNTS_PATTERN = /core 422 tests=415 pass\+7 expected (?:model\/Silero-asset )?skips、integration 29\/29、evidence 204\/204[；，]总计 655 tests=648 pass\+7 expected skips\+0 fail/

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

  const plan = fs.readFileSync(path.join(ROOT, 'PLAN.md'), 'utf8')
  const i3PlanRow = plan.split(/\r?\n/).find((line) => line.includes('| **I3 Durable Subtitle Session')) || ''
  assert.match(i3PlanRow, /^\| \*\*I3 Durable Subtitle Session（实现完成·尚未验收）\*\* \|/)
  assert.match(i3PlanRow, /首次稳定转写\/精修稿/)
  assert.match(i3PlanRow, /82d56f64c80c74f30c1944665460f1316f1d7939/)
  assert.match(i3PlanRow, /0c219b9627618cdda12ad41ae77093fd5f7bcccbe30b042c1c9cad2958d702f4/)
  assert.match(i3PlanRow, /`pass\/partial`/)
  assert.doesNotMatch(i3PlanRow, /非音频与真实资格完成|\bfinal\/refined\b/)
})

test('I2 projections reopen Gate 0B replacement evaluation without moving the frozen acceptance boundary', () => {
  const files = [
    'PLAN.md',
    'README.md',
    path.join('docs', 'semantic-contract.md'),
    path.join('docs', 'testing-strategy.md'),
    path.join('docs', 'runtime-architecture.md'),
    path.join('docs', 'validation', 'README.md'),
    path.join('docs', 'validation', 'gate-0b.md'),
    path.join('docs', 'validation', 'i2-real-source-series.md')
  ]
  for (const file of files) {
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8')
    assert.match(source, /重新开启 (?:Gate 0B )?(?:实时|realtime)\s*模型替换评估|reopen Gate 0B replacement evaluation/,
      `${file} must project the realtime model replacement decision`)
    assert.match(source, /替代模型尚未选定|尚未选定替代模型|替代候选尚未选定|No replacement model has been selected|尚未批准任何替代 realtime 模型/,
      `${file} must not claim a replacement has already been selected`)
  }

  const semantic = fs.readFileSync(path.join(ROOT, 'docs', 'semantic-contract.md'), 'utf8')
  const strategy = fs.readFileSync(path.join(ROOT, 'docs', 'testing-strategy.md'), 'utf8')
  const navigation = fs.readFileSync(path.join(ROOT, 'docs', 'validation', 'README.md'), 'utf8')
  const gate0b = fs.readFileSync(path.join(ROOT, 'docs', 'validation', 'gate-0b.md'), 'utf8')
  const semanticDecision = semantic.split(/\r?\n/).find((line) => line.includes('I2 模型替换决策（SEM-F01/SEM-T14/J1）')) || ''
  const j1Row = strategy.split(/\r?\n/).find((line) => line.startsWith('| J1 |')) || ''
  const gateHeading = '## 2026-08-03 I2 集成复核：重新开启 realtime 模型替换评估'
  const gateDecisionOffset = gate0b.indexOf(gateHeading)
  assert.ok(gateDecisionOffset >= 0, 'Gate 0B must contain the dated current replacement decision')
  const gateDecision = gate0b.slice(gateDecisionOffset)

  for (const [label, section] of [
    ['dated semantic decision', semanticDecision],
    ['J1 row', j1Row],
    ['dated Gate 0B decision', gateDecision]
  ]) {
    assert.match(section, /当前观测|已观察到/, `${label} must scope the decision to the observed composition`)
    assert.match(section, /不是物理下限证明/, `${label} must reject a physical-lower-bound overclaim`)
    assert.match(section, /已决定/, `${label} must record the engineering decision explicitly`)
    assert.match(section, /尚未选定替代模型|替代候选尚未选定|尚未批准任何替代 realtime 模型/,
      `${label} must not select a replacement model`)
    assert.doesNotMatch(section,
      /继续调整该候选不能闭合 I2|已处于其语料音频下限附近|修改线程、provisional 上限或 Silero 参数不能满足产品冻结门槛|物理不可(?:能|达)/,
      `${label} must not turn observed maxima into physical impossibility`)
  }
  for (const source of [semantic, strategy, navigation]) {
    assert.match(source, /<1000ms|<1000 ms/)
    assert.match(source, /source t0 \+ 140ms/)
  }
  assert.match(semantic, /534\.562ms/)
  assert.match(strategy, /534\.562ms/)
  assert.match(navigation.split(/\r?\n/).find((line) => line.includes('| I2 真实来源与交互恢复 |')) || '',
    /^\| I2 真实来源与交互恢复 \| 实现完成·尚未验收 \|/)
})

test('current acceptance projections retain failed CI revisions and record the exact current qualified run', () => {
  const historicalFiles = [
    'PLAN.md',
    path.join('docs', 'semantic-contract.md'),
    path.join('docs', 'validation', 'b5-packaging.md')
  ]
  for (const file of historicalFiles) {
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8')
    assert.match(source, /30750568366/, `${file} must retain the original prerequisite failure`)
    assert.match(source, /30760407160/, `${file} must retain the refinement fixture failure`)
    assert.match(source, /30761472817/, `${file} must retain the first evidence portability failure`)
    assert.match(source, /30763123116/, `${file} must retain the product payload portability failure`)
    assert.match(source, /30764235663/, `${file} must retain the latest exact failed run`)
    assert.match(source, /30765231206/, `${file} must name the successful workflow whose artifact exposed the checkout drift`)
    assert.match(source, /30766172580/, `${file} must name the downloaded qualified workflow`)
  }
  const projectionFiles = [
    'README.md',
    path.join('docs', 'testing-strategy.md'),
    path.join('docs', 'validation', 'README.md')
  ]
  for (const file of projectionFiles) {
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8')
    assert.match(source, /31191838016/, `${file} must project the current downloaded qualified workflow`)
    assert.match(source, /8999273285/, `${file} must project the current artifact identity`)
    assert.match(source, /5ce4070cee109df6d3d86b43b165b20a40636e8e3cd638fd9f28096da95855af|5ce4070c…55af/,
      `${file} must project the current artifact digest`)
    assert.match(source, REMOTE_COUNTS_PATTERN, `${file} must separate discovered, passed, and expected-skip counts`)
    assert.doesNotMatch(source, /631 项回归成功|631 项回归均返回/,
      `${file} must not count hosted model-asset skips as passed tests`)
  }
  for (const file of historicalFiles) {
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8')
    assert.match(source, /30786324179/, `${file} must retain the exact current-head CI failure`)
    assert.match(source, /c36aefaee4778a1bf2dfe1ee005924a724f4be53/,
      `${file} must bind the current-head CI failure to its exact revision`)
    assert.match(source, /I3 live playback HTML|scripts\/i2-live-caption-player\.html/,
      `${file} must retain the LF provenance root cause`)
    assert.match(source, /LF/, `${file} must name the failed checkout invariant`)
    assert.match(source, /30787209338/, `${file} must record the successful LF repair workflow`)
    assert.match(source, /f86ac1ef604dc7da0728c6eda44d59bbfd1e09bf/,
      `${file} must bind the successful LF repair workflow to its exact revision`)
  }
  for (const file of [...historicalFiles, ...projectionFiles]) {
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8')
    assert.doesNotMatch(source, /尚未提交\/推送|尚未在本工作树对应提交上取得 GitHub Actions 结果/,
      `${file} must not keep the superseded no-run status`)
  }
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8')
  const strategy = fs.readFileSync(path.join(ROOT, 'docs', 'testing-strategy.md'), 'utf8')
  const readmeLocalRow = readme.split(/\r?\n/).find((line) => line.includes('| 非音频回归与同源两阶段实时识别 |')) || ''
  const readmeRemoteRow = readme.split(/\r?\n/).find((line) => line.includes('| 远端 Windows CI 资格 |')) || ''
  assert.match(readmeLocalRow, REMOTE_COUNTS_PATTERN)
  assert.doesNotMatch(readmeLocalRow, /evidence 188|共 629 项|共 641 项|总计 642 tests/)
  assert.match(readmeRemoteRow, /run `31191838016`/)
  assert.match(readmeRemoteRow, REMOTE_COUNTS_PATTERN)
  assert.match(strategy, /revision `bbfd7041e5963e51942392323735298a7b81cb30` \/ run `31191838016`/)
  assert.match(strategy, REMOTE_COUNTS_PATTERN)
})

test('J9-CI status projects the authoritative deterministic joint acceptance boundary', () => {
  const navigation = fs.readFileSync(path.join(ROOT, 'docs', 'validation', 'README.md'), 'utf8')
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8')
  const plan = fs.readFileSync(path.join(ROOT, 'PLAN.md'), 'utf8')
  const semantic = fs.readFileSync(path.join(ROOT, 'docs', 'semantic-contract.md'), 'utf8')
  const strategy = fs.readFileSync(path.join(ROOT, 'docs', 'testing-strategy.md'), 'utf8')
  const b5 = fs.readFileSync(path.join(ROOT, 'docs', 'validation', 'b5-packaging.md'), 'utf8')

  const navigationRow = navigation.split(/\r?\n/).find((line) => line.includes('| J9-CI ')) || ''
  const readmeRow = readme.split(/\r?\n/).find((line) => line.includes('| 远端 Windows CI 资格 ')) || ''
  const semanticRow = semantic.split(/\r?\n/).find((line) => line.includes('**SEM-T03**')) || ''
  const semanticPrevious = semantic.split(/\r?\n/).find((line) => line.includes('I3 修复代码候选 T03/J9-CI 证据')) || ''
  const semanticCurrent = semantic.split(/\r?\n/).find((line) => line.includes('I3 live provenance LF 修复候选 T03/J9-CI 证据')) || ''
  const semanticLatest = semantic.split(/\r?\n/).find((line) => line.includes('最新 I2 模型替换决策证据投影')) || ''
  const semanticPackagingRow = semantic.split(/\r?\n/).find((line) => line.includes('**SEM-F18**')) || ''
  const semanticReleaseEvidenceRow = semantic.split(/\r?\n/).find((line) => line.includes('**SEM-T12**')) || ''
  const strategyRow = strategy.split(/\r?\n/).find((line) => line.includes('| J9-CI |')) || ''
  const planRow = plan.split(/\r?\n/).find((line) => line.includes('**B5 字幕 MVP 分发')) || ''

  for (const source of [navigation, readme, plan, semantic, strategy, b5]) {
    assert.match(source, /联合验收完成/)
    assert.match(source, /31191838016/)
    assert.match(source, /bbfd7041e5963e51942392323735298a7b81cb30|bbfd7041…cb30/)
    assert.match(source, /8999273285/)
    assert.match(source, REMOTE_COUNTS_PATTERN)
  }
  assert.match(semanticRow, /J9-CI 已达到联合验收完成/)
  assert.match(semanticPrevious, /82d56f64c80c74f30c1944665460f1316f1d7939/)
  assert.match(semanticPrevious, /78227ef5b4af08f3f2319156cb4ef096a132599707446506c32124f0ecbcdaca/)
  assert.match(semanticPrevious, /bdac65edc7541070b9e2b4af13550b5768ff0bc86b4048b13fd6e7aca7dea7c4/)
  assert.match(semanticCurrent, /b9d0a56b55fa4c6728be660698654bce418ee6364fd43a59eb1be9ccb9993242/)
  assert.match(semanticCurrent, /b9becb191234cefa6ddfba48bc2865379d6dc62f1a7020c85124df02f2516f31/)
  assert.match(semanticLatest, /5968779b61db0eb6f6d2d7e7dcaa3d0a38844f8987a43941bb4395aff5ba69ef/)
  assert.match(semanticLatest, /618f02eddbbd3a956d679b17180817665d48dd0b9608262fd6519f53eac857e0/)
  assert.match(semanticLatest, /不表示 Gate 0B 已选定替代模型/)
  for (const row of [strategyRow, semanticPackagingRow, semanticReleaseEvidenceRow]) {
    assert.match(row, /revision `bbfd7041e5963e51942392323735298a7b81cb30` \/ run `31191838016`/)
    assert.match(row, /d77d16c0…060c/)
    assert.match(row, /e95fd87f…a35a/)
    assert.match(row, /下载 artifact 不含 installer 字节/)
    assert.match(row, /历史本地候选 `d862c5fc…0de10` \/ `a1f03ed6…9accc`/)
    assert.doesNotMatch(row, /当前本机(?: B5 )?候选[^。]*(?:d862c5fc|a1f03ed6)|当前 B5 七份证据已绑定 SHA `d862c5fc/)
  }
  assert.match(navigationRow, /\| J9-CI 远端资格 \| 联合验收完成 \|/)
  assert.match(readmeRow, /\| 远端 Windows CI 资格 \| 联合验收完成 \|/)
  assert.match(navigation, /Electron `43\.2\.0`/)
  for (const source of [plan, semantic, b5]) {
    assert.match(source, /31191838016/)
    assert.match(source, /bbfd7041e5963e51942392323735298a7b81cb30/)
    assert.match(source, /8999273285/)
    assert.match(source, /d77d16c00337696727e00ad41d3fc61e1eab85d99edc4527c7cf55b548e0060c|d77d16c0…060c/)
    assert.match(source, REMOTE_COUNTS_PATTERN)
  }
})

test('I4 projections keep implemented report entry points separate from unaccepted clean-machine evidence', () => {
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
  assert.match(navigationCompleteRow, /^\| I4 完整干净机发布验收 \| 实现完成·尚未验收 \|/)
  assert.match(readmeCompleteRow, /^\| 完整 I4 干净机发布验收 \| 实现完成·尚未验收 \|/)
  assert.match(planRow, /^\| \*\*I4 Packaged Subtitle MVP（实现完成·尚未验收）\*\* \|/)
  assert.match(strategyRow, /入口现均为实现完成·尚未验收/)
  assert.match(navigationCompleteRow, /尚无专用机报告/)
  assert.match(readmeCompleteRow, /尚无专用干净 Win11 三份 child 报告/)
  assert.match(planRow, /尚无专用干净 Win11 的三份 child 报告/)
  assert.match(strategyRow, /尚无合格干净机三份 child 报告/)
})

test('SEM-F21/J16 projects the implemented same-source two-stage boundary without overclaiming model acceptance', () => {
  const context = fs.readFileSync(path.join(ROOT, 'CONTEXT.md'), 'utf8')
  const semantic = fs.readFileSync(path.join(ROOT, 'docs', 'semantic-contract.md'), 'utf8')
  const strategy = fs.readFileSync(path.join(ROOT, 'docs', 'testing-strategy.md'), 'utf8')
  const runtime = fs.readFileSync(path.join(ROOT, 'docs', 'runtime-architecture.md'), 'utf8')

  const semanticRow = semantic.split(/\r?\n/).find((line) => line.includes('**SEM-F21**')) || ''
  const supplyRow = semantic.split(/\r?\n/).find((line) => line.includes('**SEM-F17**')) || ''
  const modelJourneyRow = strategy.split(/\r?\n/).find((line) => line.startsWith('| J14 |')) || ''
  const refinementJourneyRow = strategy.split(/\r?\n/).find((line) => line.startsWith('| J15c |')) || ''
  const journeyRow = strategy.split(/\r?\n/).find((line) => line.startsWith('| J16 |')) || ''

  assert.match(context, /\*\*临时字幕识别器（Draft Recognizer）\*\*/)
  assert.match(context, /\*\*权威识别器（Authoritative Recognizer）\*\*/)
  assert.match(semanticRow, /每个会话仍只选择一个 `mic` 或 `loopback` 来源/)
  assert.match(semanticRow, /Zipformer 仅发布低延迟 `partial`/)
  assert.match(semanticRow, /X-ASR 独占首次 `final`/)
  assert.match(semanticRow, /不得让临时字幕识别器产生 `final\/refined`/)
  assert.match(semanticRow, /`DRAFT_RECOGNIZER_START_FAILED`/)
  assert.match(semanticRow, /`DRAFT_RECOGNIZER_FAILED`/)
  assert.match(semanticRow, /联合验收完成/)
  assert.match(semanticRow, /schema-v4 四资源 packaged 首启\/复启已闭合/)
  assert.match(supplyRow, /临时字幕识别器、权威识别器与 VAD/)
  assert.match(modelJourneyRow, /临时字幕识别器、权威识别器与 VAD 三项严格 ready marker/)
  assert.match(modelJourneyRow, /联合验收完成/)
  assert.match(modelJourneyRow, /schema-v4 产品壳与 packaged 首启\/复启/)
  assert.match(refinementJourneyRow, /三项核心 marker、四项总资源/)
  assert.match(refinementJourneyRow, /确定性范围已达到联合验收完成/)
  assert.doesNotMatch(refinementJourneyRow, /SEM-F21 的核心 ready 扩展为实现完成·尚未验收|当前四资源 B4/)
  assert.match(journeyRow, /单份 PCM 经 VAD 后同时驱动/)
  assert.match(journeyRow, /SQLite、历史和导出只包含该首次稳定转写/)
  assert.match(journeyRow, /报告及 SQLite\/历史\/导出必须验证零临时字幕正文/)
  assert.match(journeyRow, /权威识别器故障仍进入 Retry/)
  assert.match(journeyRow, /联合验收完成/)
  assert.match(runtime, /SEM-F21 同源两阶段识别/)
})

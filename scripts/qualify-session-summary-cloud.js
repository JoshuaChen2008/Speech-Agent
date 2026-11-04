'use strict'

// Explicit cloud qualification using the normal product storage and Agent Loop.
// No audio host or window is started. Minutes stay in the product database;
// this script writes only bounded metrics, booleans and canonical hashes.
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { app, safeStorage } = require('electron')
const { StorageGateway } = require('../src/main/services/storage-gateway')
const { SqliteSessionRecorder } = require('../src/main/services/sqlite-session-recorder')
const { ConfigStore } = require('../src/main/services/config-store')
const { CredentialVault } = require('../src/agent/model-access/credential-vault')
const { ModelAccessRuntime } = require('../src/agent/model-access/runtime')
const { createPersonalContextExecutionAdapter } = require('../src/agent/personal-context')
const { FormalAgentRunRunner, FormalAgentJobScheduler, IntentRouteOrchestrator, AgentLoopExecutor } = require('../src/agent/execution-host')
const { AgentOperationService } = require('../src/agent/formal-run/agent-operation-service')
const { buildExportSnapshot } = require('../src/agent/formal-run/agent-interaction-exporter')
const { canonicalize, sha256Canonical } = require('../src/runtime/storage-worker/canonical-json')
const { createMainEvidenceBridge } = require('../src/main/services/electron-exit-evidence')
const c = require('../src/agent/contracts/session-summary-run-ui')
const { assertSummaryTopicIndex, validateRecipeOutput } = require('../src/agent/contracts/recipes')

function argumentsFor (args) {
  const result = {}
  for (let i = 0; i < args.length; i++) {
    const key = args[i]
    if (key === '--execute') { result.execute = true; continue }
    if (!['--user-data', '--source-session', '--report'].includes(key) || !args[i + 1] || result[key]) throw new Error('INVALID_ARGUMENTS')
    result[key] = args[++i]
  }
  if (!result.execute || !path.isAbsolute(result['--user-data'] || '') || !result['--source-session'] || !result['--report']) throw new Error('INVALID_ARGUMENTS')
  const report = path.resolve(result['--report'])
  const workspace = path.resolve(__dirname, '..') + path.sep
  if (!report.startsWith(workspace) || !report.endsWith('.json')) throw new Error('INVALID_REPORT_TARGET')
  return { userData: path.resolve(result['--user-data']), sessionId: result['--source-session'], report }
}

const samples = [
  [
    '合成验收样本 A。讨论项目曙光发布。预算最初120万元，建议在2026-10-20发布，小陈负责验证；尚未决定。',
    '先转到接口：并发上限为8，错误率阈值0.5%；小林负责压力测试，截止2026-10-18。',
    '回到曙光发布：预算改为80万元。否定10月20日发布的建议：本次不批准发布；若错误率低于0.5%且审查通过，再讨论日期。小陈只负责验证，不是发布负责人；发布时间尚未确定。',
    '接口补充：并发上限从8修订为6。保留小林在2026-10-18前完成压力测试的待办。',
    '本次唯一确认决定是将预算调整为80万元和并发上限调整为6；没有承诺发布时间。'
  ],
  [
    '合成验收样本 B。迁移候选方案为周一2026-11-02停机30分钟，建议由王敏负责；只是提议，尚未决定。',
    '采购议题：最初报价18,000元，交付日期11月10日。赵军负责核实报价，截止2026-10-16；不要自动采购。',
    '回到迁移：撤销停机30分钟的提议。当前要求是不停机；只安排演练，演练负责人尚未指定，期限未定。没有批准正式迁移。',
    '采购更正：有效报价为15,500元，11月10日交付的说法撤销，交付日期待供应商确认。保留赵军核实报价的待办；王敏没有接受迁移负责人职责。',
    '再次确认：没有采购决定、没有正式迁移决定；演练与报价核实是下一步。'
  ]
]

function qualityFacts (minutes, index) {
  const content = [minutes.overview, ...minutes.topics.map(t => t.text), ...minutes.conclusions.map(t => t.text), ...minutes.todos.map(t => t.text), ...minutes.risks.map(t => t.text)].join('\n')
  const decisions = minutes.conclusions.map(t => t.text).join('\n')
  const date = value => String(value || '').replace(/\s/g, '')
  if (index === 0) {
    const pressure = minutes.todos.find(t => /压力|压测/.test(t.text))
    const verification = minutes.todos.find(t => /验证/.test(t.text))
    return {
      revisedBudget: /80\s*万|800[,，]?000/.test(content),
      revisedConcurrency: /并发[^\n。；]{0,40}(?:6|六)/.test(content),
      releaseNotApproved: /不.{0,6}(?:批准|发布)|未.{0,6}(?:批准|决定)|撤销|取消/.test(content),
      conditionsPreserved: /0[.．]5\s*[%％]/.test(content) && /审查/.test(content) && /低于|小于|<|＜/.test(content),
      pressureOwnerAndDeadline: pressure?.ownerHint === '小林' && /10[-/月.]?18/.test(date(pressure?.dueHint)),
      verificationOwnership: verification?.ownerHint === '小陈' && verification.dueHint === null,
      noInventedOwnerOrDeadline: minutes.todos.every(t => t.ownerHint === null || t.ownerHint === '小林' || t.ownerHint === '小陈') && minutes.todos.every(t => t.dueHint === null || t.ownerHint === '小林' && /10[-/月.]?18/.test(date(t.dueHint))),
      noRevokedCurrentDecision: !/(?:预算|金额)[^\n。；]{0,15}(?:确定为|调整为|批准为)\s*120|(?:并发)[^\n。；]{0,15}(?:确定为|调整为|批准为)\s*8|(?:决定|批准)在[^\n。；]{0,15}20.{0,3}发布/.test(decisions),
      revisitedTopicsLinked: minutes.topics.some(t => /预算/.test(t.text) && /发布/.test(t.text))
    }
  }
  const quote = minutes.todos.find(t => /报价|价格/.test(t.text))
  const rehearsal = minutes.todos.find(t => /演练/.test(t.text))
  return {
    revisedPrice: /15[,，]?500/.test(content),
    noDowntime: /不停机|不.{0,3}停机|零停机/.test(content),
    migrationNotApproved: /(?:未|不|没有)[^\n。；]{0,14}(?:批准|决定)[^\n。；]{0,14}迁移|迁移[^\n。；]{0,14}(?:未|不|没有)[^\n。；]{0,10}(?:批准|决定)/.test(content),
    purchaseNotApproved: /(?:未|不|没有|禁止)[^\n。；]{0,18}(?:采购|购买)|采购[^\n。；]{0,14}(?:未|不|没有)[^\n。；]{0,10}(?:批准|决定)/.test(content),
    deliveryUnknown: /交付[^\n。；]{0,40}(?:待|未|撤销|取消)|(?:待|未|撤销|取消)[^\n。；]{0,24}交付/.test(content),
    quoteOwnerAndDeadline: quote?.ownerHint === '赵军' && /10[-/月.]?16/.test(date(quote?.dueHint)),
    rehearsalUnassigned: Boolean(rehearsal) && rehearsal.ownerHint === null && rehearsal.dueHint === null,
    noInventedOwnerOrDeadline: minutes.todos.every(t => t.ownerHint === null || t.ownerHint === '赵军') && minutes.todos.every(t => t.dueHint === null || t.ownerHint === '赵军' && /10[-/月.]?16/.test(date(t.dueHint))),
    noRevokedCurrentDecision: !/(?:报价|价格)[^\n。；]{0,15}(?:确定为|调整为|批准为)\s*18[,，]?000|(?:决定|批准)[^\n。；]{0,10}停机\s*30/.test(decisions)
  }
}

async function main () {
  const options = argumentsFor(process.argv.slice(2))
  app.disableHardwareAcceleration()
  app.setPath('userData', options.userData)
  if (!app.requestSingleInstanceLock()) throw new Error('APPLICATION_ALREADY_RUNNING')
  const evidence = createMainEvidenceBridge()
  evidence.markLifecycle('main-started')
  await app.whenReady()
  evidence.markLifecycle('app-ready')
  const configPath = path.join(options.userData, 'config.json')
  const configHash = crypto.createHash('sha256').update(fs.readFileSync(configPath)).digest('hex')
  const config = new ConfigStore(configPath); config.load()
  const gateway = new StorageGateway({ databasePath: path.join(options.userData, 'data', 'speech-agent.sqlite3'), maxRestarts: 0 })
  let vault; let modelAccess; let scheduler; let operations; let currentRequestId
  const startedAt = Date.now()
  const report = { schemaVersion: 1, gates: ['SEM-F28', 'SEM-F38', 'SEM-F39', 'SEM-F40', 'J29', 'J30', 'J31'],
    result: false, cases: [], exchanges: [], current: null, elapsedMs: 0,
    newThinkingPresetCloudVerified: false }
  const write = () => {
    report.elapsedMs = Date.now() - startedAt
    fs.mkdirSync(path.dirname(options.report), { recursive: true })
    fs.writeFileSync(options.report, JSON.stringify(report, null, 2) + '\n')
  }
  write()
  try {
    await gateway.start()
    if (await gateway.nextFormalAgentRunAt({ requestedBy: 'user' }) !== null) throw new Error('UNRELATED_USER_WORK_PENDING')
    vault = new CredentialVault({ directory: path.join(options.userData, 'agent-model-credentials'), safeStorage })
    modelAccess = await new ModelAccessRuntime({ gateway, vault }).initialize()
    const exchange = modelAccess.adapter.exchange.bind(modelAccess.adapter)
    modelAccess.adapter.exchange = async request => {
      const result = await exchange(request)
      const payload = JSON.parse(request.request.messages.find(message => message.role === 'user').content).summaryPlan
      const stage = payload.stage
      let value = null; let valid = false
      try {
        value = JSON.parse(result.message.content)
        if (stage === 'organizing_topics') assertSummaryTopicIndex(value)
        else validateRecipeOutput('summary.minutes', '3', value)
        valid = true
      } catch {}
      const keys = stage === 'organizing_topics' ? ['schemaVersion', 'topics'] : ['schemaVersion', 'overview', 'topics', 'conclusions', 'todos', 'risks']
      report.exchanges.push({ stage, schemaValid: valid, resultBytes: Buffer.byteLength(result.message.content || ''),
        resultDigest: crypto.createHash('sha256').update(result.message.content || '').digest('hex'),
        schemaVersionValid: value?.schemaVersion === (stage === 'organizing_topics' ? 1 : 2),
        unknownRootFields: value ? Object.keys(value).filter(key => !keys.includes(key)).length : null,
        topicsArray: Array.isArray(value?.topics), topicCount: Array.isArray(value?.topics) ? value.topics.length : null,
        unknownTopicFields: Array.isArray(value?.topics) ? value.topics.reduce((sum, topic) => sum + Object.keys(topic || {}).filter(key => !(stage === 'organizing_topics' ? ['topicId', 'title', 'sourceRefs'] : ['topicId', 'title', 'text', 'sourceRefs']).includes(key)).length, 0) : null,
        sourceRefShapeValid: Array.isArray(value?.topics) ? value.topics.every(topic => Array.isArray(topic.sourceRefs) && topic.sourceRefs.every(ref => ref && Object.keys(ref).sort().join(',') === 'fromEventOrder,sessionId,throughEventOrder,transcriptVersion')) : null,
        sourceRefIdentityValid: Array.isArray(value?.topics) && payload.authorizedSourceRef ? value.topics.every(topic => Array.isArray(topic.sourceRefs) && topic.sourceRefs.every(ref => ref.sessionId === payload.authorizedSourceRef.sessionId && ref.transcriptVersion === 'raw')) : null,
        sourceRefRangeValid: Array.isArray(value?.topics) && payload.authorizedSourceRef ? value.topics.every(topic => Array.isArray(topic.sourceRefs) && topic.sourceRefs.every(ref => ref.fromEventOrder >= payload.authorizedSourceRef.fromEventOrder && ref.throughEventOrder <= payload.authorizedSourceRef.throughEventOrder)) : null,
        usage: result.usage })
      write()
      return result
    }
    const initialCatalog = await modelAccess.internal()
    const selectionHash = sha256Canonical(initialCatalog)
    const publicCatalog = await modelAccess.catalog()
    if (!publicCatalog.ok) throw new Error('CATALOG_UNAVAILABLE')
    // Selection is verified by the frozen binding before each execution below.
    const allowedRuns = new Set(); const prompts = new Map()
    const runner = new FormalAgentRunRunner({ storage: gateway,
      personalContext: createPersonalContextExecutionAdapter({ storage: gateway }), modelAccess,
      promptProvider: runId => prompts.get(runId), onProgress: (event, signal) => operations.recordProgress(event, signal),
      onChanged: event => { void operations.notifyRunChanged(event) }, interactions: {
        terminalize: (request, signal) => gateway.terminalizeAgentInteraction(request, signal),
        startToolCall: (request, signal) => gateway.startAgentToolCall(request, signal),
        finishToolCall: (request, signal) => gateway.finishAgentToolCall(request, signal)
      } })
    const createScheduler = () => new FormalAgentJobScheduler({ storage: gateway, requestedBy: 'user', owner: `qualification.${crypto.randomUUID()}`,
      runner: { run: job => {
        if (!allowedRuns.has(job.runId)) throw new Error('UNRELATED_RUN_REJECTED')
        return runner.run(job)
      } } })
    scheduler = createScheduler()
    const routeOrchestrator = new IntentRouteOrchestrator({
      runs: { create: request => gateway.createAgentRun(request), cancel: request => gateway.cancelAgentRun(request) }, modelAccess,
      interactions: { create: request => gateway.createAgentInteraction(request), terminalize: request => gateway.terminalizeAgentInteraction(request) },
      loopFactory: binding => new AgentLoopExecutor({ adapter: modelAccess.createLoopAdapter(binding) }), allowedTargetRecipes: ['summary.minutes'] })
    operations = new AgentOperationService({ storage: gateway, modelAccess, routeOrchestrator, scheduler, promptStore: prompts, getConfig: () => config.get() })
    // Accept while the scheduler is stopped, inspect the immutable binding,
    // then allow precisely that product run to make real cloud requests.
    const execute = async (sessionId, label, sampleIndex = null) => {
      if (scheduler.started) {
        await scheduler.stop()
        scheduler = createScheduler()
        operations.scheduler = scheduler
      }
      const caseStarted = Date.now()
      const accepted = await operations.accept({ contract_id: c.CONTRACT_ID, contract_version: c.CONTRACT_VERSION,
        action: 'summary', scope: { kind: 'session', reference: sessionId }, client_request_key: `qualification.${crypto.randomUUID()}` })
      if (!accepted.ok) throw new Error(accepted.error.code)
      currentRequestId = accepted.result.snapshot.request_id
      let row
      while (Date.now() - caseStarted < 30000) {
        row = await gateway.getSessionSummaryRequest({ requestId: currentRequestId })
        if (row.targetRunId || ['failed', 'cancelled'].includes(row.state)) break
        await new Promise(resolve => setTimeout(resolve, 25))
      }
      if (!row?.targetRunId) throw new Error(row?.errorCode || 'DISPATCH_DEADLINE')
      const binding = await modelAccess.bind({ runId: row.targetRunId, recipeId: 'summary.minutes', recipeVersion: '3', executionForm: 'agent_loop' })
      if (binding.httpsOrigin !== 'https://api.deepseek.com' || binding.requestStrategy !== 'deepseek-openai@1' || binding.modelId !== 'deepseek-v4-flash') {
        await operations.cancel({ contract_id: c.CONTRACT_ID, contract_version: c.CONTRACT_VERSION, request_id: currentRequestId, generation: row.generation })
        throw new Error('CURRENT_AUTHORIZED_BINDING_CHANGED')
      }
      allowedRuns.add(row.targetRunId)
      scheduler.start(); scheduler.wake('qualification')
      while (Date.now() - caseStarted < 65 * 60 * 1000) {
        row = await gateway.getSessionSummaryRequest({ requestId: currentRequestId })
        report.current = { case: label, state: row.state, stage: row.summaryStage || null, elapsedMs: Date.now() - caseStarted }
        write()
        if (['succeeded', 'failed', 'cancelled'].includes(row.state)) break
        await new Promise(resolve => setTimeout(resolve, 1000))
      }
      if (!['succeeded', 'failed', 'cancelled'].includes(row.state)) {
        await operations.cancel({ contract_id: c.CONTRACT_ID, contract_version: c.CONTRACT_VERSION, request_id: currentRequestId, generation: row.generation })
        throw new Error('QUALIFICATION_DEADLINE')
      }
      const detail = await gateway.getAgentInteraction({ interactionId: row.targetInteractionId })
      const exported = buildExportSnapshot(detail)
      const result = detail.interaction.result
      const facts = result && sampleIndex !== null ? qualityFacts(result, sampleIndex) : null
      report.cases.push({ case: label, result: row.state === 'succeeded' && (facts === null || Object.values(facts).every(Boolean)), state: row.state,
        errorCode: row.errorCode, outputValidation: row.outputValidation || null, inputDigest: exported.input_digest,
        resultDigest: result ? sha256Canonical(result) : null, resultBytes: result ? Buffer.byteLength(canonicalize(result)) : 0,
        topicCount: result?.topics.length || 0, sourceCount: exported.summary_input_plan?.segment_count || 0,
        quality: exported.summary_quality, execution: exported.summary_execution, usage: exported.usage,
        modelId: binding.modelId, requestStrategy: binding.requestStrategy, elapsedMs: Date.now() - caseStarted, facts })
      currentRequestId = null
      write()
      if (row.state !== 'succeeded') throw new Error(row.errorCode || 'PRODUCT_RUN_FAILED')
    }
    evidence.markLifecycle('bootstrap-complete')
    await execute(options.sessionId, 'original_failed_session')
    for (const [index, texts] of samples.entries()) {
      const sessionId = `session.summary.quality.synthetic.${index}.${crypto.randomUUID()}`
      const recorder = new SqliteSessionRecorder({ gateway })
      await recorder.openSession({ sessionId, sourceId: 'mic', refinementEnabled: false })
      for (const [order, text] of texts.entries()) await recorder.acceptCaption({ schemaVersion: 1, sessionId, sourceId: 'mic', segmentId: `segment.${order}`,
        sequence: order + 1, revision: 1, kind: 'final', t0: order, t1: order + 1, text, translation: null })
      await recorder.closeSession({ sessionId, sourceId: 'mic', state: 'closed' })
      await execute(sessionId, `synthetic_${index + 1}`, index)
    }
    const finalCatalog = await modelAccess.internal()
    report.modelSelectionUnchanged = selectionHash === sha256Canonical(finalCatalog)
    report.configUnchanged = configHash === crypto.createHash('sha256').update(fs.readFileSync(configPath)).digest('hex')
    report.result = report.cases.every(item => item.result) && report.modelSelectionUnchanged && report.configUnchanged
    report.current = null
    write()
  } catch (error) {
    report.failureCode = /^[A-Z_]{1,80}$/.test(error?.code || error?.message || '') ? (error.code || error.message) : 'QUALIFICATION_INTERNAL_FAILURE'
    write()
    if (currentRequestId && operations) {
      try {
        const row = await gateway.getSessionSummaryRequest({ requestId: currentRequestId })
        if (!['succeeded', 'failed', 'cancelled'].includes(row.state)) await operations.cancel({ contract_id: c.CONTRACT_ID, contract_version: c.CONTRACT_VERSION, request_id: currentRequestId, generation: row.generation })
      } catch {}
    }
  } finally {
    await scheduler?.stop()
    modelAccess?.close()
    vault?.close()
    await gateway.shutdown()
    evidence.markLifecycle('quit-requested')
    app.once('will-quit', () => evidence.markLifecycle('will-quit'))
    process.stdout.write(JSON.stringify({ cloudQualification: report.result, caseCount: report.cases.length, elapsedMs: report.elapsedMs, failureCode: report.failureCode || null }) + '\n')
    evidence.markLifecycle('will-quit')
    app.exit(report.result ? 0 : 1)
  }
}

main().catch(error => {
  process.stderr.write(JSON.stringify({ cloudQualification: false, failureCode: /^[A-Z_]{1,80}$/.test(error.message) ? error.message : 'QUALIFICATION_BOOTSTRAP_FAILED' }) + '\n')
  app.exit(1)
})

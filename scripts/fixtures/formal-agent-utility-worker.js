'use strict'

const { AgentUtilityService } = require('../../src/agent-runtime/agent-utility/service')
const { attachAgentUtilityWorker } = require('../../src/agent-runtime/agent-utility/worker-entry')

const PROVIDER_RESULT_MARKER = 'D14_AGENT_PROVIDER_RESULT\n'

function scenarioFromArguments (argv) {
  const indexes = argv.flatMap((value, index) => value === '--scenario' ? [index] : [])
  const index = indexes[0]
  if (indexes.length !== 1 || index + 1 >= argv.length ||
      !['exit-after-provider-result', 'happy'].includes(argv[index + 1])) {
    throw new Error('invalid fixture scenario')
  }
  return argv[index + 1]
}

function evidenceForSegments (segments) {
  return [{
    fromEventOrder: Math.min(...segments.map((segment) => segment.eventOrder)),
    throughEventOrder: Math.max(...segments.map((segment) => segment.eventOrder))
  }]
}

function deterministicResult (request) {
  const evidence = evidenceForSegments(request.input.segments)
  if (request.operation === 'meeting-minutes.chunk') {
    return {
      type: 'meeting-minutes',
      content: {
        overview: 'synthetic utility transport overview',
        conclusions: [],
        actionItems: [],
        risks: []
      }
    }
  }
  if (request.operation === 'memory-extraction.chunk') {
    return {
      type: 'memory-candidates',
      candidates: [{
        kind: 'decision',
        semanticKey: 'decision:formal-agent-utility',
        scope: {
          kind: 'session',
          canonicalKey: request.input.inputRef.sessionId,
          label: 'synthetic utility session'
        },
        origin: 'explicit',
        content: { statement: 'synthetic utility decision' },
        evidence,
        confidenceBand: 'high',
        salienceBand: 'high'
      }]
    }
  }
  if (request.operation === 'enhanced-transcript.chunk') {
    return {
      type: 'enhanced-transcript',
      content: {
        paragraphs: [{ text: 'synthetic enhanced utility transcript', evidence }]
      }
    }
  }
  throw new Error('unexpected fixture operation')
}

class DeterministicAgentProviderAdapter {
  constructor (scenario) {
    this.scenario = scenario
  }

  async openModel ({ request, credential }) {
    if (!Buffer.isBuffer(credential) || !credential.some((byte) => byte !== 0)) {
      throw new Error('credential unavailable')
    }
    const faux = await import('@earendil-works/pi-ai/providers/faux')
    const core = faux.createFauxCore({
      provider: 'deterministic-test',
      api: 'formal-agent-storage-utility-test',
      models: [{ id: 'deepseek-v4-flash' }]
    })
    core.setResponses([faux.fauxAssistantMessage(JSON.stringify(deterministicResult(request)))])
    const streamFn = (...args) => {
      const stream = core.streamSimple(...args)
      let finalResult = null
      return {
        [Symbol.asyncIterator]: () => stream[Symbol.asyncIterator](),
        result: () => {
          if (!finalResult) {
            finalResult = stream.result().then((message) => new Promise((resolve) => {
              process.stdout.write(PROVIDER_RESULT_MARKER, () => {
                if (this.scenario === 'exit-after-provider-result') process.exit(86)
                else resolve(message)
              })
            }))
          }
          return finalResult
        }
      }
    }
    return { model: core.getModel(), streamFn }
  }
}

const scenario = scenarioFromArguments(process.argv)
const adapter = new DeterministicAgentProviderAdapter(scenario)
attachAgentUtilityWorker({
  service: new AgentUtilityService({
    adapters: [{
      providerId: 'deepseek',
      providerKind: 'cloud',
      apiStyle: 'openai-chat-completions',
      openModel: (request) => adapter.openModel(request)
    }]
  })
})

module.exports = { PROVIDER_RESULT_MARKER }

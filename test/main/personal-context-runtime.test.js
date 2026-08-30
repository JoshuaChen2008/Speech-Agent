'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const { PersonalContextRuntime } = require('../../src/agent/personal-context/runtime')

function nextTurn () {
  return new Promise((resolve) => setImmediate(resolve))
}

test('SEM-F00/SEM-F28/SEM-F30/J21: runtime wires terminal notification to S1 reconciliation and removes it before stop', async () => {
  let listener = null
  let unsubscribed = false
  let claims = 0
  const gateway = {
    personalContextIngest: async () => ({}),
    personalContextResolve: async () => ({}),
    personalContextManage: async () => ({ revision: 0, totalCount: 0, rows: [] }),
    claimNextFormalAgentRun: async () => { claims += 1; return null },
    nextFormalAgentRunAt: async () => null,
    completeFormalAgentRun: async () => ({}),
    failFormalAgentRun: async () => ({})
  }
  const runtime = new PersonalContextRuntime({
    gateway,
    config: {
      get: () => ({
        agentEnabled: false, memoryEnabled: true, cloudDisclosureAccepted: false,
        memoryProcessingSince: null, agentSettingsRevision: 0
      }),
      updateAgentSettings: () => { throw new Error('not expected') }
    }
  })
  assert.equal(runtime.start({
    onTerminalCommitted: (callback) => {
      listener = callback
      return () => { unsubscribed = true; listener = null }
    }
  }), true)
  await nextTurn()
  const initialClaims = claims
  listener({ sessionId: 'session.terminal' })
  await nextTurn()
  assert.ok(claims > initialClaims)
  await runtime.stop()
  assert.equal(unsubscribed, true)
  assert.equal(listener, null)
})

test('SEM-F00/SEM-F30/J21: main stops Agent listeners and scheduler before subtitle gateway shutdown', () => {
  const source = fs.readFileSync(path.join(process.cwd(), 'src/main.js'), 'utf8')
  const agentStop = source.indexOf('await personalContextRuntime.stop()')
  const subtitleShutdown = source.indexOf('applicationRuntime.shutdownWithin', agentStop)
  assert.ok(agentStop > 0)
  assert.ok(subtitleShutdown > agentStop)
  assert.match(source, /catch \{\s*personalContextRuntime = null\s*console\.error\('\[agent\.runtime\] AGENT_CONTEXT_UNAVAILABLE'\)/)
})

'use strict'

const assert = require('node:assert/strict')
const path = require('node:path')
const test = require('node:test')

const { SubtitleApplicationRuntime } = require('../../src/main/services/subtitle-application-runtime')

const USER_DATA = path.resolve('.artifacts', 'application-runtime-test-user-data')

function gatewayFixture (log, overrides = {}) {
  return {
    async start () { log.push('gateway.start') },
    async recoverStaleSessions () {
      log.push('gateway.recover')
      return { status: 'none', recoveredSessionCount: 0 }
    },
    async importLegacyJsonl () {},
    async getSessionTranscript () {},
    async openSession () {},
    async appendCaption () {},
    async closeSession () {},
    async flush () { log.push('gateway.flush') },
    async retry () {},
    async shutdown () { log.push('gateway.shutdown') },
    async terminate () { log.push('gateway.terminate') },
    ...overrides
  }
}

function recorderFixture (log) {
  return {
    async openSession () {},
    acceptCaption () { return false },
    async closeSession () {},
    async retry () {},
    async flush () { log.push('recorder.flush') }
  }
}

test('startup failure terminates the one storage writer before rejecting', async () => {
  const log = []
  let coordinatorCreated = false
  const runtime = new SubtitleApplicationRuntime({
    userDataDir: USER_DATA,
    now: () => 1775000000000,
    gatewayFactory: () => gatewayFixture(log),
    migratorFactory: () => ({
      async migrateDirectory () {
        log.push('migration.fail')
        throw new Error('invalid legacy transcript')
      }
    }),
    recorderFactory: () => recorderFixture(log),
    coordinatorFactory: () => {
      coordinatorCreated = true
      return null
    }
  })

  await assert.rejects(runtime.start(), /invalid legacy transcript/)
  assert.deepEqual(log, [
    'gateway.start',
    'gateway.recover',
    'migration.fail',
    'gateway.terminate'
  ])
  assert.equal(coordinatorCreated, false)
  assert.equal(runtime.state, 'stopped')
})

test('bounded quit force-terminates storage and disposes a hung coordinator', async () => {
  const log = []
  const never = new Promise(() => {})
  const coordinator = {
    shutdownForAppQuit () {
      log.push('coordinator.shutdown')
      return never
    },
    async dispose () { log.push('coordinator.dispose') }
  }
  const runtime = new SubtitleApplicationRuntime({
    userDataDir: USER_DATA,
    now: () => 1775000000000,
    gatewayFactory: () => gatewayFixture(log),
    migratorFactory: () => ({
      async migrateDirectory () {
        log.push('migration.none')
        return []
      }
    }),
    recorderFactory: () => recorderFixture(log),
    coordinatorFactory: () => coordinator
  })
  await runtime.start()

  assert.deepEqual(await runtime.shutdownWithin(10), {
    graceful: false,
    reason: 'SHUTDOWN_TIMEOUT'
  })
  assert.deepEqual(log, [
    'gateway.start',
    'gateway.recover',
    'migration.none',
    'coordinator.shutdown',
    'gateway.terminate',
    'coordinator.dispose'
  ])
  assert.equal(runtime.state, 'stopped')
})

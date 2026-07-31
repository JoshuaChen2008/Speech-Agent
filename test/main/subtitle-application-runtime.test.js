'use strict'

const assert = require('node:assert/strict')
const path = require('node:path')
const test = require('node:test')

const {
  DEFAULT_SHUTDOWN_TIMEOUT_MS,
  SubtitleApplicationRuntime
} = require('../../src/main/services/subtitle-application-runtime')
const { RUNTIME_TRANSITION_TIMEOUT_MS } = require('../../src/main/services/model-runtime')
const {
  DEFAULT_FORCE_KILL_TIMEOUT_MS,
  DEFAULT_SHUTDOWN_TIMEOUT_MS: WORKER_SHUTDOWN_TIMEOUT_MS
} = require('../../src/runtime/realtime-worker/worker-host')

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

test('application quit budget covers model transition and both utility shutdown phases', () => {
  assert.ok(DEFAULT_SHUTDOWN_TIMEOUT_MS >= RUNTIME_TRANSITION_TIMEOUT_MS + DEFAULT_FORCE_KILL_TIMEOUT_MS)
  assert.ok(DEFAULT_SHUTDOWN_TIMEOUT_MS >= WORKER_SHUTDOWN_TIMEOUT_MS + DEFAULT_FORCE_KILL_TIMEOUT_MS)
})

test('startup failure terminates the one storage writer before rejecting', async () => {
  const log = []
  let coordinatorCreated = false
  let gatewayOptions = null
  const onStorageUtilityFatal = () => {}
  const runtime = new SubtitleApplicationRuntime({
    userDataDir: USER_DATA,
    now: () => 1775000000000,
    gatewayFactory: (options) => {
      gatewayOptions = options
      return gatewayFixture(log)
    },
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
    },
    onStorageUtilityFatal
  })

  await assert.rejects(runtime.start(), /invalid legacy transcript/)
  assert.deepEqual(log, [
    'gateway.start',
    'gateway.recover',
    'migration.fail',
    'gateway.terminate'
  ])
  assert.equal(coordinatorCreated, false)
  assert.equal(gatewayOptions.onFatalError, onStorageUtilityFatal)
  assert.equal(runtime.state, 'stopped')
})

test('forced quit during migration prevents late startup from reviving storage or coordinator', async () => {
  const log = []
  let releaseMigration
  let markMigrationEntered
  const migrationEntered = new Promise((resolve) => { markMigrationEntered = resolve })
  const migrationGate = new Promise((resolve) => { releaseMigration = resolve })
  let coordinatorCreated = false
  const runtime = new SubtitleApplicationRuntime({
    userDataDir: USER_DATA,
    now: () => 1775000000000,
    gatewayFactory: () => gatewayFixture(log),
    migratorFactory: () => ({
      async migrateDirectory () {
        log.push('migration.wait')
        markMigrationEntered()
        await migrationGate
        log.push('migration.released')
        return []
      }
    }),
    recorderFactory: () => recorderFixture(log),
    coordinatorFactory: () => {
      coordinatorCreated = true
      throw new Error('coordinator must not be created after termination')
    }
  })

  const starting = runtime.start()
  starting.catch(() => {})
  await migrationEntered
  assert.deepEqual(await runtime.shutdownWithin(5), {
    graceful: false,
    reason: 'SHUTDOWN_TIMEOUT'
  })
  assert.equal(runtime.state, 'stopped')
  assert.equal(runtime.terminationRequested, true)
  assert.equal(coordinatorCreated, false)
  assert.deepEqual(log, ['gateway.start', 'gateway.recover', 'migration.wait', 'gateway.terminate'])

  releaseMigration()
  await assert.rejects(starting, (error) => error.code === 'APPLICATION_START_ABORTED')
  await runtime.shutdownPromise
  assert.equal(runtime.state, 'stopped')
  assert.equal(runtime.coordinator, null)
  assert.equal(coordinatorCreated, false)
})

test('ordinary quit during migration cancels startup before recorder or coordinator creation', async () => {
  const log = []
  let releaseMigration
  let markMigrationEntered
  const migrationEntered = new Promise((resolve) => { markMigrationEntered = resolve })
  const migrationGate = new Promise((resolve) => { releaseMigration = resolve })
  let recorderCreated = false
  let coordinatorCreated = false
  const runtime = new SubtitleApplicationRuntime({
    userDataDir: USER_DATA,
    now: () => 1775000000000,
    gatewayFactory: () => gatewayFixture(log),
    migratorFactory: () => ({
      async migrateDirectory () {
        markMigrationEntered()
        await migrationGate
        return []
      }
    }),
    recorderFactory: () => {
      recorderCreated = true
      return recorderFixture(log)
    },
    coordinatorFactory: () => {
      coordinatorCreated = true
      throw new Error('coordinator must not be created after quit')
    }
  })

  const starting = runtime.start()
  starting.catch(() => {})
  await migrationEntered
  const shutdown = runtime.shutdown()
  assert.equal(runtime.terminationRequested, true)
  assert.equal(recorderCreated, false)
  assert.equal(coordinatorCreated, false)

  releaseMigration()
  await assert.rejects(starting, (error) => error.code === 'APPLICATION_START_ABORTED')
  await shutdown

  assert.equal(runtime.state, 'stopped')
  assert.equal(recorderCreated, false)
  assert.equal(coordinatorCreated, false)
  assert.deepEqual(log, ['gateway.start', 'gateway.recover', 'gateway.terminate'])
})

test('exact-child termination failure keeps the application runtime fail-closed in stopping', async () => {
  const terminationError = new Error('storage worker exact exit is still pending')
  terminationError.code = 'TERMINATION_TIMEOUT'
  const runtime = new SubtitleApplicationRuntime({
    userDataDir: USER_DATA,
    now: () => 1775000000000,
    gatewayFactory: () => gatewayFixture([], {
      async terminate () { throw terminationError }
    }),
    migratorFactory: () => ({ async migrateDirectory () { return [] } }),
    recorderFactory: () => recorderFixture([]),
    coordinatorFactory: () => ({
      async shutdownForAppQuit () { throw new Error('graceful coordinator shutdown failed') },
      async dispose () {}
    })
  })
  await runtime.start()

  await assert.rejects(runtime.shutdownWithin(20), (error) => error === terminationError)
  assert.equal(runtime.state, 'stopping')
  assert.equal(runtime.terminationRequested, true)
  assert.strictEqual(runtime.terminationPromise, runtime.terminate())
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

test('late graceful shutdown joins the one forced termination without duplicate storage shutdown', async () => {
  const log = []
  let releaseCoordinator
  const coordinatorGate = new Promise((resolve) => { releaseCoordinator = resolve })
  const coordinator = {
    async shutdownForAppQuit () {
      log.push('coordinator.shutdown')
      await coordinatorGate
    },
    async dispose () { log.push('coordinator.dispose') }
  }
  const runtime = new SubtitleApplicationRuntime({
    userDataDir: USER_DATA,
    now: () => 1775000000000,
    gatewayFactory: () => gatewayFixture(log),
    migratorFactory: () => ({
      async migrateDirectory () { return [] }
    }),
    recorderFactory: () => recorderFixture(log),
    coordinatorFactory: () => coordinator
  })
  await runtime.start()

  assert.deepEqual(await runtime.shutdownWithin(5), {
    graceful: false,
    reason: 'SHUTDOWN_TIMEOUT'
  })
  releaseCoordinator()
  await runtime.shutdownPromise

  assert.equal(log.filter((entry) => entry === 'coordinator.dispose').length, 1)
  assert.equal(log.filter((entry) => entry === 'gateway.terminate').length, 1)
  assert.equal(log.filter((entry) => entry === 'recorder.flush').length, 0)
  assert.equal(log.filter((entry) => entry === 'gateway.shutdown').length, 0)
  assert.equal(runtime.state, 'stopped')
})

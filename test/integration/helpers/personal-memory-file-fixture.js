'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { StorageWorkerService } = require('../../../src/runtime/storage-worker/worker-service')
const { StorageWorkerHost } = require('../../../src/runtime/storage-worker/worker-host')
const { StorageGateway } = require('../../../src/main/services/storage-gateway')
const { PersonalMemoryFileRuntime } = require('../../../src/agent/personal-context/memory-file-runtime')
const { EmbeddingAccessRuntime } = require('../../../src/agent/model-access/embedding-access')
const { CredentialVault } = require('../../../src/agent/model-access/credential-vault')
const { OPERATIONS, PROTOCOL_VERSION, StorageError } = require('../../../src/runtime/storage-worker/protocol')

async function fixture (t, { fetchImpl, safeStorage, settings = {} } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-files-journey-'))
  const databasePath = path.join(directory, 'memory.sqlite3')
  const service = new StorageWorkerService(); let sequence = 0
  // The product host's operation/payload mapping remains intact. Only IPC
  // delivery is synchronous here; the SQLite service, gateway and file actor
  // are real. The separate Electron journey exercises utility-process IPC.
  const host = Object.create(StorageWorkerHost.prototype)
  host.state = 'stopped'
  host.tail = Promise.resolve()
  host.child = { transport: 'in-process' }
  host.perform = async (operation, payload, idempotencyKey) => {
    const result = await service.handle({ version: PROTOCOL_VERSION, type: 'storage:request', requestId: `files.${++sequence}`, operation, payload, ...(idempotencyKey ? { idempotencyKey } : {}) })
    if (!result.ok) { const e = new StorageError(result.error.code); e.message = `${operation}: ${result.error.code}`; throw e }
    return result.result
  }
  host.start = async () => { await host.perform(OPERATIONS.INITIALIZE, { databasePath }); host.state = 'ready' }
  host.shutdown = async () => { await host.perform(OPERATIONS.SHUTDOWN, {}); host.state = 'closed' }
  host.terminateAndWait = async () => { await host.shutdown(); return 0 }
  const gateway = new StorageGateway({ databasePath, hostFactory: () => host, maxRestarts: 0 })
  await gateway.start()
  const config = { agentEnabled: true, memoryEnabled: true, ...settings }
  const vault = new CredentialVault({ directory: path.join(directory, 'credentials'), safeStorage: safeStorage || { isEncryptionAvailable: () => false } })
  const embeddingAccess = await new EmbeddingAccessRuntime({ gateway, vault, fetchImpl }).initialize()
  const modelAccess = { embeddingAccess, bind: v => embeddingAccess.bind(v) }
  const runtime = new PersonalMemoryFileRuntime({ gateway, directory: path.join(directory, 'private'), getConfig: () => config, modelAccess })
  t.after(async () => { await runtime.close(); embeddingAccess.close(); await gateway.shutdown(); fs.rmSync(directory, { recursive: true, force: true }) })
  await runtime.initialize()
  const revision = async () => (await gateway.personalMemoryFiles({ type: 'manifest' })).revision
  const remember = async (text, kind = 'project_fact') => gateway.personalContextManage({ type: 'remember', expected_revision: await revision(), entry: { display_text: text, kind, scope: { kind: 'global', reference: null } } })
  const resolve = async query => gateway.personalContextResolve({ schemaVersion: 2, scope: { kind: 'global', reference: null }, query, semantic_keys: [], aliases: [] })
  return { directory, service, gateway, runtime, config, embeddingAccess, modelAccess, revision, remember, resolve }
}
async function configureEmbedding (f) {
  const change = async command => f.embeddingAccess.configure({ ...command, expectedRevision: (await f.embeddingAccess.catalog()).revision })
  await change({ type: 'configureEmbedding', httpsOrigin: 'https://embedding.example', basePath: '/v1', modelId: 'synthetic-vector', enabled: true, disclosureAccepted: true })
  await change({ type: 'setEmbeddingCredential', credential: 'synthetic-independent-key' })
}
module.exports = { fixture, configureEmbedding }

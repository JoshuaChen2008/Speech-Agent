'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const {
  RefinementFaultLog
} = require('../../src/main/services/refinement-fault-log')

function temporaryDirectory (t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'speech-agent-refinement-log-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return directory
}

test('fault log writes only the frozen non-content schema', async (t) => {
  const directory = temporaryDirectory(t)
  const logger = new RefinementFaultLog({ directory, now: () => 1_785_650_000_000 })

  await logger.record({
    code: 'REFINE_DECODE_FAILED',
    stage: 'decode',
    faultAtMs: 321
  })

  const files = fs.readdirSync(directory)
  assert.equal(files.length, 1)
  const content = fs.readFileSync(path.join(directory, files[0]), 'utf8')
  assert.deepEqual(JSON.parse(content.trim()), {
    schemaVersion: 1,
    type: 'refinement-fault',
    code: 'REFINE_DECODE_FAILED',
    stage: 'decode',
    faultAtMs: 321,
    count: 1
  })
  assert.doesNotMatch(content, /session|caption|text|audio|path|stack|error/i)

  await assert.rejects(
    logger.record({
      code: 'REFINE_DECODE_FAILED',
      stage: 'decode',
      faultAtMs: 321,
      error: new Error('must never be serialized')
    }),
    /exactly code, stage and faultAtMs/
  )
  await logger.close()
})

test('fault log enforces age, file-count, and per-file byte bounds', async (t) => {
  const directory = temporaryDirectory(t)
  let now = 10_000
  const logger = new RefinementFaultLog({
    directory,
    now: () => now,
    maxBytes: 210,
    maxFiles: 2,
    maxAgeMs: 1_000
  })

  const old = path.join(directory, 'refinement-fault-1-0.jsonl')
  fs.writeFileSync(old, '{"old":true}\n')
  fs.utimesSync(old, new Date(1_000), new Date(1_000))

  for (let index = 0; index < 8; index += 1) {
    now += 10
    await logger.record({
      code: index % 2 === 0 ? 'REFINE_WORKER_EXITED' : 'REFINE_INTERNAL_FAILURE',
      stage: index % 2 === 0 ? 'exit' : 'worker-channel',
      faultAtMs: index
    })
  }
  await logger.close()

  const files = fs.readdirSync(directory)
    .filter((name) => name.startsWith('refinement-fault-'))
  assert.ok(files.length <= 2)
  assert.equal(files.includes(path.basename(old)), false)
  for (const file of files) {
    assert.ok(fs.statSync(path.join(directory, file)).size <= 210)
  }
})

test('fault log rejects unknown codes, unsafe stages, absolute timestamps, and extra fields', async (t) => {
  const logger = new RefinementFaultLog({ directory: temporaryDirectory(t) })

  await assert.rejects(
    logger.record({ code: 'OTHER', stage: 'decode', faultAtMs: 1 }),
    /fault code/
  )
  await assert.rejects(
    logger.record({ code: 'REFINE_DECODE_FAILED', stage: 'C:\\private', faultAtMs: 1 }),
    /fault stage/
  )
  await assert.rejects(
    logger.record({ code: 'REFINE_DECODE_FAILED', stage: 'decode', faultAtMs: Date.now() }),
    /relative fault time/
  )
})

test('close drains records accepted before shutdown and rejects later records', async (t) => {
  const directory = temporaryDirectory(t)
  const logger = new RefinementFaultLog({ directory, now: () => 1_785_650_000_000 })
  const pending = logger.record({
    code: 'REFINE_WORKER_EXITED',
    stage: 'worker-exit',
    faultAtMs: 42
  })

  await logger.close()
  await pending

  const content = fs.readdirSync(directory)
    .map((name) => fs.readFileSync(path.join(directory, name), 'utf8'))
    .join('')
  assert.match(content, /REFINE_WORKER_EXITED/)
  await assert.rejects(
    logger.record({ code: 'REFINE_WORKER_EXITED', stage: 'worker-exit', faultAtMs: 43 }),
    /closed/
  )
})

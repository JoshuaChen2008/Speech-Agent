'use strict'

// @ts-check

/* Privacy-bounded refinement diagnostics. This is deliberately not a general
   application logger: the input schema cannot carry a session id, transcript,
   path, raw Error or stack, and this module has no upload/export capability. */

const fs = require('node:fs/promises')
const path = require('node:path')

const MAX_FILES = 5
const MAX_BYTES = 1024 * 1024
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
const FILE_PATTERN = /^refinement-fault-(\d+)-(\d+)\.jsonl$/
const FAULT_CODES = new Set([
  'REFINE_WORKER_START_FAILED',
  'REFINE_WORKER_EXITED',
  'REFINE_DECODE_FAILED',
  'REFINE_INVALID_RESPONSE',
  'REFINE_INTERNAL_FAILURE'
])

function positiveInteger (value, fallback, label) {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${label} must be a positive integer`)
  return value
}

function validateFault (input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).sort().join(',') !== 'code,faultAtMs,stage') {
    throw new TypeError('fault input must contain exactly code, stage and faultAtMs')
  }
  if (!FAULT_CODES.has(input.code)) throw new TypeError('refinement fault code is invalid')
  if (typeof input.stage !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(input.stage)) {
    throw new TypeError('refinement fault stage is invalid')
  }
  /* A wall-clock epoch accidentally passed here would violate the diagnostic
     schema. Seven days is already well beyond the supported session horizon. */
  if (!Number.isSafeInteger(input.faultAtMs) || input.faultAtMs < 0 || input.faultAtMs > MAX_AGE_MS) {
    throw new TypeError('session-relative fault time is invalid')
  }
  return {
    schemaVersion: 1,
    type: 'refinement-fault',
    code: input.code,
    stage: input.stage,
    faultAtMs: input.faultAtMs,
    count: 1
  }
}

class RefinementFaultLog {
  constructor (options = {}) {
    if (typeof options.directory !== 'string' || !path.isAbsolute(options.directory)) {
      throw new TypeError('refinement fault log directory must be absolute')
    }
    if (options.now !== undefined && typeof options.now !== 'function') {
      throw new TypeError('refinement fault log clock must be a function')
    }
    this.directory = path.resolve(options.directory)
    this.now = options.now || (() => Date.now())
    this.maxFiles = positiveInteger(options.maxFiles, MAX_FILES, 'maxFiles')
    this.maxBytes = positiveInteger(options.maxBytes, MAX_BYTES, 'maxBytes')
    this.maxAgeMs = positiveInteger(options.maxAgeMs, MAX_AGE_MS, 'maxAgeMs')
    this.sequence = 0
    this.initialized = false
    this.closed = false
    this.tail = Promise.resolve()
  }

  record (input) {
    if (this.closed) return Promise.reject(new Error('refinement fault log is closed'))
    let entry
    try {
      entry = validateFault(input)
    } catch (error) {
      return Promise.reject(error)
    }
    const task = this.tail.then(async () => {
      await this.initialize()
      let files = await this.cleanup()
      const line = `${JSON.stringify(entry)}\n`
      const bytes = Buffer.byteLength(line)
      if (bytes > this.maxBytes) throw new Error('refinement fault entry exceeds file limit')

      let target = files.at(-1)
      if (!target || target.size + bytes > this.maxBytes) {
        target = await this.createTarget()
      }
      await fs.appendFile(target.path, line, { encoding: 'utf8', flag: 'a' })
      await this.cleanup()
    })
    this.tail = task.catch(() => {})
    return task
  }

  async initialize () {
    if (this.initialized) return
    await fs.mkdir(this.directory, { recursive: true })
    this.initialized = true
  }

  async listFiles () {
    let entries
    try {
      entries = await fs.readdir(this.directory, { withFileTypes: true })
    } catch (error) {
      if (error?.code === 'ENOENT') return []
      throw error
    }
    const files = []
    for (const entry of entries) {
      if (!entry.isFile() || !FILE_PATTERN.test(entry.name)) continue
      const filePath = path.join(this.directory, entry.name)
      const stat = await fs.stat(filePath)
      const match = entry.name.match(FILE_PATTERN)
      files.push({
        name: entry.name,
        path: filePath,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        createdAtMs: Number(match[1]),
        sequence: Number(match[2])
      })
    }
    files.sort((left, right) =>
      left.mtimeMs - right.mtimeMs ||
      left.createdAtMs - right.createdAtMs ||
      left.sequence - right.sequence
    )
    return files
  }

  async cleanup () {
    const now = this.now()
    if (!Number.isSafeInteger(now) || now < 0) throw new TypeError('refinement fault log clock is invalid')
    let files = await this.listFiles()
    const expired = files.filter((file) => file.mtimeMs < now - this.maxAgeMs)
    await Promise.all(expired.map((file) => fs.unlink(file.path)))
    if (expired.length > 0) files = await this.listFiles()
    while (files.length > this.maxFiles) {
      const oldest = files.shift()
      await fs.unlink(oldest.path)
    }
    return files
  }

  async createTarget () {
    const now = this.now()
    for (;;) {
      const name = `refinement-fault-${now}-${this.sequence++}.jsonl`
      const target = path.join(this.directory, name)
      try {
        const handle = await fs.open(target, 'wx')
        await handle.close()
        return { name, path: target, size: 0, mtimeMs: now }
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error
      }
    }
  }

  async close () {
    this.closed = true
    await this.tail
  }
}

module.exports = {
  FAULT_CODES,
  MAX_AGE_MS,
  MAX_BYTES,
  MAX_FILES,
  RefinementFaultLog
}

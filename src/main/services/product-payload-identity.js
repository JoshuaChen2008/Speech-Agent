'use strict'

// @ts-check

/* Canonical identity for the complete runtime source payload inside app.asar.
   The smoke and release packages have different main entries, but both carry
   the same executable src/ tree. Electron Builder excludes build-only .d.ts
   declarations, so the workspace collector mirrors that boundary. */

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const IDENTITY_VERSION = 'live-subtitle-product-payload-v1'

function normalizeEntryName (value) {
  if (typeof value !== 'string') throw new TypeError('product payload entry name must be a string')
  const normalized = value.replace(/\\/g, '/').replace(/^\/+/, '')
  if (!normalized.startsWith('src/') || normalized.includes('/../') || normalized.endsWith('/..')) {
    throw new TypeError('product payload entry must remain under src')
  }
  return normalized
}

function hashProductPayloadEntries (entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new TypeError('product payload entries are required')
  }
  const normalized = entries.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new TypeError('product payload entry must be an object')
    }
    const name = normalizeEntryName(entry.name)
    const bytes = Buffer.isBuffer(entry.bytes) ? entry.bytes : Buffer.from(entry.bytes || [])
    return { name, bytes }
  }).sort((left, right) => left.name.localeCompare(right.name, 'en'))
  if (new Set(normalized.map((entry) => entry.name)).size !== normalized.length) {
    throw new TypeError('product payload entries must have unique names')
  }
  const digest = crypto.createHash('sha256')
  digest.update(`${IDENTITY_VERSION}\0`, 'utf8')
  for (const entry of normalized) {
    digest.update(entry.name, 'utf8')
    digest.update('\0', 'utf8')
    digest.update(String(entry.bytes.length), 'ascii')
    digest.update('\0', 'utf8')
    digest.update(entry.bytes)
    digest.update('\0', 'utf8')
  }
  return Object.freeze({
    version: IDENTITY_VERSION,
    fileCount: normalized.length,
    sha256: digest.digest('hex')
  })
}

function collectProductPayloadEntries (root) {
  const resolvedRoot = path.resolve(root)
  const entries = []
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name)
      if (entry.isSymbolicLink()) throw new Error('product payload cannot contain symbolic links')
      if (entry.isDirectory()) {
        visit(target)
      } else if (entry.isFile()) {
        const relative = path.relative(resolvedRoot, target).replace(/\\/g, '/')
        if (relative.endsWith('.d.ts')) continue
        entries.push({ name: `src/${relative}`, bytes: fs.readFileSync(target) })
      } else {
        throw new Error('product payload contains an unsupported filesystem entry')
      }
    }
  }
  visit(resolvedRoot)
  return entries
}

function computeProductPayloadIdentity (root = path.resolve(__dirname, '..', '..')) {
  return hashProductPayloadEntries(collectProductPayloadEntries(root))
}

module.exports = {
  IDENTITY_VERSION,
  collectProductPayloadEntries,
  computeProductPayloadIdentity,
  hashProductPayloadEntries
}

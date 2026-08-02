'use strict'

const fs = require('node:fs')
const path = require('node:path')

const DEFAULT_PROJECT_ROOT = path.resolve(__dirname, '..', '..')

/**
 * Transcript-bearing Gate 0B intermediates are permitted only below the
 * repository's fixed, git-ignored private directory. This is an accidental
 * disclosure guard, not a general-purpose path sandbox.
 */
function resolvePrivateTranscriptOutputPath (input, projectRoot = DEFAULT_PROJECT_ROOT) {
  if (typeof input !== 'string' || input.trim().length === 0) {
    throw new TypeError('private transcript output must be a non-empty path')
  }
  const privateRoot = path.resolve(projectRoot, 'models', 'gate-0b', 'private')
  const resolved = path.resolve(input)
  const relative = path.relative(privateRoot, resolved)
  const outside = relative.length === 0 || path.isAbsolute(relative) ||
    relative === '..' || relative.startsWith(`..${path.sep}`)
  if (outside) {
    throw new Error('private transcript output must stay under models/gate-0b/private')
  }
  if (path.extname(resolved).toLowerCase() !== '.json') {
    throw new Error('private transcript output must use a .json file')
  }

  /* A lexical allowlist is insufficient when an existing child is a symlink
     or Windows junction into a tracked directory. Inspect every existing path
     component before the caller creates parents or opens the file. */
  const root = path.resolve(projectRoot)
  const components = path.relative(root, resolved).split(path.sep).filter(Boolean)
  let cursor = root
  for (const component of components) {
    cursor = path.join(cursor, component)
    try {
      if (fs.lstatSync(cursor).isSymbolicLink()) {
        throw new Error('private transcript output must not traverse a symbolic link, junction or reparse point')
      }
    } catch (error) {
      if (error?.code === 'ENOENT') break
      throw error
    }
  }
  return resolved
}

module.exports = { resolvePrivateTranscriptOutputPath }

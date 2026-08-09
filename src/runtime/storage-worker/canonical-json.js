'use strict'

const crypto = require('node:crypto')

/* RFC 8785/JCS 所需的确定性 JSON 子集。只接受 JSON 可表达的普通对象，
   从而让输入、任务和产物身份不会因属性插入顺序而变化。 */
function canonicalize (value, stack = new Set()) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('canonical JSON only accepts finite numbers')
    return JSON.stringify(value)
  }
  if (typeof value !== 'object') throw new TypeError('value is not JSON serializable')
  if (stack.has(value)) throw new TypeError('canonical JSON rejects cycles')
  stack.add(value)
  try {
    if (Array.isArray(value)) {
      if (Object.keys(value).length !== value.length ||
          Object.keys(value).some((key) => !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length)) {
        throw new TypeError('canonical JSON rejects sparse or decorated arrays')
      }
      return `[${value.map((item) => canonicalize(item, stack)).join(',')}]`
    }
    if (Object.getPrototypeOf(value) !== Object.prototype) throw new TypeError('canonical JSON accepts plain objects only')
    const entries = Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key], stack)}`)
    return `{${entries.join(',')}}`
  } finally {
    stack.delete(value)
  }
}

function sha256Canonical (value) {
  return crypto.createHash('sha256').update(Buffer.from(canonicalize(value), 'utf8')).digest('hex')
}

module.exports = { canonicalize, sha256Canonical }

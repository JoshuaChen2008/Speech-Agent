'use strict'

// These values are runtime boundaries used to decide which sources may be
// automatically processed. They are main-owned facts and must never cross the
// generic config IPC boundary into renderer windows.
const PRIVATE_CONFIG_KEYS = new Set([
  'automaticProcessingSince',
  'memoryProcessingSince'
])

function publicConfigPayload (value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const result = {}
  for (const [key, entry] of Object.entries(value)) {
    if (!PRIVATE_CONFIG_KEYS.has(key)) result[key] = entry
  }
  return result
}

module.exports = { publicConfigPayload }

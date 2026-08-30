'use strict'

function sanitizedEnvironment (environment) {
  if (!environment || typeof environment !== 'object') throw new TypeError('environment is required')
  const result = {}
  for (const [key, value] of Object.entries(environment)) {
    if (key.toUpperCase() === 'DEEPSEEK_API_KEY') continue
    if (typeof value === 'string') result[key] = value
  }
  return Object.freeze(result)
}

module.exports = { sanitizedEnvironment }

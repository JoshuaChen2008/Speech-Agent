'use strict'

function createSystemModelFetch (net) {
  return async (input, init) => {
    try {
      // Preserve API-key-only authentication when moving to the default
      // Chromium session; do not borrow its ambient cookies or credentials.
      return await net.fetch(input, { ...init, credentials: 'omit' })
    } catch (error) {
      // Electron's manual-redirect implementation rejects instead of exposing
      // a 3xx Response. Keep that refusal distinct from transient I/O failures.
      if (init?.redirect === 'manual' && error?.message === 'Redirect was cancelled') {
        throw Object.assign(new Error('REDIRECT_REJECTED'), { code: 'REDIRECT_REJECTED' })
      }
      throw error
    }
  }
}

module.exports = { createSystemModelFetch }

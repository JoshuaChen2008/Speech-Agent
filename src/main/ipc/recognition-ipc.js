'use strict'

const CHANNELS = require('./channels')
const { PUBLIC_CODES, assertUpdateRequest, assertResponse } = require('../../contracts/recognition-settings')

function registerRecognitionIpc ({ ipcMain, authorize, getSettings }) {
  for (const [channel, operation] of [[CHANNELS.RECOGNITION_GET, 'getPublic'],
    [CHANNELS.RECOGNITION_UPDATE, 'update'], [CHANNELS.RECOGNITION_VERIFY, 'verifyCredentials']]) {
    ipcMain.handle(channel, async (event, request) => {
      try { authorize(event, channel) } catch { return { ok: false, code: 'PERMISSION_DENIED' } }
      try {
        const settings = getSettings()
        if (!settings) return { ok: false, code: 'NLS_SETTINGS_UNAVAILABLE' }
        if (operation !== 'update' && request !== undefined) throw Object.assign(new Error(), { code: 'NLS_INVALID_SETTINGS' })
        if (operation === 'update') assertUpdateRequest(request)
        const value = await settings[operation](request)
        return assertResponse({ ok: true, value }, operation === 'verifyCredentials')
      } catch (error) {
        return { ok: false, code: PUBLIC_CODES.includes(error?.code) ? error.code : 'NLS_SETTINGS_UNAVAILABLE' }
      }
    })
  }
}

module.exports = { registerRecognitionIpc }

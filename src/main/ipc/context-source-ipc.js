'use strict'

const CHANNELS = require('./channels')
const { assertSourceTarget } = require('../../agent/contracts/agent-context-ui')

function registerContextSourceIpc ({ ipcMain, authorize, getStorage, openSource, returnSource }) {
  ipcMain.handle(CHANNELS.AGENT_CONTEXT_OPEN_SOURCE, async (event, target) => {
    try {
      authorize(event, CHANNELS.AGENT_CONTEXT_OPEN_SOURCE)
      assertSourceTarget(target)
      const location = await getStorage().personalContextManage({ type: 'source', target })
      const opened = await openSource(location, event.sender)
      return opened === false ? { ok: false, code: 'AGENT_CONTEXT_OPERATION_FAILED' } : { ok: true, code: null }
    } catch (error) {
      return { ok: false, code: error?.code === 'AGENT_CONTEXT_NOT_FOUND' ? 'AGENT_CONTEXT_NOT_FOUND' : 'AGENT_CONTEXT_OPERATION_FAILED' }
    }
  })
  ipcMain.handle(CHANNELS.AGENT_CONTEXT_RETURN_SOURCE, async (event) => {
    try { authorize(event, CHANNELS.AGENT_CONTEXT_RETURN_SOURCE); return { ok: await returnSource(event.sender) !== false } } catch { return { ok: false } }
  })
}

module.exports = { registerContextSourceIpc }

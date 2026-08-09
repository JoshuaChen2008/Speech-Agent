'use strict'

const { contextBridge, ipcRenderer } = require('electron')

async function invoke (channel, payload) {
  const result = await ipcRenderer.invoke(channel, payload)
  if (!result?.ok) { const error = new Error(result?.error?.code || 'AGENT_INTERNAL_FAILURE'); error.code = result?.error?.code || 'AGENT_INTERNAL_FAILURE'; throw error }
  return result.result
}

function subscribe (channel, callback) {
  if (typeof callback !== 'function') throw new TypeError('callback is required')
  const listener = (_event, value) => callback(value)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

contextBridge.exposeInMainWorld('agentMvp', Object.freeze({
  getState: () => invoke('agent-mvp:get-state', {}),
  saveProvider: (value) => invoke('agent-mvp:save-provider', value),
  createFixture: (sourceId) => invoke('agent-mvp:create-fixture', { sourceId }),
  messages: (sessionId) => invoke('agent-mvp:messages', { sessionId }),
  chat: (sessionId, prompt) => invoke('agent-mvp:chat', { sessionId, prompt }),
  preview: (sessionId) => invoke('agent-mvp:preview', { sessionId }),
  confirm: (previewId, decision) => invoke('agent-mvp:confirm', { previewId, decision }),
  cancel: (runId) => invoke('agent-mvp:cancel', { runId }),
  onState: (callback) => subscribe('agent-mvp:state', callback),
  onEvent: (callback) => subscribe('agent-mvp:event', callback)
}))

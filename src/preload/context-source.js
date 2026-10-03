'use strict'

const CHANNELS = require('../main/ipc/channels')
const { assertSourceTarget } = require('../agent/contracts/agent-context-ui')
const { scope: assertScope } = require('../agent/contracts/agent-run-ui')

function createContextSourceBridge (ipcRenderer) {
  const listeners = new Set()
  let pending = null
  ipcRenderer.on(CHANNELS.AGENT_CONTEXT_SOURCE_REQUESTED, (_event, location) => {
    try {
      assertSourceTarget(location.target)
      assertScope(location.scope)
      if (!Number.isSafeInteger(location.offset) || location.offset < 0) return
      if (location.highlightedSegmentIds !== undefined && (!Array.isArray(location.highlightedSegmentIds) ||
        location.highlightedSegmentIds.length > 50 || new Set(location.highlightedSegmentIds).size !== location.highlightedSegmentIds.length ||
        location.highlightedSegmentIds.some(id => typeof id !== 'string' || id.length < 1 || id.length > 160))) return
      if (location.target.kind === 'session' && (location.scope.kind !== 'session' || location.scope.reference !== location.target.reference)) return
      if (location.cursor !== null && (!location.cursor || Object.keys(location.cursor).sort().join(',') !== 'firstEventOrder,t0Ms' ||
        !Number.isSafeInteger(location.cursor.t0Ms) || location.cursor.t0Ms < 0 || !Number.isSafeInteger(location.cursor.firstEventOrder) || location.cursor.firstEventOrder < 1)) return
    } catch { return }
    if (listeners.size === 0) pending = location
    else for (const listener of listeners) listener(location)
  })

  return {
    openAgentContextSource: (target) => { assertSourceTarget(target); return ipcRenderer.invoke(CHANNELS.AGENT_CONTEXT_OPEN_SOURCE, target) },
    returnToAgentContext: () => ipcRenderer.invoke(CHANNELS.AGENT_CONTEXT_RETURN_SOURCE),
    onAgentContextSourceRequested: (listener) => {
      if (typeof listener !== 'function') throw new TypeError('callback must be a function')
      listeners.add(listener)
      if (pending) { const location = pending; pending = null; queueMicrotask(() => { if (listeners.has(listener)) listener(location) }) }
      return () => listeners.delete(listener)
    }
  }
}

module.exports = { createContextSourceBridge }

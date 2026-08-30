'use strict'

const { contextBridge } = require('electron')
const CHANNELS = require('../main/ipc/channels')
const { createWindowInteractionBridge, ipcRenderer, subscribe } = require('./shared')
const interaction = createWindowInteractionBridge('history')
const {
  assertChangedEvent,
  assertGetOverviewRequest,
  assertGetOverviewResponse,
  assertManageRequest,
  assertManageResponse
} = require('../agent/contracts/agent-context-ui')

function onAgentContextChanged (callback) {
  if (typeof callback !== 'function') throw new TypeError('callback must be a function')
  const handler = (_event, value) => {
    try { callback(assertChangedEvent(value)) } catch { /* invalid events are dropped whole */ }
  }
  ipcRenderer.on(CHANNELS.AGENT_CONTEXT_CHANGED, handler)
  return () => ipcRenderer.removeListener(CHANNELS.AGENT_CONTEXT_CHANGED, handler)
}

contextBridge.exposeInMainWorld('historyApi', {
  dragStart: interaction.dragStart,
  dragEnd: interaction.dragEnd,
  onInteractionSync: interaction.onInteractionSync,
  close: () => ipcRenderer.send(CHANNELS.HISTORY_CLOSE),
  getConfig: () => ipcRenderer.invoke(CHANNELS.CONFIG_GET),
  onConfig: (callback) => subscribe(CHANNELS.CONFIG_CHANGED, callback),
  listSessions: (limit, cursor) => ipcRenderer.invoke(CHANNELS.HISTORY_LIST, {
    limit: Number(limit),
    cursor: cursor === null ? null : {
      startedAt: Number(cursor?.startedAt),
      sessionId: String(cursor?.sessionId || '')
    }
  }),
  getSessionPage: (sessionId, limit, cursor) => ipcRenderer.invoke(CHANNELS.HISTORY_PAGE, {
    sessionId: String(sessionId || ''),
    limit: Number(limit),
    cursor: cursor === null ? null : {
      t0Ms: Number(cursor?.t0Ms),
      firstEventOrder: Number(cursor?.firstEventOrder)
    }
  }),
  /* version 是用户在历史页明确选择的转写版本；省略即原始版（SEM-F11）。
     这里仍然只传会话标识、格式与版本三个受控值。 */
  exportSession: (sessionId, format, version) => ipcRenderer.invoke(CHANNELS.HISTORY_EXPORT, {
    sessionId: String(sessionId || ''),
    format: String(format || ''),
    ...(version === undefined ? {} : { version: String(version) })
  }),
  getAgentContextOverview: (request) => {
    assertGetOverviewRequest(request)
    return ipcRenderer.invoke(CHANNELS.AGENT_CONTEXT_GET_OVERVIEW, request).then((response) => assertGetOverviewResponse(response))
  },
  manageAgentContext: (request) => {
    assertManageRequest(request)
    return ipcRenderer.invoke(CHANNELS.AGENT_CONTEXT_MANAGE, request).then((response) => assertManageResponse(response))
  },
  onAgentContextChanged
})

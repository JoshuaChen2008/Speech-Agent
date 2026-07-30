'use strict'

const { contextBridge } = require('electron')
const CHANNELS = require('../main/ipc/channels')
const { ipcRenderer, subscribe } = require('./shared')

contextBridge.exposeInMainWorld('historyApi', {
  dragStart: () => ipcRenderer.send(CHANNELS.DRAG_START),
  dragEnd: () => ipcRenderer.send(CHANNELS.DRAG_END),
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
  getSession: (sessionId) => ipcRenderer.invoke(CHANNELS.HISTORY_GET, String(sessionId || '')),
  exportSession: (sessionId, format) => ipcRenderer.invoke(CHANNELS.HISTORY_EXPORT, {
    sessionId: String(sessionId || ''),
    format: String(format || '')
  })
})

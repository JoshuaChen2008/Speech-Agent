'use strict'

const { contextBridge } = require('electron')
const CHANNELS = require('../main/ipc/channels')
const { ipcRenderer, subscribe } = require('./shared')

contextBridge.exposeInMainWorld('shell', {
  mouseThrough: (ignore) => ipcRenderer.send(CHANNELS.MOUSE_THROUGH, !!ignore),
  dragStart: () => ipcRenderer.send(CHANNELS.DRAG_START),
  dragEnd: () => ipcRenderer.send(CHANNELS.DRAG_END),
  resizeStart: (edge) => ipcRenderer.send(CHANNELS.RESIZE_START, String(edge || '')),
  resizeEnd: () => ipcRenderer.send(CHANNELS.RESIZE_END),
  getLock: () => ipcRenderer.invoke(CHANNELS.LOCK_GET),
  onLock: (callback) => subscribe(CHANNELS.LOCK_CHANGED, callback),
  getConfig: () => ipcRenderer.invoke(CHANNELS.CONFIG_GET),
  onConfig: (callback) => subscribe(CHANNELS.CONFIG_CHANGED, callback),
  onCaption: (callback) => subscribe(CHANNELS.CAPTION_EVENT, callback),
  getCaptionState: () => ipcRenderer.invoke(CHANNELS.CAPTION_STATE_GET)
})

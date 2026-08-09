'use strict'

const { contextBridge } = require('electron')
const CHANNELS = require('../main/ipc/channels')
const { createWindowInteractionBridge, ipcRenderer, subscribe } = require('./shared')
const interaction = createWindowInteractionBridge('caption')

contextBridge.exposeInMainWorld('shell', {
  mouseThrough: interaction.mouseThrough,
  dragStart: interaction.dragStart,
  dragEnd: interaction.dragEnd,
  resizeStart: interaction.resizeStart,
  resizeEnd: interaction.resizeEnd,
  onInteractionSync: interaction.onInteractionSync,
  getLock: () => ipcRenderer.invoke(CHANNELS.LOCK_GET),
  onLock: (callback) => subscribe(CHANNELS.LOCK_CHANGED, callback),
  onToolbarOverlap: (callback) => subscribe(CHANNELS.CAPTION_LAYOUT_TOOLBAR_OVERLAP, callback),
  getConfig: () => ipcRenderer.invoke(CHANNELS.CONFIG_GET),
  onConfig: (callback) => subscribe(CHANNELS.CONFIG_CHANGED, callback),
  onCaption: (callback) => subscribe(CHANNELS.CAPTION_EVENT, callback),
  onCaptionState: (callback) => subscribe(CHANNELS.CAPTION_STATE_CHANGED, callback),
  getCaptionState: () => ipcRenderer.invoke(CHANNELS.CAPTION_STATE_GET),
  reportCaptionViewportEviction: (report) => ipcRenderer.invoke(CHANNELS.CAPTION_VIEWPORT_EVICT, report)
})

'use strict'

const { contextBridge } = require('electron')
const CHANNELS = require('../main/ipc/channels')
const { createWindowInteractionBridge, ipcRenderer, subscribe } = require('./shared')
const interaction = createWindowInteractionBridge('toolbar')

contextBridge.exposeInMainWorld('shell', {
  mouseThrough: interaction.mouseThrough,
  dragStart: interaction.dragStart,
  dragEnd: interaction.dragEnd,
  onInteractionSync: interaction.onInteractionSync,
  lockToggle: () => ipcRenderer.send(CHANNELS.LOCK_TOGGLE),
  getLock: () => ipcRenderer.invoke(CHANNELS.LOCK_GET),
  onLock: (callback) => subscribe(CHANNELS.LOCK_CHANGED, callback),
  getToolbarLayoutContext: () => ipcRenderer.invoke(CHANNELS.TOOLBAR_LAYOUT_GET_CONTEXT),
  reportToolbarLayout: (report) => ipcRenderer.send(CHANNELS.TOOLBAR_LAYOUT_REPORT_RECT, report),
  action: (name) => ipcRenderer.send(CHANNELS.TOOLBAR_ACTION, String(name || '')),
  getConfig: () => ipcRenderer.invoke(CHANNELS.CONFIG_GET),
  onConfig: (callback) => subscribe(CHANNELS.CONFIG_CHANGED, callback),
  getSnapshot: () => ipcRenderer.invoke(CHANNELS.RUNTIME_GET),
  onSnapshot: (callback) => subscribe(CHANNELS.RUNTIME_CHANGED, callback),
  getRefinementNotice: () => ipcRenderer.invoke(CHANNELS.REFINEMENT_NOTICE_GET),
  onRefinementNotice: (callback) => subscribe(CHANNELS.REFINEMENT_NOTICE_CHANGED, callback),
  command: (name) => ipcRenderer.invoke(CHANNELS.RUNTIME_COMMAND, String(name || ''))
})

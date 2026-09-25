'use strict'

const { contextBridge } = require('electron')
const CHANNELS = require('../main/ipc/channels')
const { createWindowInteractionBridge, ipcRenderer, subscribe } = require('./shared')
const interaction = createWindowInteractionBridge('toolbar')
const layoutDiagnostic = process.env.LIVE_SUBTITLE_TOOLBAR_LAYOUT_DIAGNOSTIC === '1'
  ? (() => {
      try {
        const { createRecorder, RENDERER_STAGES } = require('./toolbar-layout-diagnostic')
        return createRecorder(RENDERER_STAGES)
      } catch { return null }
    })()
  : null
function noteLayout (stage, generation) {
  try { layoutDiagnostic?.record(stage, generation) } catch { /* diagnostic isolation */ }
}

contextBridge.exposeInMainWorld('shell', {
  ...(layoutDiagnostic ? { toolbarLayoutDiagnostic: {
    record: noteLayout,
    snapshot: (cutoff, generation, notBefore) => layoutDiagnostic.snapshot(cutoff, generation, notBefore)
  } } : {}),
  mouseThrough: interaction.mouseThrough,
  dragStart: interaction.dragStart,
  dragEnd: interaction.dragEnd,
  onInteractionSync: interaction.onInteractionSync,
  lockToggle: () => ipcRenderer.send(CHANNELS.LOCK_TOGGLE),
  getLock: () => ipcRenderer.invoke(CHANNELS.LOCK_GET),
  onLock: (callback) => subscribe(CHANNELS.LOCK_CHANGED, callback),
  getToolbarLayoutContext: () => ipcRenderer.invoke(CHANNELS.TOOLBAR_LAYOUT_GET_CONTEXT),
  reportToolbarLayout: (report) => {
    noteLayout('send-attempted', report?.generation)
    try {
      const result = ipcRenderer.send(CHANNELS.TOOLBAR_LAYOUT_REPORT_RECT, report)
      noteLayout('sent', report?.generation)
      return result
    } catch (error) {
      noteLayout('send-failed', report?.generation)
      throw error
    }
  },
  action: (name) => ipcRenderer.send(CHANNELS.TOOLBAR_ACTION, String(name || '')),
  openAgent: () => ipcRenderer.invoke(CHANNELS.AGENT_OPEN),
  getConfig: () => ipcRenderer.invoke(CHANNELS.CONFIG_GET),
  onConfig: (callback) => subscribe(CHANNELS.CONFIG_CHANGED, callback),
  getSnapshot: () => ipcRenderer.invoke(CHANNELS.RUNTIME_GET),
  onSnapshot: (callback) => subscribe(CHANNELS.RUNTIME_CHANGED, callback),
  getRefinementNotice: () => ipcRenderer.invoke(CHANNELS.REFINEMENT_NOTICE_GET),
  onRefinementNotice: (callback) => subscribe(CHANNELS.REFINEMENT_NOTICE_CHANGED, callback),
  onAgentOpenStatus: (callback) => subscribe(CHANNELS.AGENT_OPEN_STATUS, callback),
  command: (name) => ipcRenderer.invoke(CHANNELS.RUNTIME_COMMAND, String(name || ''))
})

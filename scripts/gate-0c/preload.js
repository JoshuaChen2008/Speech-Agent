'use strict'

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('gate0c', {
  mark: (stage, detail) => ipcRenderer.send('gate-0c:mark', { stage, detail }),
  playProbe: (options) => ipcRenderer.invoke('gate-0c:play-probe', options),
  analyzeCapture: (payload) => ipcRenderer.invoke('gate-0c:analyze-capture', payload)
})

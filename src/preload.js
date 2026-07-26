'use strict'

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('shell', {
  // 命中测试透传
  mouseThrough: (ignore) => ipcRenderer.send('mouse-through', !!ignore),

  // 手动拖动（role: 'caption' | 'toolbar'）
  dragStart: (role) => ipcRenderer.send('win-drag:start', role || null),
  dragEnd: () => ipcRenderer.send('win-drag:end'),

  // 手动拉伸字幕窗（edge: n/s/e/w/ne/nw/se/sw 的组合）
  // 透明无边框窗在 Windows 上没有可用的原生拉伸边，只能和拖动一样由主进程改 bounds
  resizeStart: (edge) => ipcRenderer.send('win-resize:start', String(edge || '')),
  resizeEnd: () => ipcRenderer.send('win-resize:end'),

  // 锁定
  lockToggle: () => ipcRenderer.send('lock:toggle'),
  getLock: () => ipcRenderer.invoke('lock:get'),
  onLock: (cb) => {
    const h = (_e, on) => cb(on)
    ipcRenderer.on('lock:changed', h)
    return () => ipcRenderer.removeListener('lock:changed', h)
  },

  // 录制（play/pause）
  recToggle: () => ipcRenderer.send('rec:toggle'),
  getRec: () => ipcRenderer.invoke('rec:get'),
  onRec: (cb) => {
    const h = (_e, on) => cb(on)
    ipcRenderer.on('rec:changed', h)
    return () => ipcRenderer.removeListener('rec:changed', h)
  },

  // 工具栏动作（settings / close）
  action: (name) => ipcRenderer.send('bar-action', String(name)),

  // 设置窗关闭
  closeSettings: () => ipcRenderer.send('settings:close'),

  // 配置
  getConfig: () => ipcRenderer.invoke('config:get'),
  setConfig: (patch) => ipcRenderer.send('config:set', patch),
  onConfig: (cb) => {
    const h = (_e, c) => cb(c)
    ipcRenderer.on('config:changed', h)
    return () => ipcRenderer.removeListener('config:changed', h)
  }
})

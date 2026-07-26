'use strict'

const { contextBridge, ipcRenderer } = require('electron')

/* 通道名内联而不从 channels.js 引入：宿主窗运行在默认 Chromium sandbox
   下（Gate 0C 批准拓扑），sandbox 化的 preload 不能加载本地模块。
   字符串与 channels.js 的一致性由 test/runtime/audio-host.test.js 锁定。 */
const SAVE_DIAGNOSTIC = 'audio-host:save-diagnostic'
const MARK = 'audio-host:mark'

/* 宿主窗只拿到两个固定函数：上报诊断结果与打点。没有通用 send/invoke。 */
contextBridge.exposeInMainWorld('audioHost', {
  saveDiagnostic: (payload) => ipcRenderer.invoke(SAVE_DIAGNOSTIC, payload),
  mark: (stage, detail = null) => ipcRenderer.send(MARK, { stage: String(stage), detail })
})

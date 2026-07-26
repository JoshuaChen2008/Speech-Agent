'use strict'

const { contextBridge, ipcRenderer } = require('electron')

/* 通道名内联而不从 channels.js 引入：宿主窗运行在默认 Chromium sandbox
   下（Gate 0C 批准拓扑），sandbox 化的 preload 不能加载本地模块。
   字符串与 channels.js 的一致性由 test/runtime/audio-host.test.js 锁定。 */
const SAVE_DIAGNOSTIC = 'audio-host:save-diagnostic'
const MARK = 'audio-host:mark'
const PCM_PORT = 'audio-host:pcm-port'
const CONTROL = 'audio-host:control'

/* 宿主窗只拿到固定函数：上报诊断/控制消息与打点。没有通用 send/invoke。 */
contextBridge.exposeInMainWorld('audioHost', {
  saveDiagnostic: (payload) => ipcRenderer.invoke(SAVE_DIAGNOSTIC, payload),
  mark: (stage, detail = null) => ipcRenderer.send(MARK, { stage: String(stage), detail }),
  control: (payload) => ipcRenderer.send(CONTROL, payload)
})

/* MessagePort 不能过 contextBridge；按 Electron 标准模式经 window.postMessage
   转交给主世界（host.js 用 event.ports[0] 接收）。 */
ipcRenderer.on(PCM_PORT, (event, message) => {
  window.postMessage({ type: PCM_PORT, sessionId: message?.sessionId ?? null }, '*', event.ports)
})

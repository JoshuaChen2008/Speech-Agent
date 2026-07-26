'use strict'

/* audio host 与主进程之间的专用 IPC 通道。与三个可见窗口的
   src/main/ipc/channels.js 完全隔离：宿主窗按 WebContents 实例做
   sender 校验（强于 role 匹配），不进入可见窗口的角色授权矩阵。 */

module.exports = Object.freeze({
  SAVE_DIAGNOSTIC: 'audio-host:save-diagnostic',
  MARK: 'audio-host:mark'
})

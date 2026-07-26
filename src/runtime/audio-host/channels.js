'use strict'

/* audio host 与主进程之间的专用 IPC 通道。与三个可见窗口的
   src/main/ipc/channels.js 完全隔离：宿主窗按 WebContents 实例做
   sender 校验（强于 role 匹配），不进入可见窗口的角色授权矩阵。
   注意：preload.js 因 sandbox 不能 require 本模块，内联了同名字符串，
   一致性由 test/runtime/audio-host.test.js 锁定。 */

module.exports = Object.freeze({
  SAVE_DIAGNOSTIC: 'audio-host:save-diagnostic',
  MARK: 'audio-host:mark',
  /* B2.2：主进程把 MessagePort 交给宿主窗（renderer 收到后经 window.postMessage 转入主世界）。 */
  PCM_PORT: 'audio-host:pcm-port',
  /* B2.2：宿主窗 → 主进程的低频控制/指标消息（track-ended、metrics 等）。PCM 不走这里。 */
  CONTROL: 'audio-host:control'
})

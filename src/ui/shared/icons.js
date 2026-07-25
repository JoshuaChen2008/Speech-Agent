'use strict'

// @ts-check

/* 共享图标 sprite。
   --------------------------------------------------------------------------
   一次性注入 <symbol> 集合，各处用 <use href="#ic-xxx"> 引用。
   风格与现有工具条一致：24×24 线性、stroke-width 1.75、round cap/join。

   形状是状态的**主**编码通道（颜色只是冗余），所以每个 phase 的图标必须
   在灰度下也能互相区分：
     ban 斜杠圆 · ready 待机符 · spinner 缺口弧 · wave 声波五竖
     pause 双竖 · stopping 方框 · recover 回转箭头 · alert 三角叹号

   UMD，理由同 runtime-view.js。 */

;(function (root) {
  /** 每个 symbol 的内容。外层属性由 SPRITE 统一给。 */
  const PATHS = {
    /* ---- phase ---- */
    ban: '<circle cx="12" cy="12" r="9"/><path d="m5.64 5.64 12.72 12.72"/>',
    ready: '<path d="M12 3v8"/><path d="M18.36 6.64a9 9 0 1 1-12.72 0"/>',
    spinner: '<path d="M12 3a9 9 0 1 0 9 9"/>',
    wave: '<path d="M4 11v2"/><path d="M8 8v8"/><path d="M12 4.5v15"/><path d="M16 8v8"/><path d="M20 11v2"/>',
    pause: '<rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/>',
    stopping: '<rect x="5" y="5" width="14" height="14" rx="3"/>',
    recover: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>',
    alert: '<path d="M12 3 2.5 20h19Z"/><path d="M12 9.5v4.5"/><path d="M12 17.5h.01"/>',

    /* ---- 命令 ---- */
    play: '<polygon points="6 3 20 12 6 21 6 3"/>',
    stop: '<rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none"/>',
    retry: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>',

    /* ---- nextAction ---- */
    settings: '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
    model: '<path d="M21 8v8a2 2 0 0 1-1 1.73l-7 4a2 2 0 0 1-2 0l-7-4A2 2 0 0 1 3 16V8a2 2 0 0 1 1-1.73l7-4a2 2 0 0 1 2 0l7 4A2 2 0 0 1 21 8z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/>',
    permission: '<circle cx="7.5" cy="15.5" r="4.5"/><path d="m10.9 12.1 8.1-8.1"/><path d="m17 6 2 2"/><path d="m14.8 8.2 2 2"/>',

    /* ---- 工具条既有 ---- */
    history: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/>',
    lock: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
    unlock: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/>',
    close: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'
  }

  const NAMES = Object.freeze(Object.keys(PATHS))

  const SPRITE = [
    '<svg xmlns="http://www.w3.org/2000/svg" style="display:none" aria-hidden="true">',
    ...NAMES.map((name) =>
      '<symbol id="ic-' + name + '" viewBox="0 0 24 24" fill="none" stroke="currentColor"' +
      ' stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">' +
      PATHS[name] + '</symbol>'
    ),
    '</svg>'
  ].join('')

  /** 注入一次；重复调用无害。 */
  function installSprite (doc) {
    const target = doc || document
    if (target.getElementById('icon-sprite')) return
    const holder = target.createElement('div')
    holder.id = 'icon-sprite'
    holder.innerHTML = SPRITE
    target.body.insertBefore(holder, target.body.firstChild)
  }

  /** 返回一个引用 sprite 的 <svg>，装饰性（aria-hidden）—— 语义由外层按钮承担。 */
  function iconMarkup (name) {
    return '<svg class="icon" aria-hidden="true"><use href="#ic-' + name + '"/></svg>'
  }

  const api = { NAMES, SPRITE, installSprite, iconMarkup }

  if (typeof module !== 'undefined' && module.exports) module.exports = api
  else root.Icons = api
})(typeof globalThis !== 'undefined' ? globalThis : this)

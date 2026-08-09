'use strict'

// @ts-check

/* 外观配置 → CSS 变量。
   --------------------------------------------------------------------------
   字幕窗和工具条窗都要消费同一批外观键，映射规则只能有一份，
   否则「颜色留空要回退到主题默认」这种细节迟早在两边走岔。

   只处理**表现**：颜色、透明度、字号、圆角、主题。
   音频源、模型、AI 这些运行配置不归这里，它们要等 CommandResult。

   UMD，理由同 runtime-view.js。 */

;(function (root) {
  /** '#0e202c' / '#abc' → '14, 32, 44'；非法或留空返回 null。 */
  function hexToTriplet (hex) {
    const match = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(hex == null ? '' : hex).trim())
    if (!match) return null
    let body = match[1]
    if (body.length === 3) body = body[0] + body[0] + body[1] + body[1] + body[2] + body[2]
    const value = parseInt(body, 16)
    return ((value >> 16) & 255) + ', ' + ((value >> 8) & 255) + ', ' + (value & 255)
  }

  /** 数值兜底：配置文件被手改坏时不至于让整个界面塌掉。 */
  function clampNumber (value, min, max, fallback) {
    const n = Number(value)
    if (!Number.isFinite(n)) return fallback
    return Math.min(max, Math.max(min, n))
  }

  /**
   * 把外观配置写到 :root。
   * @param {HTMLElement} element 通常是 document.documentElement
   * @param {*} cfg 主进程广播的配置（含 systemDark）
   */
  function applyAppearance (element, cfg) {
    const style = element.style

    element.dataset.theme = cfg.theme === 'auto'
      ? (cfg.systemDark ? 'dark' : 'light')
      : cfg.theme

    style.setProperty('--fs', clampNumber(cfg.fontSize, 12, 96, 30) + 'px')
    style.setProperty('--radius', clampNumber(cfg.radius, 0, 32, 10) + 'px')
    style.setProperty('--bar-alpha', String(clampNumber(cfg.opacity, 0, 1, 0.86)))
    style.setProperty('--toolbar-alpha', String(clampNumber(cfg.toolbarOpacity, 0, 1, 0.82)))

    /* 自定义底色只覆盖字幕卡。留空必须 removeProperty 而不是写回默认值 ——
       否则内联样式会盖住 tokens.css 里的 [data-theme] 分支，深浅主题就切不动。
       同时清理旧版本可能留下的 --toolbar-bg 内联值，保证工具条回到固定配色。 */
    const triplet = hexToTriplet(cfg.barColor)
    if (triplet) {
      style.setProperty('--bar-bg', triplet)
    } else {
      style.removeProperty('--bar-bg')
    }
    style.removeProperty('--toolbar-bg')
  }

  const api = { hexToTriplet, clampNumber, applyAppearance }

  if (typeof module !== 'undefined' && module.exports) module.exports = api
  else root.Appearance = api
})(typeof globalThis !== 'undefined' ? globalThis : this)

'use strict'

/* 主进程配置存储：内存 + 持久化到 userData/config.json。
   字幕条与设置窗共享同一份，改动即写盘并广播。 */

const { app } = require('electron')
const path = require('node:path')
const fs = require('node:fs')

const DEFAULTS = {
  // 显示与字幕
  fontSize: 30,          // px：小 24 / 中 30 / 大 38
  opacity: 0.86,         // 字幕卡背景不透明度 0–1.00（0 = 全透明，只剩文字）
  toolbarOpacity: 0.82,  // 工具条背景不透明度 0–1.00，与字幕卡各自独立
  barColor: null,        // 字幕卡与工具条的底色 '#rrggbb'；null = 跟随深浅主题
  radius: 10,            // 圆角 px 6–16
  // 字幕窗尺寸（DIP，含窗口留白）。用户拉伸后持久化；上下限见 main.js CAP_LIMITS。
  captionWidth: 920,
  captionHeight: 190,
  theme: 'auto',         // light | auto | dark
  bilingual: true,       // 双语译文
  // 当前句的行数上限。实际行数由整卡高度预算决定，窗口越高分到越多行；
  // 这个值只是用户能设的天花板。窗口可拉伸后原来的 2 会让高度失去意义，故放到 4。
  maxLines: 4,
  // 音频源
  mic: true,           // 麦克风（我）
  loopback: false,     // 系统声回环（对方）
  // 语音识别
  latency: 480         // 字幕延迟档位 160 | 480 | 960
}

let cfg = { ...DEFAULTS }
let file = null

function load () {
  file = path.join(app.getPath('userData'), 'config.json')
  try {
    cfg = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(file, 'utf8')) }
  } catch {
    cfg = { ...DEFAULTS }
  }
  return cfg
}

function get () {
  return cfg
}

function set (patch) {
  cfg = { ...cfg, ...patch }
  try {
    fs.writeFileSync(file, JSON.stringify(cfg, null, 2))
  } catch { /* 写盘失败不影响运行 */ }
  return cfg
}

module.exports = { DEFAULTS, load, get, set }

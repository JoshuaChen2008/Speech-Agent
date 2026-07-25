'use strict'

/* 主进程配置存储：内存 + 持久化到 userData/config.json。
   字幕条与设置窗共享同一份，改动即写盘并广播。 */

const { app } = require('electron')
const path = require('node:path')
const fs = require('node:fs')

const DEFAULTS = {
  // 显示与字幕
  fontSize: 30,        // px：小 24 / 中 30 / 大 38
  opacity: 0.86,       // 背景不透明度 0.70–1.00
  radius: 10,          // 圆角 px 6–16
  theme: 'auto',       // light | auto | dark
  bilingual: true,     // 双语译文
  maxLines: 2,         // 最多显示行数
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

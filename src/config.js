'use strict'

/* Electron 组合根使用的配置门面。校验、迁移和原子写入位于纯 Node
   ConfigStore 中，便于不启动 Electron 就覆盖边界测试。 */

const { app } = require('electron')
const path = require('node:path')
const { ConfigStore, DEFAULT_CONFIG } = require('./main/services/config-store')

let store = null

function load () {
  store = new ConfigStore(path.join(app.getPath('userData'), 'config.json'))
  return store.load()
}

function get () {
  return requireStore().get()
}

function set (patch) {
  return requireStore().update(patch)
}

function applyPreset (preset) {
  return requireStore().applyPreset(preset)
}

function requireStore () {
  if (!store) throw new Error('config.load() must be called after app.whenReady()')
  return store
}

module.exports = { DEFAULTS: DEFAULT_CONFIG, applyPreset, load, get, set }

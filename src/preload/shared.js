'use strict'

const { ipcRenderer } = require('electron')

function subscribe (channel, callback) {
  if (typeof callback !== 'function') throw new TypeError('callback must be a function')
  const handler = (_event, value) => callback(value)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

module.exports = { ipcRenderer, subscribe }

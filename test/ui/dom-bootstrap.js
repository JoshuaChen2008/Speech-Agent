'use strict'

// react-dom 的 isInputEventSupported 特性探测只在模块首次 require 时执行一次
// （基于当时的全局 window/document），结果被缓存到进程生命周期结束。
// 如果先 require('react-dom/client') 再搭建 JSDOM，这个探测会在
// window 尚不存在时跑完并永久锁定为 false，导致后续对受控文本输入框
// 派发的原生 'input' 事件永远不会被识别为变更、onChange 永不触发。
// 这里在任何 UI 测试文件 require react-dom 之前，先用一个一次性的
// JSDOM window 把探测喂正确，然后就可以丢弃——每个测试各自的
// JSDOM 实例之后正常独立创建，不依赖这个引导用的 window。
const { JSDOM } = require('jsdom')

if (typeof global.window === 'undefined') {
  const bootstrap = new JSDOM('<!doctype html><html><body></body></html>')
  global.window = bootstrap.window
  global.document = bootstrap.window.document
  global.HTMLElement = bootstrap.window.HTMLElement
  global.HTMLInputElement = bootstrap.window.HTMLInputElement
  global.Event = bootstrap.window.Event
  global.MouseEvent = bootstrap.window.MouseEvent
  require('react-dom/client')
  delete global.window
  delete global.document
  delete global.HTMLElement
  delete global.HTMLInputElement
  delete global.Event
  delete global.MouseEvent
}

module.exports = {}

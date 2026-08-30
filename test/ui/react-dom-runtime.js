'use strict'

/* react-dom 的入口在被 require 的那一刻就固化了「当前是不是浏览器环境」以及
   「是否支持 input 事件」的探测结果。若此刻还没有 window，它的变更事件插件会退回
   IE 的 propertychange 路径：之后无论派发多少 input 事件都不会触发 onChange，
   受控输入在测试里表现为 DOM 值变了而 React 状态没变 —— 断言看到的是旧文本。

   所以这里先立一个引导 DOM 再载入 react-dom，随后把全局还原。探测结果只算一次，
   对随后每个新建的 JSDOM 实例都成立；还原则保证共享进程里的纯 Node 用例仍然看不到
   window。test:core 用 --experimental-test-isolation=none 让所有文件同进程运行，
   谁先 require('react-dom/client') 谁就决定了这次探测结果，因此需要在 jsdom 里
   渲染的 test/ui 用例都必须从这里取 createRoot，不要直接 require。 */

const { JSDOM } = require('jsdom')

const bootstrap = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://renderer.test/' })
const restore = ['window', 'document'].map((key) => [key, global[key]])
global.window = bootstrap.window
global.document = bootstrap.window.document

const { createRoot } = require('react-dom/client')

for (const [key, value] of restore) value === undefined ? delete global[key] : (global[key] = value)

module.exports = { createRoot }

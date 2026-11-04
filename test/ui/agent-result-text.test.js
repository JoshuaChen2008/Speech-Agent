'use strict'

const assert = require('node:assert/strict')
const path = require('node:path')
const test = require('node:test')
const React = require('react')
const { renderToStaticMarkup } = require('react-dom/server')
const { JSDOM } = require('jsdom')
const { loadRendererModule } = require('./load-renderer-module')

async function render (t, text) {
  const { ResultText } = await loadRendererModule(path.resolve(__dirname, '../../src/agent/result-text.tsx'))
  const dom = new JSDOM(renderToStaticMarkup(React.createElement(ResultText, { text })))
  t.after(() => dom.window.close())
  return dom.window.document.querySelector('.result-prose')
}

test('SEM-F31/F38/J29/J22: short paragraphs and a long sentence remain intact, including decimals and unmatched markers', async t => {
  for (const text of ['版本 2.0 已决定。下一步核对接口。', '**未闭合的重点与 `术语', '这是没有句末标点的正文'.repeat(40), '请保留' + '完整的说明'.repeat(60) + '。']) {
    const body = await render(t, text)
    assert.equal(body.querySelectorAll(':scope > p').length, 1)
    assert.equal(body.textContent, text)
  }
})

test('SEM-F31/F38/J29/J22: sentence paragraphs count Unicode code points and preserve inline formatting across boundaries', async t => {
  const text = '😀'.repeat(150) + '。' + '继续核对接口'.repeat(20) + '。'
  const body = await render(t, `**${text}**`)
  const paragraphs = [...body.querySelectorAll(':scope > p')]
  assert.equal(paragraphs.length, 2)
  assert.equal(paragraphs.map(p => p.textContent).join(''), text)
  assert.ok(paragraphs.every(p => p.querySelector('strong')))
  assert.ok(paragraphs.every(p => !/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/u.test(p.textContent)))
})

test('SEM-F31/F38/T04/J30: model HTML, URLs, images and fenced content stay inert text', async t => {
  const literal = '<script>window.compromised=true</script>\n<img src=x onerror=alert(1)>\n[链接](javascript:alert(1)) ![图片](https://example.test/image)'
  const body = await render(t, literal + '\n\n```html\n### 不作为标题\n**不解释强调**\n- 不作为列表\n```')
  assert.equal(body.querySelector('script,img,a,h3,strong,ul'), null)
  assert.equal(body.querySelector('p').textContent, literal)
  assert.equal(body.querySelectorAll('p').length, 2)
  const terms = await render(t, '参数 `max_tokens` 与 **重要说明**，代码 `<img src=x>`。')
  assert.deepEqual([...terms.querySelectorAll('code')].map(code => code.textContent), ['max_tokens', '<img src=x>'])
  assert.equal(terms.querySelector('img'), null)
})

test('SEM-F31/F38/J29/J22: numbered lists retain starting numbers, gaps and continuation text', async t => {
  const body = await render(t, '### 核对事项\n4. 第一项\n   补充说明\n7、第二项\n\n• 第三项\n- 第四项')
  assert.equal(body.querySelector('h3').textContent, '核对事项')
  assert.equal(body.querySelector('ol').start, 4)
  assert.deepEqual([...body.querySelectorAll('ol > li')].map(li => [li.value, li.textContent]), [[4, '第一项\n补充说明'], [7, '第二项']])
  assert.deepEqual([...body.querySelectorAll('ul > li')].map(li => li.textContent), ['第三项', '第四项'])
  const longItem = '保留这一项的完整上下文，按会话证据逐句核对接口调整、负责范围与后续进展。'.repeat(10)
  const list = await render(t, '- ' + longItem)
  assert.equal(list.querySelectorAll('li').length, 1, 'paragraphs do not create additional list items')
  assert.ok(list.querySelectorAll('li > p').length > 1)
  assert.equal(list.querySelector('li').textContent, longItem)
})

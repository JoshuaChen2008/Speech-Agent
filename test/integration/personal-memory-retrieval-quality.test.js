'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { fixture, configureEmbedding } = require('./helpers/personal-memory-file-fixture')
const { sha256Canonical } = require('../../src/runtime/storage-worker/canonical-json')

// Fixed, explicitly labeled synthetic corpus. The provider seam is a lookup
// table, not a public embedding model: this measures retrieval plumbing and
// fusion behavior, and must never be presented as real cloud model quality.
const TOPICS = [
  ['项目使用 SQLite 事务保存治理记录', ['SQLite', '数据库事务', '原子提交', 'transaction storage', '治理记录放在哪里']],
  ['产品要求低延迟响应', ['低延迟', '响应速度', '尽快出结果', 'fast response', 'latency requirement']],
  ['偏好以 Markdown 编辑正文', ['Markdown', '可编辑文档', '文字文件格式', 'editable notes', 'plain text format']],
  ['设备界面支持深色外观', ['深色', '暗色主题', '晚上阅读界面', 'dark theme', 'night appearance']],
  ['查询采用关键词与向量统一召回', ['关键词', '混合检索', '语义查询', 'hybrid retrieval', 'similarity lookup']],
  ['决定采用 HTTPS 服务连接', ['HTTPS', '加密传输', '安全连接协议', 'secure transport', 'TLS connection']],
  ['字幕只监听一个 mic 或 loopback 来源', ['loopback', '来源互斥', '单独麦克风', 'one capture source', 'microphone selection']],
  ['字幕系统禁止保存现场音频', ['现场音频', '不保留声音', '禁止写入录制样本', 'no audio persistence', 'sound retention policy']],
  ['会话总结只在明确请求后生成', ['会话总结', '主动生成纪要', '明确请求摘要', 'on demand summary', 'meeting minutes trigger']],
  ['删除后保留 suppression 防止旧来源再生', ['suppression', '撤销后阻止复活', '备份重新出现', 'revocation protection', 'prevent regeneration']],
  ['忘记只撤销读取资格并保留文件', ['忘记', '保留文件撤销', '暂不再引用', 'forget memory', 'keep file withdraw access']],
  ['外部编辑变化需要再次确认', ['外部编辑', '修改后重新核对', '编辑器保存新正文', 'external editor confirmation', 'review changed content']],
  ['表征模型凭据独立保存', ['表征模型', '嵌入密钥', '独立 API key', 'embedding credential', 'separate vector key']],
  ['索引丢失可以按正文重建', ['索引丢失', '恢复派生检索', '重建搜索数据', 'rebuild index', 'regenerate derived search']],
  ['未知元数据与 YAML 注释保留', ['YAML', '不丢额外字段', '保留文件注释', 'unknown metadata', 'preserve comments']],
  ['应用保存持有 Win32 独占文件句柄', ['Win32', '写入竞争', '禁止其他进程替换文件', 'exclusive file handle', 'file write lock']]
]
const UNANSWERABLE = ['火星气候', '海豚迁徙', '珊瑚保育', '南极冰川', '天体质量', '化学催化', '细菌分类', '热带雨林', '海底火山', '古代书法', 'planet orbit', 'coral reef', 'tropical rainforest', 'dolphin migration', 'volcano geology', '星际航线', '河流生态', '矿石硬度', '音乐和弦', '宇宙膨胀']
const QUESTIONS = [...TOPICS.flatMap(([, queries], label) => queries.map(query => ({ query, labels: [label] }))), ...UNANSWERABLE.map(query => ({ query, labels: [] }))]
function vector (text) {
  const label = TOPICS.findIndex(([body, queries]) => body === text || queries.includes(text))
  return Array.from({ length: 17 }, (_v, index) => index === (label < 0 ? 16 : label) ? 1 : 0)
}
function metrics (results, labels) {
  let recall = 0; let precision = 0; let ndcg = 0; let answered = 0; let falseAnswers = 0; let empty = 0
  for (let i = 0; i < results.length; i++) {
    const ids = results[i].slice(0, 10); const relevant = labels[i]
    if (!relevant.length) { empty++; falseAnswers += Number(ids.length > 0); continue }
    answered++
    const found = ids.filter(id => relevant.includes(id)).length
    recall += found / relevant.length; precision += found / 10
    ndcg += ids.reduce((value, id, rank) => value + (relevant.includes(id) ? 1 / Math.log2(rank + 2) : 0), 0)
  }
  return { recallAt10: recall / answered, precisionAt10: precision / answered, ndcgAt10: ndcg / answered, noAnswerFalseRecallRate: falseAnswers / empty }
}

test('SEM-F42/J22-QUALITY: 100 fixed labeled queries compare keyword, vector and RRF using real storage and bounded ranking', { skip: process.platform !== 'win32', timeout: 30000 }, async t => {
  let providerRequests = 0
  const f = await fixture(t, { fetchImpl: async (_url, options) => {
    providerRequests++
    const texts = JSON.parse(options.body).input
    return new Response(JSON.stringify({ model: 'synthetic-vector', data: texts.map((text, index) => ({ index, embedding: vector(text) })) }))
  } })
  const ids = []
  for (const [text] of TOPICS) ids.push((await f.remember(text)).item.memory_id)
  await configureEmbedding(f)
  if (f.runtime.indexTask) await f.runtime.indexTask
  const governance = await f.gateway.personalMemoryFiles({ type: 'export_governance' })
  const buildStart = performance.now(); await f.runtime.buildIndex(true, new AbortController().signal); const buildMs = performance.now() - buildStart
  assert.deepEqual(await f.gateway.personalMemoryFiles({ type: 'export_governance' }), governance)
  const scope = { kind: 'global', reference: null }
  const state = await f.gateway.personalMemoryIndex({ type: 'status' })
  const page = await f.gateway.personalMemoryIndex({ type: 'vector_page', generationId: state.generation.generation_id, scope, after: null })
  const keyword = []; const semantic = []; const hybrid = []; const elapsed = []
  for (const question of QUESTIONS) {
    const request = { schemaVersion: 2, scope, query: question.query, semantic_keys: [], aliases: [], vectorRanks: [], degradation: 'embedding_disabled' }
    const k = await f.gateway.enqueue('personalContextResolve', request, { memoryPrepared: true })
    keyword.push(k.personalMemories.map(row => row.memoryId))
    semantic.push((await f.runtime.client.call({ type: 'vector_rank', query: vector(question.query), rows: page.items, previous: [] })).map(row => row.memoryId))
    const start = performance.now(); const h = await f.resolve(question.query); elapsed.push(performance.now() - start)
    hybrid.push(h.personalMemories.map(row => row.memoryId)); assert.equal(h.retrieval.mode, 'hybrid')
  }
  assert.equal(QUESTIONS.length, 100)
  const labels = QUESTIONS.map(q => q.labels.map(label => ids[label]))
  const comparisons = { keyword: metrics(keyword, labels), vector: metrics(semantic, labels), rrf: metrics(hybrid, labels) }
  assert.ok(comparisons.rrf.recallAt10 >= comparisons.keyword.recallAt10)
  assert.equal(comparisons.vector.recallAt10, 1)
  const sorted = elapsed.slice().sort((a, b) => a - b)
  const vectorBytes = Number(f.service.store.database.prepare('SELECT sum(length(vector)) n FROM personal_memory_vectors WHERE generation_id=?').get(state.generation.generation_id).n)
  const report = { schemaVersion: 1, kind: 'personal-memory-synthetic-retrieval', provider: 'controlled_lookup', publicCloudValidated: false,
    fixtureSha256: sha256Canonical({ TOPICS, QUESTIONS }), policySha256: sha256Canonical({ retrieval: 'resolve@2', rrf: 60, maxRank: 64, maxItems: 20 }),
    queryCount: 100, answerableCount: 80, noAnswerCount: 20, documentCount: ids.length, dimensions: 17, vectorBytes, providerRequests,
    buildDurationMs: buildMs, queryDurationMs: { p50: sorted[49], p95: sorted[94], max: sorted.at(-1) }, comparisons }
  // Evidence is deliberately only metrics, enums, booleans and hashes.
  assert.equal(/SQLite|mic|[A-Z]:[\\/]|synthetic-independent-key/.test(JSON.stringify(report)), false)
  fs.writeFileSync(path.join(__dirname, '../../docs/validation/personal-memory-synthetic-retrieval-2026-10-02.json'), JSON.stringify(report, null, 2) + '\n')
  t.diagnostic(JSON.stringify(comparisons))
})

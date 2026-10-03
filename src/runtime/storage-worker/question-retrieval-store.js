'use strict'

const { StorageError, assertExactKeys } = require('./protocol')
const { canonicalize, sha256Canonical } = require('./canonical-json')

function fail (code = 'AGENT_REQUEST_INVALID') { throw new StorageError(code) }
function normalize (text) { return text.normalize('NFKC').toLocaleLowerCase('und').replace(/\s+/gu, ' ') }
const STOP = new Set(['什么', '怎么', '是否', '可以', '还有', '之前', '时候', '因为', '那个', '一下', '问题', '内容', '这个', '我们', '相关', '哪些', '所有', '全部', '多少', '对话', '会话'])

function queryKeys (query) {
  const keys = []
  for (const token of normalize(query).match(/[a-z0-9]+(?:[._:/-][a-z0-9]+)*|[\p{Script=Han}]+/gu) || []) {
    const points = Array.from(token)
    if (!/\p{Script=Han}/u.test(token) || points.length < 3) keys.push(token)
    else {
      if (points.length <= 16) keys.push(token)
      for (let index = 0; index < points.length - 1; index += 1) keys.push(points.slice(index, index + 2).join(''))
    }
  }
  for (const token of query.match(/\d{1,4}[年月./:-]\d{1,2}(?:[月日./:-]\d{1,2})?日?/gu) || []) keys.unshift(normalize(token))
  return [...new Set(keys)].filter(key => !STOP.has(key)).slice(0, 24)
}

// Connection-local, rebuildable derived index. Canonical subtitle and experience
// facts remain in their existing SQLite tables; the cache has no export path.
function ensureIndex (store, snapshot, experiences) {
  const db = store.database
  if (!store.questionIndex) {
    db.exec('CREATE TEMP TABLE question_retrieval_cache (key TEXT PRIMARY KEY,kind TEXT NOT NULL,text TEXT NOT NULL) STRICT')
    let fts = true
    try { db.exec("CREATE VIRTUAL TABLE temp.question_retrieval_fts USING fts5(key UNINDEXED,text,tokenize='trigram')") } catch { fts = false }
    store.questionIndex = { digest: null, fts }
  }
  const digest = sha256Canonical({ inputDigest: snapshot.inputDigest, experiences: experiences.map(row => [row.experience_id, row.product_digest]) })
  if (store.questionIndex.digest === digest) return store.questionIndex
  db.exec('DELETE FROM temp.question_retrieval_cache')
  if (store.questionIndex.fts) db.exec('DELETE FROM temp.question_retrieval_fts')
  const insert = db.prepare('INSERT INTO temp.question_retrieval_cache(key,kind,text) VALUES (?,?,?)')
  const insertFts = store.questionIndex.fts ? db.prepare('INSERT INTO temp.question_retrieval_fts(key,text) VALUES (?,?)') : null
  for (const [kind, values] of [['raw', snapshot.events.map(event => ({ key: `raw.${event.eventOrder}`, text: event.text }))],
    ['experience', experiences.map(row => ({ key: row.experience_id, text: row.text }))]]) {
    for (const value of values) {
      const text = normalize(value.text)
      insert.run(value.key, kind, text)
      insertFts?.run(value.key, text)
    }
  }
  store.questionIndex.digest = digest
  return store.questionIndex
}

function search (store, keys, kind, limit) {
  if (keys.length === 0) return []
  const db = store.database
  const rows = new Map()
  const longKeys = keys.filter(key => Array.from(key).length >= 3)
  if (store.questionIndex.fts && longKeys.length > 0) {
    const match = longKeys.map(key => `"${key.replace(/"/g, '""')}"`).join(' OR ')
    for (const row of db.prepare(`SELECT cache.key,cache.text FROM temp.question_retrieval_fts AS fts
      JOIN temp.question_retrieval_cache AS cache ON cache.key=fts.key
      WHERE question_retrieval_fts MATCH ? AND cache.kind=? ORDER BY bm25(question_retrieval_fts) LIMIT 64`).all(match, kind)) rows.set(row.key, row)
  }
  // FTS trigram does not cover one/two-character Chinese terms or short numbers.
  // This independent equality/substring route also handles a missing FTS module.
  const fallback = store.questionIndex.fts ? keys.filter(key => Array.from(key).length < 3) : keys
  if (fallback.length > 0) {
    for (const row of db.prepare(`SELECT key,text FROM temp.question_retrieval_cache WHERE kind=? AND
      (${fallback.map(() => 'instr(text,?)>0').join(' OR ')}) ORDER BY key LIMIT 128`).all(kind, ...fallback)) rows.set(row.key, row)
  }
  return [...rows.values()].map(row => ({ ...row, score: keys.reduce((score, key) => score + (row.text.includes(key) ? Array.from(key).length : 0), 0) }))
    .sort((left, right) => right.score - left.score || left.key.localeCompare(right.key)).slice(0, limit)
}

function sourceForRun (store, run) {
  const scope = JSON.parse(run.scope_json)
  if (scope.kind !== 'session' || run.transcript_version !== 'raw') fail()
  const size = store.database.prepare(`SELECT COUNT(*) AS n,COALESCE(SUM(length(CAST(event.text AS BLOB))),0) AS bytes
    FROM segments AS segment JOIN caption_events AS event ON event.event_order=segment.first_event_order
    WHERE segment.session_id=?`).get(scope.reference)
  if (Number(size.n) > 50000 || Number(size.bytes) > 4 * 1024 * 1024) fail('AGENT_BUDGET_EXCEEDED')
  return store.sessionInput({ sourceKind: 'session', sessionId: scope.reference, transcriptVersion: 'raw',
    inputWatermark: JSON.parse(run.input_watermark_json).throughEventOrder, inputDigest: run.input_digest })
}

function experienceRows (store, snapshot) {
  const personal = Boolean(store.automaticPolicy?.agentEnabled && store.automaticPolicy?.memoryEnabled)
  const rows = personal ? store.database.prepare(`SELECT experience.*,range.product_digest,range.range_id FROM personal_context_experiences AS experience
    JOIN personal_context_experience_ranges AS range ON range.range_id=experience.range_id
    JOIN personal_context_episodes AS episode ON episode.episode_id=range.episode_id
    WHERE episode.lifecycle='active' AND episode.session_id=? AND episode.transcript_version='raw' AND episode.input_digest=?
    ORDER BY range.ordinal,experience.ordinal`).all(snapshot.sessionId, snapshot.inputDigest) : []
  // Existing user-requested minutes are also retrieval entry points. Their
  // prose never authorizes a claim; actual subtitle snippets do that below.
  const minutes = store.database.prepare(`SELECT interaction.interaction_id,interaction.result_json,interaction.result_digest
    FROM formal_agent_interactions AS interaction JOIN formal_agent_runs AS run ON run.run_id=interaction.run_id
    WHERE run.recipe_id='summary.minutes' AND run.state='succeeded' AND run.transcript_version='raw'
      AND run.input_digest=? AND json_extract(run.scope_json,'$.reference')=? AND interaction.result_json IS NOT NULL
      AND (?=1 OR run.summary_use_memory=0)
    ORDER BY interaction.terminal_at DESC LIMIT 4`).all(snapshot.inputDigest, snapshot.sessionId, personal ? 1 : 0)
  const validOrders = new Set(snapshot.events.map(event => event.eventOrder))
  for (const minute of minutes) {
    const output = JSON.parse(minute.result_json)
    const items = [{ text: output.overview, sourceRefs: [{ sessionId: snapshot.sessionId, transcriptVersion: 'raw',
      fromEventOrder: snapshot.fromEventOrder, throughEventOrder: snapshot.throughEventOrder }] },
    ...output.conclusions, ...output.todos, ...output.risks]
    items.forEach((item, ordinal) => {
      const ref = item.sourceRefs.find(ref => ref.sessionId === snapshot.sessionId && ref.transcriptVersion === 'raw' &&
        validOrders.has(ref.fromEventOrder) && validOrders.has(ref.throughEventOrder))
      if (!ref) return
      rows.push({ experience_id: `minutes.${minute.interaction_id}.${ordinal}`, kind: 'event', text: item.text, product_digest: minute.result_digest,
        source_ref_json: canonicalize(ref), occurred_from_offset_ms: 0, occurred_through_offset_ms: Math.max(0, snapshot.endedAt - snapshot.startedAt) })
    })
  }
  return rows
}

function restore (snapshot, experiences, descriptor, query) {
  const events = new Map(snapshot.events.map(event => [event.eventOrder, event]))
  const experienceMap = new Map(experiences.map(row => [row.experience_id, row]))
  const summaries = descriptor.experiences.map(ref => {
    const row = experienceMap.get(ref.experienceId)
    if (!row || row.product_digest !== ref.productDigest) fail('AGENT_INPUT_CHANGED')
    return { experienceId: row.experience_id, kind: row.kind, text: row.text, sessionStartedAt: new Date(snapshot.startedAt).toISOString(),
      locator: JSON.parse(row.source_ref_json), fromOffsetMs: Number(row.occurred_from_offset_ms), throughOffsetMs: Number(row.occurred_through_offset_ms) }
  })
  const sources = descriptor.parts.map(part => {
    const event = events.get(part.eventOrder)
    if (!event || event.segmentId !== part.segmentId) fail('AGENT_INPUT_CHANGED')
    const points = Array.from(event.text)
    if (part.codePointStart < 0 || part.codePointEnd > points.length) fail('AGENT_INPUT_CHANGED')
    return { sourceRef: { sessionId: snapshot.sessionId, transcriptVersion: 'raw', fromEventOrder: part.eventOrder, throughEventOrder: part.eventOrder },
      sessionStartedAt: new Date(snapshot.startedAt).toISOString(),
      segmentId: part.segmentId, codePointStart: part.codePointStart, codePointEnd: part.codePointEnd,
      text: points.slice(part.codePointStart, part.codePointEnd).join('') }
  })
  return { userPrompt: query, questionEvidence: { experiences: summaries, sources, coverage: descriptor.coverage,
    instruction: 'experiences.locator只是检索线索，不能作为结论引用；只引用sources中实际读到的文本，信息不足写入unresolved。' } }
}

function derive (store, snapshot, experiences, query, maximum) {
  const keys = queryKeys(query)
  ensureIndex(store, snapshot, experiences)
  const summaries = search(store, keys, 'experience', 16)
  const raw = search(store, keys, 'raw', 16)
  const events = new Map(snapshot.events.map((event, index) => [event.eventOrder, { ...event, index }]))
  const descriptors = new Map(experiences.map(row => [row.experience_id, row]))
  const orders = []
  const addOrder = order => { if (!orders.includes(order) && events.has(order)) orders.push(order) }
  for (const hit of raw) addOrder(Number(hit.key.slice(4)))
  for (const hit of summaries) {
    const ref = JSON.parse(descriptors.get(hit.key).source_ref_json)
    const selected = snapshot.events.filter(event => event.eventOrder >= ref.fromEventOrder && event.eventOrder <= ref.throughEventOrder)
    for (const event of [...selected.slice(0, 2), ...selected.slice(-2)]) addOrder(event.eventOrder)
  }
  // Late corrections can omit the nouns used in the original decision.
  for (const event of snapshot.events.slice(-2)) addOrder(event.eventOrder)
  for (const order of [...orders]) {
    const index = events.get(order).index
    if (index > 0) addOrder(snapshot.events[index - 1].eventOrder)
    if (index + 1 < snapshot.events.length) addOrder(snapshot.events[index + 1].eventOrder)
  }
  const plan = store.database.prepare(`SELECT plan.leaf_count,COUNT(range.range_id) AS completed FROM formal_agent_run_input_plans AS plan
    JOIN personal_context_episodes AS episode ON episode.ingest_run_id=plan.run_id
    LEFT JOIN personal_context_experience_ranges AS range ON range.run_id=plan.run_id
    WHERE episode.session_id=? AND episode.input_digest=? AND episode.lifecycle='active' AND plan.policy_version='experience-input@1'
    GROUP BY plan.run_id ORDER BY episode.created_at DESC LIMIT 1`).get(snapshot.sessionId, snapshot.inputDigest)
  const accessible = Boolean(store.automaticPolicy?.agentEnabled && store.automaticPolicy?.memoryEnabled)
  const descriptor = { experiences: [], parts: [], memoryAllowed: accessible, coverage: { mode: 'retrieval', scopeSessionCount: 1, visitedSessionCount: 1, omittedSessionCount: 0,
    experienceRangeCount: accessible && plan ? Number(plan.leaf_count) : null,
    experienceCompletedRangeCount: accessible && plan ? Number(plan.completed) : null,
    sourceTextComplete: false, summaryComplete: Boolean(accessible && plan && Number(plan.completed) === Number(plan.leaf_count)) } }
  const fits = () => Buffer.byteLength(JSON.stringify(canonicalize(restore(snapshot, experiences, descriptor, query)))) <= maximum
  if (!fits()) fail('AGENT_BUDGET_EXCEEDED')
  for (const hit of summaries) {
    descriptor.experiences.push({ experienceId: hit.key, productDigest: descriptors.get(hit.key).product_digest })
    if (!fits()) { descriptor.experiences.pop(); break }
  }
  for (const order of orders) {
    if (descriptor.parts.length >= 16) break
    const event = events.get(order)
    const points = Array.from(event.text)
    const match = keys.map(key => ({ key, at: normalize(event.text).indexOf(key) })).filter(value => value.at >= 0)
      .sort((left, right) => Array.from(right.key).length - Array.from(left.key).length)[0]
    let offset = 0
    if (match) {
      // Normalization can compose adjacent code points (e + combining acute),
      // expand ligatures, and collapse whitespace. Map against normalized
      // prefixes, rather than adding lengths of separately normalized points.
      let high = points.length
      while (offset < high) {
        const middle = Math.floor((offset + high) / 2)
        if (normalize(points.slice(0, middle).join('')).length < match.at) offset = middle + 1
        else high = middle
      }
    }
    const start = Math.max(0, offset - 256)
    descriptor.parts.push({ eventOrder: event.eventOrder, segmentId: event.segmentId, codePointStart: start, codePointEnd: Math.min(points.length, start + 1024) })
    if (!fits()) { descriptor.parts.pop(); continue }
  }
  descriptor.parts.sort((left, right) => left.eventOrder - right.eventOrder)
  return descriptor
}

function operate (store, request) {
  if (request?.action === 'freeze') return require('./question-scope-store').freeze(store, request)
  if (request?.action === 'projects') return require('./question-scope-store').projects(store, request)
  if (request?.action === 'positions') return require('./question-scope-store').positions(store, request)
  const retrieving = request?.action === 'retrieve'
  assertExactKeys(request, ['action', 'attemptIdentity', ...(retrieving ? ['query', 'maxPromptBytes'] : [])], 'AGENT_REQUEST_INVALID')
  if (!['retrieve', 'verify'].includes(request.action)) fail()
  const identity = store.assertAttempt(request.attemptIdentity)
  const db = store.database
  const run = db.prepare('SELECT * FROM formal_agent_runs WHERE run_id=?').get(identity.runId)
  store.assertActiveFormalAttempt(run, identity, store.nowValue(), { allowPreviouslyRenewedLease: true, allowCancelRequested: true })
  if (run.cancel_requested_at !== null) fail('AGENT_CANCELLED')
  if (run.recipe_id !== 'qa.answer' || !['4', '5'].includes(run.recipe_version)) fail()
  if (retrieving && (typeof request.query !== 'string' || request.query.length === 0 || Array.from(request.query).length > 4096 ||
      !Number.isSafeInteger(request.maxPromptBytes) || request.maxPromptBytes < 1024 || request.maxPromptBytes > 256 * 1024)) fail()
  const scope = JSON.parse(run.scope_json)
  const evidence = db.prepare('SELECT descriptor_json FROM formal_agent_question_evidence WHERE run_id=?').get(run.run_id)
  if (scope.kind !== 'session' || evidence && JSON.parse(evidence.descriptor_json).pages ||
      retrieving && require('./question-scope-store').strategy(request.query) !== 'retrieval') {
    return require('./question-scope-store').operate(store, request, run)
  }
  const snapshot = sourceForRun(store, run)
  if (snapshot.events.length > 50000 || Buffer.byteLength(canonicalize(snapshot.events)) > 8 * 1024 * 1024 ||
      snapshot.events.reduce((sum, event) => sum + Buffer.byteLength(event.text), 0) > 4 * 1024 * 1024) fail('AGENT_BUDGET_EXCEEDED')
  const experiences = experienceRows(store, snapshot)
  const prior = db.prepare('SELECT * FROM formal_agent_question_evidence WHERE run_id=?').get(identity.runId)
  if (prior && JSON.parse(prior.descriptor_json).memoryAllowed &&
      (!store.automaticPolicy?.agentEnabled || !store.automaticPolicy?.memoryEnabled)) fail('AGENT_INPUT_CHANGED')
  if (!retrieving) {
    if (!prior) fail('AGENT_RUN_UNAVAILABLE')
    restore(snapshot, experiences, JSON.parse(prior.descriptor_json), '')
    return { coverage: JSON.parse(prior.coverage_json), sourceRefs: JSON.parse(prior.source_refs_json) }
  }
  if (typeof request.query !== 'string' || request.query.length === 0 || Array.from(request.query).length > 4096 ||
      !Number.isSafeInteger(request.maxPromptBytes) || request.maxPromptBytes < 1024 || request.maxPromptBytes > 256 * 1024) fail()
  const queryDigest = sha256Canonical(request.query)
  if (prior && prior.query_digest !== queryDigest) fail('AGENT_REQUEST_IDENTITY_CONFLICT')
  const descriptor = prior ? JSON.parse(prior.descriptor_json) : derive(store, snapshot, experiences, request.query, request.maxPromptBytes)
  const payload = restore(snapshot, experiences, descriptor, request.query)
  const prompt = canonicalize(payload)
  const evidenceDigest = sha256Canonical(payload)
  if (Buffer.byteLength(JSON.stringify(prompt)) > request.maxPromptBytes) fail('AGENT_BUDGET_EXCEEDED')
  if (prior && prior.evidence_digest !== evidenceDigest) fail('AGENT_INPUT_CHANGED')
  const sourceRefs = payload.questionEvidence.sources.map(source => source.sourceRef)
  if (!prior) db.prepare(`INSERT INTO formal_agent_question_evidence
    (run_id,query_digest,evidence_digest,descriptor_json,source_refs_json,coverage_json,created_at) VALUES (?,?,?,?,?,?,?)`)
    .run(identity.runId, queryDigest, evidenceDigest, canonicalize(descriptor), canonicalize(sourceRefs), canonicalize(descriptor.coverage), store.nowValue())
  return { prompt, evidenceDigest, sourceRefs, coverage: descriptor.coverage, memoryAllowed: descriptor.memoryAllowed, inputDigest: snapshot.inputDigest,
    segmentCount: snapshot.events.length, rawTextBytes: snapshot.events.reduce((sum, event) => sum + Buffer.byteLength(event.text), 0),
    canonicalBytes: Buffer.byteLength(canonicalize(snapshot.events)) }
}

module.exports = { operate, queryKeys, sourceForRun, experienceRows, derive }

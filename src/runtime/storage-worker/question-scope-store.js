'use strict'

const { assertExactKeys, StorageError } = require('./protocol')
const { canonicalize, sha256Canonical } = require('./canonical-json')
const { rollbackQuietly } = require('./sqlite-store')
const local = () => require('./question-retrieval-store')
const fail = (code = 'AGENT_REQUEST_INVALID') => { throw new StorageError(code) }
const allowed = store => Boolean(store.automaticPolicy?.agentEnabled && store.automaticPolicy?.memoryEnabled)

function strategy (query) {
  if (/(?:多少|几次|几场|一共|总共|计数|总数|全部.{0,12}(?:列出|列举|清单)|(?:列出|列举).{0,12}(?:全部|所有)|每个|逐一|从未|有没有|有无|是否.{0,10}(?:提到|出现|曾经)|\b(?:count|every|never|ever|enumerate|any mention|how many|list all)\b)/iu.test(query)) return 'full_scan'
  if (/(?:全局|总体|趋势|共同主题|所有会话|全部会话|跨会话.{0,12}(?:总结|回顾)|\b(?:global|overall|all sessions|trend)\b)/iu.test(query)) return 'global'
  return 'retrieval'
}

function freeze (store, request) {
  assertExactKeys(request, ['action', 'scope'], 'AGENT_REQUEST_INVALID')
  assertExactKeys(request.scope, ['kind', 'reference'], 'AGENT_REQUEST_INVALID')
  const { kind, reference } = request.scope
  let condition; let args
  if (kind === 'date_range') {
    const match = /^date\.(\d+)\.(\d+)$/.exec(reference)
    if (!match || !Number.isSafeInteger(Number(match[1])) || !Number.isSafeInteger(Number(match[2])) || Number(match[1]) >= Number(match[2])) fail()
    condition = 'session.started_at>=? AND session.started_at<?'; args = [Number(match[1]), Number(match[2])]
  } else if (kind === 'project') {
    if (!allowed(store)) fail('AGENT_PERMISSION_DENIED')
    const project = store.database.prepare("SELECT 1 FROM personal_context_scopes WHERE scope_id=? AND kind='project' AND lifecycle='active'").get(reference)
    if (!project) fail()
    condition = `EXISTS (SELECT 1 FROM personal_context_session_associations AS association
      JOIN personal_context_items AS memory ON memory.memory_id=association.memory_id
      JOIN personal_context_episodes AS episode ON episode.episode_id=association.episode_id
      WHERE episode.session_id=session.session_id AND episode.lifecycle='active' AND memory.scope_id=?
        AND memory.lifecycle='active' AND memory.origin='explicit' AND memory.current_revision_id=association.revision_id)`
    args = [reference]
  } else fail()
  const sources = []; let after = ''
  while (true) {
    const page = store.database.prepare(`SELECT session.session_id FROM sessions AS session
      WHERE session.state IN ('closed','interrupted') AND session.ended_at IS NOT NULL AND session.session_id>?
        AND EXISTS(SELECT 1 FROM segments WHERE segments.session_id=session.session_id) AND ${condition}
      ORDER BY session.session_id LIMIT 128`).all(after, ...args)
    if (!page.length) break
    for (const row of page) {
      const size = store.database.prepare(`SELECT COUNT(*) AS n,COALESCE(SUM(length(CAST(event.text AS BLOB))),0) AS bytes
        FROM segments AS segment JOIN caption_events AS event ON event.event_order=segment.first_event_order WHERE segment.session_id=?`).get(row.session_id)
      if (Number(size.n) > 50000 || Number(size.bytes) > 4 * 1024 * 1024 || sources.length >= 50000) fail('AGENT_BUDGET_EXCEEDED')
      const source = store.deriveSessionSource({ sessionId: row.session_id, transcriptVersion: 'raw' })
      sources.push({ sessionId: row.session_id, inputDigest: source.inputDigest, inputWatermark: source.inputWatermark })
    }
    after = page.at(-1).session_id
  }
  if (!sources.length) fail('AGENT_INPUT_EMPTY')
  if (Buffer.byteLength(canonicalize(sources)) > 8 * 1024 * 1024) fail('AGENT_BUDGET_EXCEEDED')
  const inputDigest = sha256Canonical({ scope: request.scope, sources })
  const db = store.database; db.exec('BEGIN IMMEDIATE')
  try {
    db.prepare('INSERT OR IGNORE INTO formal_agent_question_scopes(input_digest,scope_json,source_count,created_at) VALUES(?,?,?,?)')
      .run(inputDigest, canonicalize(request.scope), sources.length, store.nowValue())
    const insert = db.prepare('INSERT OR IGNORE INTO formal_agent_question_scope_sources(input_digest,ordinal,session_id,source_digest,watermark) VALUES(?,?,?,?,?)')
    sources.forEach((source, index) => insert.run(inputDigest, index, source.sessionId, source.inputDigest, source.inputWatermark))
    db.exec('COMMIT')
  } catch (error) { rollbackQuietly(db); throw error }
  return { sourceKind: 'session', sessionId: reference, transcriptVersion: 'raw', inputWatermark: 1, inputDigest, scopeSessionCount: sources.length }
}

function snapshots (store, run) {
  const scope = JSON.parse(run.scope_json)
  if (scope.kind === 'session') return [local().sourceForRun(store, run)]
  if (scope.kind === 'project' && !allowed(store)) fail('AGENT_INPUT_CHANGED')
  const manifest = store.database.prepare('SELECT * FROM formal_agent_question_scopes WHERE input_digest=?').get(run.input_digest)
  if (!manifest || manifest.scope_json !== canonicalize(scope)) fail('AGENT_INPUT_CHANGED')
  const results = []; let after = -1; let totalBytes = 0; let count = 0
  while (true) {
    const page = store.database.prepare('SELECT * FROM formal_agent_question_scope_sources WHERE input_digest=? AND ordinal>? ORDER BY ordinal LIMIT 128').all(run.input_digest, after)
    if (!page.length) break
    for (const row of page) {
      if (scope.kind === 'project') {
        const valid = store.sessionAssociations(row.session_id).some(item => {
          const memory = store.memoryRow(item.memoryRef.memoryId)
          return memory?.scope_id === scope.reference
        })
        if (!valid) fail('AGENT_INPUT_CHANGED')
      }
      let snapshot
      try { snapshot = local().sourceForRun(store, { ...run, scope_json: canonicalize({ kind: 'session', reference: row.session_id }),
        input_digest: row.source_digest, input_watermark_json: canonicalize({ throughEventOrder: Number(row.watermark) }) }) } catch (error) {
        if (error.code === 'AGENT_BUDGET_EXCEEDED') throw error
        fail('AGENT_INPUT_CHANGED')
      }
      totalBytes += snapshot.events.reduce((sum, event) => sum + Buffer.byteLength(event.text), 0); count += snapshot.events.length
      if (totalBytes > 4 * 1024 * 1024 || count > 50000) fail('AGENT_BUDGET_EXCEEDED')
      results.push(snapshot)
    }
    after = Number(page.at(-1).ordinal)
  }
  if (results.length !== Number(manifest.source_count)) fail('AGENT_INPUT_CHANGED')
  if (results.reduce((sum, source) => sum + Buffer.byteLength(canonicalize(source.events)), 0) > 8 * 1024 * 1024) fail('AGENT_BUDGET_EXCEEDED')
  return results
}

function restorePage (sources, experiences, descriptor, query, coverage) {
  const events = new Map(sources.flatMap(source => source.events.map(event => [`${source.sessionId}:${event.eventOrder}`, event])))
  const sessionDates = new Map(sources.map(source => [source.sessionId, new Date(source.startedAt).toISOString()]))
  const byId = new Map(experiences.map(row => [row.experience_id, row]))
  return { userPrompt: query, questionEvidence: {
    experiences: descriptor.experiences.map(ref => {
      const row = byId.get(ref.experienceId)
      if (!row || row.product_digest !== ref.productDigest) fail('AGENT_INPUT_CHANGED')
      const locator = JSON.parse(row.source_ref_json)
      return { experienceId: row.experience_id, kind: row.kind, text: row.text, locator, sessionStartedAt: sessionDates.get(locator.sessionId),
        fromOffsetMs: Number(row.occurred_from_offset_ms), throughOffsetMs: Number(row.occurred_through_offset_ms) }
    }),
    sources: descriptor.parts.map(part => {
      const event = events.get(`${part.sessionId}:${part.eventOrder}`)
      if (!event || event.segmentId !== part.segmentId) fail('AGENT_INPUT_CHANGED')
      const points = Array.from(event.text)
      if (part.codePointStart < 0 || part.codePointEnd > points.length) fail('AGENT_INPUT_CHANGED')
      return { sourceRef: { sessionId: part.sessionId, transcriptVersion: 'raw', fromEventOrder: part.eventOrder, throughEventOrder: part.eventOrder },
        sessionStartedAt: sessionDates.get(part.sessionId),
        segmentId: part.segmentId, codePointStart: part.codePointStart, codePointEnd: part.codePointEnd, text: points.slice(part.codePointStart, part.codePointEnd).join('') }
    }), coverage, instruction: '这里只是冻结目录的一页。经历是检索线索，结论引用必须来自实际原文；不要将本页未发现解释为整个范围不存在。保留否定、日期及修订。coverage由宿主填写。'
  } }
}

function buildPages (store, sources, experiences, query, mode, maximum, coverage) {
  const pages = []; let current = { experiences: [], parts: [] }
  const fits = value => Buffer.byteLength(JSON.stringify(canonicalize(restorePage(sources, experiences, value, query, coverage)))) <= maximum
  const add = (field, value) => {
    const next = { experiences: [...current.experiences], parts: [...current.parts] }; next[field].push(value)
    if (next.parts.length > 16 || next.experiences.length > 16 || !fits(next)) {
      if (!current.parts.length && !current.experiences.length) fail('AGENT_BUDGET_EXCEEDED')
      pages.push(current); current = { experiences: [], parts: [] }; current[field].push(value)
      if (!fits(current)) fail('AGENT_BUDGET_EXCEEDED')
    } else current = next
    if (pages.length >= 256) fail('AGENT_BUDGET_EXCEEDED')
  }
  for (const source of sources) {
    const rows = experiences.filter(row => JSON.parse(row.source_ref_json).sessionId === source.sessionId)
    if (mode === 'retrieval') {
      const descriptor = local().derive(store, source, rows, query, maximum)
      descriptor.experiences.forEach(ref => add('experiences', ref))
      descriptor.parts.forEach(part => add('parts', { ...part, sessionId: source.sessionId }))
    } else if (mode === 'full_scan') {
      for (const event of source.events) {
        const count = Array.from(event.text).length
        for (let start = 0; start < count || start === 0; start += 1024) add('parts', {
          sessionId: source.sessionId, eventOrder: event.eventOrder, segmentId: event.segmentId, codePointStart: start, codePointEnd: Math.min(count, start + 1024) })
      }
    } else {
      for (const row of rows) {
        add('experiences', { experienceId: row.experience_id, productDigest: row.product_digest })
        const ref = JSON.parse(row.source_ref_json)
        for (const order of new Set([ref.fromEventOrder, ref.throughEventOrder])) {
          const event = source.events.find(event => event.eventOrder === order)
          if (event) add('parts', { sessionId: source.sessionId, eventOrder: order, segmentId: event.segmentId, codePointStart: 0, codePointEnd: Math.min(1024, Array.from(event.text).length) })
        }
      }
      if (!rows.length) for (const event of [source.events[0], source.events.at(-1)]) if (event) add('parts', {
        sessionId: source.sessionId, eventOrder: event.eventOrder, segmentId: event.segmentId, codePointStart: 0, codePointEnd: Math.min(1024, Array.from(event.text).length) })
    }
  }
  if (current.parts.length || current.experiences.length) pages.push(current)
  return pages
}

function operate (store, request, run) {
  const db = store.database; const retrieving = request.action === 'retrieve'
  const sources = snapshots(store, run)
  const experiences = sources.flatMap(source => local().experienceRows(store, source))
  const prior = db.prepare('SELECT * FROM formal_agent_question_evidence WHERE run_id=?').get(run.run_id)
  if (prior && JSON.parse(prior.descriptor_json).memoryAllowed && !allowed(store)) fail('AGENT_INPUT_CHANGED')
  if (!retrieving && !prior) fail('AGENT_RUN_UNAVAILABLE')
  const queryDigest = retrieving ? sha256Canonical(request.query) : prior.query_digest
  if (prior && prior.query_digest !== queryDigest) fail('AGENT_REQUEST_IDENTITY_CONFLICT')
  const mode = prior ? JSON.parse(prior.coverage_json).mode : strategy(request.query)
  const complete = sources.map(source => local().derive(store, source, experiences.filter(row => JSON.parse(row.source_ref_json).sessionId === source.sessionId), '', 256 * 1024).coverage)
  const coverage = prior ? JSON.parse(prior.coverage_json) : { mode, scopeSessionCount: sources.length, visitedSessionCount: sources.length, omittedSessionCount: 0,
    experienceRangeCount: complete.every(item => item.experienceRangeCount !== null) ? complete.reduce((sum, item) => sum + item.experienceRangeCount, 0) : null,
    experienceCompletedRangeCount: complete.every(item => item.experienceRangeCount !== null) ? complete.reduce((sum, item) => sum + item.experienceCompletedRangeCount, 0) : null,
    sourceTextComplete: mode === 'full_scan', summaryComplete: complete.every(item => item.summaryComplete) }
  const descriptors = prior ? db.prepare('SELECT * FROM formal_agent_question_evidence_pages WHERE run_id=? ORDER BY ordinal').all(run.run_id)
    : buildPages(store, sources, experiences, request.query, mode, request.maxPromptBytes, coverage).map((descriptor, ordinal) => ({ ordinal, descriptor_json: canonicalize(descriptor) }))
  if (!descriptors.length || descriptors.length > 256) fail('AGENT_BUDGET_EXCEEDED')
  if (prior) {
    const frozen = JSON.parse(prior.descriptor_json)
    const identity = sources.map(source => ({ sessionId: source.sessionId, inputDigest: source.inputDigest, inputWatermark: source.inputWatermark }))
    if (canonicalize(identity) !== canonicalize(frozen.scopeSources) || canonicalize(frozen.coverage) !== canonicalize(coverage) ||
        frozen.pages?.length !== descriptors.length || sha256Canonical(frozen.pages) !== prior.evidence_digest) fail('AGENT_INPUT_CHANGED')
    for (const [ordinal, row] of descriptors.entries()) {
      const expected = frozen.pages[ordinal]
      if (Number(row.ordinal) !== ordinal || expected.ordinal !== ordinal || row.evidence_digest !== expected.evidenceDigest ||
          sha256Canonical(JSON.parse(row.descriptor_json)) !== expected.descriptorDigest) fail('AGENT_INPUT_CHANGED')
    }
  }
  const leaves = descriptors.map(row => {
    const descriptor = JSON.parse(row.descriptor_json)
    const payload = restorePage(sources, experiences, descriptor, retrieving ? request.query : '', coverage)
    const prompt = canonicalize(payload); const evidenceDigest = sha256Canonical(payload)
    if (retrieving && Buffer.byteLength(JSON.stringify(prompt)) > request.maxPromptBytes) fail('AGENT_BUDGET_EXCEEDED')
    if (retrieving && row.evidence_digest && row.evidence_digest !== evidenceDigest) fail('AGENT_INPUT_CHANGED')
    return { prompt: retrieving ? prompt : '', evidenceDigest, sourceRefs: payload.questionEvidence.sources.map(source => source.sourceRef) }
  })
  const sourceRefs = [...new Map(leaves.flatMap(leaf => leaf.sourceRefs).map(ref => [canonicalize(ref), ref])).values()]
  if (!prior) {
    const descriptor = { memoryAllowed: allowed(store), scopeSources: sources.map(source => ({ sessionId: source.sessionId, inputDigest: source.inputDigest, inputWatermark: source.inputWatermark })),
      pages: leaves.map((leaf, ordinal) => ({ ordinal, evidenceDigest: leaf.evidenceDigest, descriptorDigest: sha256Canonical(JSON.parse(descriptors[ordinal].descriptor_json)) })), coverage }
    if (Buffer.byteLength(canonicalize(descriptor)) > 65536 || Buffer.byteLength(canonicalize(sourceRefs)) > 65536) fail('AGENT_BUDGET_EXCEEDED')
    db.exec('BEGIN IMMEDIATE')
    try {
      db.prepare(`INSERT INTO formal_agent_question_evidence(run_id,query_digest,evidence_digest,descriptor_json,source_refs_json,coverage_json,created_at) VALUES(?,?,?,?,?,?,?)`)
        .run(run.run_id, queryDigest, sha256Canonical(descriptor.pages), canonicalize(descriptor), canonicalize(sourceRefs), canonicalize(coverage), store.nowValue())
      const insert = db.prepare('INSERT INTO formal_agent_question_evidence_pages(run_id,ordinal,descriptor_json,evidence_digest) VALUES(?,?,?,?)')
      descriptors.forEach((row, index) => insert.run(run.run_id, index, row.descriptor_json, leaves[index].evidenceDigest))
      db.exec('COMMIT')
    } catch (error) { rollbackQuietly(db); throw error }
  }
  if (!retrieving) return { sourceRefs, coverage }
  return { prompt: leaves[0].prompt, leaves, userPrompt: request.query, sourceRefs, coverage, memoryAllowed: run.recipe_version === '5' && allowed(store),
    evidenceDigest: prior?.evidence_digest || sha256Canonical(leaves.map((leaf, ordinal) => ({ ordinal, evidenceDigest: leaf.evidenceDigest, descriptorDigest: sha256Canonical(JSON.parse(descriptors[ordinal].descriptor_json)) }))),
    inputDigest: run.input_digest, segmentCount: sources.reduce((sum, source) => sum + source.events.length, 0),
    rawTextBytes: sources.reduce((sum, source) => sum + source.events.reduce((size, event) => size + Buffer.byteLength(event.text), 0), 0),
    canonicalBytes: sources.reduce((sum, source) => sum + Buffer.byteLength(canonicalize(source.events)), 0) }
}

function projects (store, request) {
  assertExactKeys(request, ['action', 'after', 'limit'], 'AGENT_REQUEST_INVALID')
  if (typeof request.after !== 'string' || request.after.length > 160 || !Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > 50) fail()
  const rows = allowed(store) ? store.database.prepare("SELECT scope_id,label FROM personal_context_scopes WHERE kind='project' AND lifecycle='active' AND scope_id>? ORDER BY scope_id LIMIT ?").all(request.after, request.limit + 1) : []
  return { items: rows.slice(0, request.limit), next: rows.length > request.limit ? rows[request.limit - 1].scope_id : null }
}

function positions (store, request) {
  assertExactKeys(request, ['action', 'runId'], 'AGENT_REQUEST_INVALID')
  const row = store.database.prepare("SELECT interaction.result_json FROM formal_agent_interactions AS interaction JOIN formal_agent_runs AS run ON run.run_id=interaction.run_id WHERE run.run_id=? AND run.state='succeeded' AND run.recipe_id='qa.answer' AND run.recipe_version IN ('4','5')").get(request.runId)
  if (!row?.result_json) return []
  return JSON.parse(row.result_json).sourceRefs.flatMap(sourceRef => {
    const times = store.database.prepare(`SELECT session.started_at,first.t0_ms,last.t1_ms FROM sessions AS session
      JOIN caption_events AS first ON first.session_id=session.session_id AND first.event_order=? AND first.kind='final'
      JOIN caption_events AS last ON last.session_id=session.session_id AND last.event_order=? AND last.kind='final'
      WHERE session.session_id=?`).get(sourceRef.fromEventOrder, sourceRef.throughEventOrder, sourceRef.sessionId)
    return times ? [{ sourceRef, sessionStartedAt: new Date(Number(times.started_at)).toISOString(),
      fromOffsetMs: Number(times.t0_ms), throughOffsetMs: Number(times.t1_ms) }] : []
  })
}

module.exports = { freeze, operate, strategy, projects, positions }

'use strict'

const {
  CONTRACT_ID,
  CONTRACT_VERSION,
  ERROR_CODES,
  ERROR_RULES,
  MAX_SCOPE_DIRECTORY_ITEMS,
  assertChangedEvent,
  assertGetOverviewRequest,
  assertGetOverviewResponse,
  assertManageRequest,
  assertManageResponse
} = require('../contracts/agent-context-ui')

function checkedRevision (value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError('revision must be a non-negative safe integer')
  return value
}

function sumRevisions (contentRevision, settingsRevision) {
  const sum = checkedRevision(contentRevision) + checkedRevision(settingsRevision)
  return checkedRevision(sum)
}

function publicError (code, currentRevision = null) {
  const rule = ERROR_RULES[code] || ERROR_RULES[ERROR_CODES.operationFailed]
  return {
    category: rule.category,
    code: ERROR_RULES[code] ? code : ERROR_CODES.operationFailed,
    current_revision: code === ERROR_CODES.revisionConflict ? checkedRevision(currentRevision) : null,
    next_action: rule.next_action,
    retry_policy: rule.retry_policy
  }
}

function header () {
  return { contract_id: CONTRACT_ID, contract_version: CONTRACT_VERSION }
}

function scopeProjection (scope) {
  return {
    kind: scope.kind,
    label: scope.kind === 'global' ? '全局' : String(scope.label),
    reference: scope.reference
  }
}

function timestamp (value) {
  return new Date(checkedRevision(value)).toISOString()
}

function memoryProjection (item) {
  return {
    display_text: item.display_text,
    kind: item.kind,
    lifecycle: item.lifecycle,
    memory_id: item.memory_id,
    origin: item.origin,
    revision: checkedRevision(item.item_revision),
    scope: scopeProjection(item.scope),
    source_reference_count: checkedRevision(item.sourceReferenceCount),
    updated_at: timestamp(item.updatedAt)
  }
}

function episodeProjection (episode) {
  return {
    episode_id: episode.episode_id,
    lifecycle: 'active',
    occurred_from_offset_ms: checkedRevision(episode.occurredFromOffsetMs),
    occurred_through_offset_ms: checkedRevision(episode.occurredThroughOffsetMs),
    omissions: episode.omissions,
    scope: scopeProjection(episode.scope),
    source_kind: episode.sourceKind,
    source_reference_count: checkedRevision(episode.sourceReferenceCount),
    summary: episode.summary,
    updated_at: timestamp(episode.updatedAt)
  }
}

function scopeDirectoryProjection (page) {
  return {
    has_more: page.hasMore,
    items: page.rows.map((scope) => ({
      display_name: scope.displayName,
      kind: scope.kind,
      scope_id: scope.scopeId
    }))
  }
}

function processingProjection (config) {
  const enabled = config.memoryEnabled === true
  return {
    automatic_processing_boundary: enabled && config.agentEnabled === true && config.memoryProcessingSince !== null
      ? 'current_effective_cycle'
      : 'not_established',
    state: enabled ? 'enabled' : 'suspended'
  }
}

function storageErrorCode (error) {
  const code = error?.code
  if (Object.values(ERROR_CODES).includes(code)) return code
  if (code === 'AGENT_REQUEST_INVALID') return ERROR_CODES.requestInvalid
  return ERROR_CODES.operationFailed
}

class PersonalContextController {
  constructor (options = {}) {
    if (!options.module || typeof options.module.manage !== 'function') throw new TypeError('module is required')
    if (typeof options.readScopeDirectory !== 'function') throw new TypeError('scope directory reader is required')
    if (typeof options.getConfig !== 'function' || typeof options.updateAgentSettings !== 'function') {
      throw new TypeError('config accessors are required')
    }
    this.module = options.module
    this.readScopeDirectory = options.readScopeDirectory
    this.getConfig = options.getConfig
    this.updateAgentSettings = options.updateAgentSettings
    this.onChanged = typeof options.onChanged === 'function' ? options.onChanged : () => {}
    this.tail = Promise.resolve()
    this.requestSequence = 0
  }

  serial (operation) {
    const next = this.tail.then(operation, operation)
    this.tail = next.catch(() => {})
    return next
  }

  async state () {
    const memories = await this.storageManage({ type: 'view', resource: 'personal_memories', limit: 20, cursor: null })
    const episodes = await this.storageManage({ type: 'view', resource: 'session_episodes', limit: 20, cursor: null })
    const scopes = await this.readScopeDirectory({
      type: 'view', resource: 'scope_directory', limit: MAX_SCOPE_DIRECTORY_ITEMS, cursor: null
    })
    if (memories.revision !== episodes.revision || memories.revision !== scopes.revision) {
      throw new Error('personal context view revision changed during read')
    }
    const config = this.getConfig()
    return {
      config,
      contentRevision: checkedRevision(memories.revision),
      publicRevision: sumRevisions(memories.revision, config.agentSettingsRevision),
      memories,
      episodes,
      scopes
    }
  }

  storageManage (command) {
    this.requestSequence += 1
    return this.module.manage({
      ...header(),
      request_id: `controller.${this.requestSequence}`,
      command
    })
  }

  getOverview (request) {
    return this.serial(async () => {
      try {
        assertGetOverviewRequest(request)
        const state = await this.state()
        const response = {
          ...header(), ok: true, error: null,
          snapshot: {
            counts: {
              personal_memories: state.memories.totalCount,
              session_episodes: state.episodes.totalCount
            },
            eligibility: 'provider_not_configured',
            memory_processing: processingProjection(state.config),
            revision: state.publicRevision,
            scope_directory: scopeDirectoryProjection(state.scopes)
          }
        }
        return assertGetOverviewResponse(response)
      } catch (error) {
        const response = { ...header(), ok: false, error: publicError(error instanceof TypeError ? ERROR_CODES.requestInvalid : ERROR_CODES.unavailable), snapshot: null }
        return assertGetOverviewResponse(response)
      }
    })
  }

  manage (request) {
    return this.serial(async () => {
      try {
        assertManageRequest(request)
      } catch {
        return assertManageResponse({ ...header(), ok: false, error: publicError(ERROR_CODES.requestInvalid), result: null, revision: null })
      }
      try {
        const command = request.command
        if (command.type === 'view') return await this.view(command)
        const state = await this.state()

        if (command.expected_revision !== state.publicRevision) {
          if (command.type === 'delete') {
            try {
              const replay = await this.storageManage({ ...command, expected_revision: state.contentRevision + 1 })
              if (replay.replayed) return this.success(command, replay, state.publicRevision)
            } catch { /* a non-replay remains a conflict with zero writes */ }
          }
          return this.failure(ERROR_CODES.revisionConflict, state.publicRevision)
        }

        if (command.type === 'set_processing') return this.setProcessing(command, state)
        const result = await this.storageManage({ ...command, expected_revision: state.contentRevision })
        const publicRevision = sumRevisions(result.revision, state.config.agentSettingsRevision)
        const response = this.success(command, result, publicRevision)
        if (!result.replayed && publicRevision > state.publicRevision) this.changed(publicRevision)
        return response
      } catch (error) {
        if (error?.code === 'AGENT_CONTEXT_REVISION_CONFLICT') {
          try { return this.failure(ERROR_CODES.revisionConflict, (await this.state()).publicRevision) } catch { /* unavailable below */ }
        }
        return this.failure(storageErrorCode(error), null)
      }
    })
  }

  async view (command) {
    const page = await this.storageManage(command)
    const config = this.getConfig()
    const items = page.rows.map(command.resource === 'personal_memories' ? memoryProjection : episodeProjection)
    return assertManageResponse({
      ...header(), ok: true, error: null,
      revision: sumRevisions(page.revision, config.agentSettingsRevision),
      result: {
        kind: command.resource === 'personal_memories' ? 'memory_page' : 'episode_page',
        items,
        has_more: page.hasMore,
        next_cursor: page.nextCursor
      }
    })
  }

  setProcessing (command, state) {
    const enabled = command.state === 'enabled'
    if (enabled === state.config.memoryEnabled) {
      return assertManageResponse({
        ...header(), ok: true, error: null, revision: state.publicRevision,
        result: { kind: 'processing', operation: 'set_processing', memory_processing: processingProjection(state.config) }
      })
    }
    const updated = this.updateAgentSettings({
      expectedRevision: state.config.agentSettingsRevision,
      agentEnabled: state.config.agentEnabled,
      memoryEnabled: enabled,
      cloudDisclosureAccepted: state.config.cloudDisclosureAccepted
    })
    const publicRevision = sumRevisions(state.contentRevision, updated.agentSettingsRevision)
    const response = assertManageResponse({
      ...header(), ok: true, error: null, revision: publicRevision,
      result: { kind: 'processing', operation: 'set_processing', memory_processing: processingProjection(updated) }
    })
    this.changed(publicRevision)
    return response
  }

  success (command, result, publicRevision) {
    let projected
    if (command.type === 'delete') {
      projected = { kind: 'deletion', operation: 'delete', replayed: result.replayed, deleted: result.deleted }
    } else {
      projected = { kind: 'memory_item', operation: command.type, item: memoryProjection(result.item) }
    }
    return assertManageResponse({ ...header(), ok: true, error: null, result: projected, revision: publicRevision })
  }

  failure (code, currentRevision) {
    const conflict = code === ERROR_CODES.revisionConflict
    return assertManageResponse({
      ...header(), ok: false, error: publicError(code, currentRevision), result: null,
      revision: conflict ? currentRevision : null
    })
  }

  changed (revision) {
    const event = assertChangedEvent({ ...header(), revision })
    try { this.onChanged(event) } catch { /* observers cannot affect the committed command */ }
  }
}

module.exports = {
  PersonalContextController,
  processingProjection,
  scopeDirectoryProjection,
  sumRevisions
}

'use strict'

const READINESS = new Set(['ready', 'provider_not_configured', 'credential_unavailable', 'local_model_not_ready'])

/**
 * Resolve the automatic session-ingest gate from already-frozen facts.
 * Storage owns transcript facts, ConfigStore owns boundaries, and Model Access
 * owns provider readiness; this function only applies their product ordering.
 */
function evaluateAutomaticEligibility ({ session, segmentCount, settings, catalog }) {
  if (!session || typeof session !== 'object' || Array.isArray(session)) return 'session_not_terminal'
  if (!['closed', 'interrupted'].includes(session.state) || session.endedAt === null) return 'session_not_terminal'
  if (!Number.isSafeInteger(Number(session.endedAt))) return 'session_not_terminal'
  if (!Number.isSafeInteger(segmentCount) || segmentCount < 1) return 'no_committed_transcript'
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return 'provider_not_configured'
  const endedAt = Number(session.endedAt)
  if (settings.agentEnabled !== true && settings.automaticProcessingSince === null) return 'agent_disabled'
  if (settings.automaticProcessingSince === null ||
      endedAt < settings.automaticProcessingSince ||
      settings.memoryEnabled !== true || settings.memoryProcessingSince === null ||
      endedAt < settings.memoryProcessingSince) {
    return 'outside_automatic_window'
  }
  if (settings.agentEnabled !== true) return 'agent_disabled'
  if (!catalog || catalog.ok !== true) return 'provider_not_configured'
  const readiness = catalog.snapshot?.readinessByPurpose?.information_extraction
  if (!readiness || !READINESS.has(readiness.agentLoop)) return 'provider_not_configured'
  if (readiness.providerKind === 'cloud' && settings.cloudDisclosureAccepted !== true) {
    return 'cloud_disclosure_required'
  }
  return readiness.agentLoop
}

module.exports = { evaluateAutomaticEligibility }

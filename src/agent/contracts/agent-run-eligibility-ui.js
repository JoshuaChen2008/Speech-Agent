'use strict'

/* Compatibility projection for the original S3 eligibility-only import.
   The signed definition lives in agent-run-ui.js so the two surfaces cannot drift. */
const c = require('./agent-run-ui')

module.exports = Object.freeze({
  ALLOWED_ROLES: c.ALLOWED_ROLES,
  CONTRACT_ID: c.CONTRACT_ID,
  CONTRACT_VERSION: c.CONTRACT_VERSION,
  ELIGIBILITY_STATES: c.ELIGIBILITY_STATES,
  ERROR_CODES: Object.freeze({ unavailable: c.ERROR_CODES.unavailable }),
  IPC_CHANNELS: Object.freeze({ changed: c.IPC_CHANNELS.changed, getEligibility: c.IPC_CHANNELS.getEligibility }),
  SCOPE_KINDS: c.SCOPE_KINDS,
  assertChangedEvent: c.assertChangedEvent,
  assertFixturePrivacy: c.assertFixturePrivacy,
  assertGetEligibilityRequest: c.assertGetEligibilityRequest,
  assertGetEligibilityResponse: c.assertGetEligibilityResponse,
  assertScope: c.scope,
  assertSnapshot: c.assertSnapshot,
  isSupportedContract: c.isSupportedContract
})

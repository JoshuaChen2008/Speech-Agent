'use strict'

const PUBLIC_CODES = Object.freeze(['PERMISSION_DENIED', 'NLS_SESSION_ACTIVE', 'NLS_SETTINGS_CONFLICT',
  'NLS_INVALID_SETTINGS', 'NLS_DISCLOSURE_REQUIRED', 'NLS_SETTINGS_UNAVAILABLE', 'NLS_CONFIGURATION_REQUIRED',
  'NLS_AUTH_FAILED', 'NLS_CLOCK_INVALID', 'NLS_TOKEN_UNAVAILABLE', 'NLS_CANCELLED', 'NLS_CONFIGURATION_CHANGED', 'NLS_CREDENTIAL_CLEANUP_REQUIRED'])
function invalid () { throw Object.assign(new TypeError('Invalid recognition settings contract'), { code: 'NLS_INVALID_SETTINGS' }) }
function object (value, required, optional = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || required.some(k => !Object.hasOwn(value, k)) || Object.keys(value).some(k => !required.includes(k) && !optional.includes(k))) invalid()
}
function text (value, max, empty = true) { if (typeof value !== 'string' || value !== value.trim() || (!empty && !value) || value.length > max || /[\x00-\x1f\x7f]/.test(value)) invalid() }
function common (value) {
  if (!['local-only', 'cloud-primary'].includes(value.strategy) || typeof value.cloudDisclosureAccepted !== 'boolean') invalid()
  text(value.appKey, 256); text(value.modelLabel, 160)
}
function assertUpdateRequest (value) {
  object(value, ['expectedRevision', 'strategy', 'appKey', 'modelLabel', 'cloudDisclosureAccepted'], ['credential', 'clearCredential'])
  common(value)
  if (!Number.isSafeInteger(value.expectedRevision) || value.expectedRevision < 0) invalid()
  if (value.clearCredential !== undefined && typeof value.clearCredential !== 'boolean') invalid()
  if (value.credential !== undefined) {
    if (value.clearCredential) invalid()
    object(value.credential, ['accessKeyId', 'accessKeySecret'])
    text(value.credential.accessKeyId, 256, false); text(value.credential.accessKeySecret, 1024, false)
  }
  return value
}
function assertPublicSettings (value) {
  object(value, ['revision', 'strategy', 'appKey', 'modelLabel', 'cloudDisclosureAccepted', 'region', 'credential', 'loadError'])
  if (value.loadError !== null && !['NLS_SETTINGS_UNAVAILABLE', 'NLS_CREDENTIAL_CLEANUP_REQUIRED'].includes(value.loadError)) invalid()
  common(value)
  if (!Number.isSafeInteger(value.revision) || value.revision < 0 || value.region !== 'cn-shanghai') invalid()
  object(value.credential, ['present', 'scope'])
  if (typeof value.credential.present !== 'boolean' || !['absent', 'session_only', 'persistent'].includes(value.credential.scope) || value.credential.present !== (value.credential.scope !== 'absent')) invalid()
  return value
}
function assertResponse (value, verification = false) {
  if (value?.ok === false) {
    object(value, ['ok', 'code'])
    if (!PUBLIC_CODES.includes(value.code)) invalid()
  } else {
    object(value, ['ok', 'value'])
    if (value.ok !== true) invalid()
    if (verification) {
      object(value.value, ['verified', 'scope'])
      if (value.value.verified !== true || value.value.scope !== 'token-only') invalid()
    } else assertPublicSettings(value.value)
  }
  return value
}
module.exports = { PUBLIC_CODES, assertUpdateRequest, assertPublicSettings, assertResponse }

'use strict'

const NLS_PARAMETERS = Object.freeze({
  format: 'pcm', sample_rate: 16000, enable_intermediate_result: true,
  enable_punctuation_prediction: true, enable_inverse_text_normalization: false,
  enable_words: false, disfluency: false, enable_semantic_sentence_detection: false,
  max_sentence_silence: 800
})
const RECOGNITION_ERROR_CODES = Object.freeze([
  'NLS_AUTH_FAILED', 'NLS_PROJECT_INVALID', 'NLS_CONNECTION_FAILED', 'NLS_CONNECTION_CLOSED',
  'NLS_SERVICE_FAILED', 'NLS_INVALID_RESPONSE', 'NLS_HEARTBEAT_TIMEOUT', 'NLS_START_TIMEOUT',
  'NLS_STOP_TIMEOUT', 'NLS_BUFFER_EXCEEDED', 'NLS_CANCELLED',
  'RECOGNITION_BUFFER_LIMIT', 'RECOGNITION_AUDIO_GAP', 'RECOGNITION_FALLBACK_FAILED'
])

function exact (value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) {
    throw new TypeError('Invalid recognition data')
  }
}
function assertRecognitionBinding (value) {
  exact(value, ['strategy', 'provider', 'region', 'configRevision', 'projectRef', 'modelLabel', 'parameters'])
  if (!Number.isSafeInteger(value.configRevision) || value.configRevision < 0 ||
      typeof value.modelLabel !== 'string' || value.modelLabel.length > 160) throw new TypeError('Invalid recognition binding')
  if (value.strategy === 'local-only') {
    if (value.provider !== 'local' || value.region !== null || value.projectRef !== null || value.parameters !== null || value.modelLabel !== '') {
      throw new TypeError('Invalid local recognition binding')
    }
  } else if (value.strategy === 'cloud-primary') {
    if (value.provider !== 'nls' || value.region !== 'cn-shanghai' ||
        typeof value.projectRef !== 'string' || !/^[a-f0-9]{64}$/.test(value.projectRef)) throw new TypeError('Invalid cloud recognition binding')
    exact(value.parameters, Object.keys(NLS_PARAMETERS))
    if (Object.keys(NLS_PARAMETERS).some(key => value.parameters[key] !== NLS_PARAMETERS[key])) throw new TypeError('Invalid recognition parameters')
  } else throw new TypeError('Invalid recognition strategy')
  return value
}

function assertRecognitionStatus (value) {
  exact(value, ['sessionId', 'actualProvider', 'fallbackCode', 'fallbackAtMs', 'faultCode', 'faultAtMs'])
  if (typeof value.sessionId !== 'string' || value.sessionId.length < 1 || value.sessionId.length > 160 ||
      !['local', 'nls'].includes(value.actualProvider)) throw new TypeError('Invalid recognition status')
  for (const prefix of ['fallback', 'fault']) {
    const code = value[`${prefix}Code`]
    const at = value[`${prefix}AtMs`]
    if (code === null ? at !== null : !RECOGNITION_ERROR_CODES.includes(code) || !Number.isSafeInteger(at) || at < 0) {
      throw new TypeError('Invalid recognition failure')
    }
  }
  if (value.fallbackCode !== null && value.actualProvider !== 'local') throw new TypeError('Invalid recognition fallback')
  return value
}

function unknownRecognition () {
  return { resultStatus: 'not_recorded', binding: null, actualProvider: null,
    fallbackCode: null, fallbackAtMs: null, faultCode: null, faultAtMs: null }
}

function assertRecognitionMetadata (value) {
  exact(value, ['resultStatus', 'binding', 'actualProvider', 'fallbackCode', 'fallbackAtMs', 'faultCode', 'faultAtMs'])
  if (value.resultStatus === 'not_recorded') {
    if (Object.keys(value).some(key => key !== 'resultStatus' && value[key] !== null)) throw new TypeError('Invalid unknown recognition')
  } else if (value.resultStatus === 'known') {
    assertRecognitionBinding(value.binding)
    const { resultStatus, binding, ...status } = value
    assertRecognitionStatus({ sessionId: 'metadata', ...status })
    if (binding.provider === 'local' && (status.actualProvider !== 'local' || status.fallbackCode !== null)) throw new TypeError('Invalid local recognition status')
    if (binding.provider === 'nls' && (status.actualProvider === 'local') !== (status.fallbackCode !== null)) throw new TypeError('Invalid cloud recognition status')
  } else throw new TypeError('Invalid recognition result status')
  return value
}

module.exports = { NLS_PARAMETERS, RECOGNITION_ERROR_CODES, assertRecognitionBinding,
  assertRecognitionStatus, assertRecognitionMetadata, unknownRecognition }

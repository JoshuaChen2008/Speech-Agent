'use strict'

function deepFreeze (value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const child of Object.values(value)) deepFreeze(child)
  return value
}

const fixtures = {
  changedReload: require('./v1.0.0/changed-reload.json'),
  manageDeleteResult: require('./v1.0.0/manage-delete-result.json'),
  manageForgetResult: require('./v1.0.0/manage-forget-result.json'),
  manageOperationFailure: require('./v1.0.0/manage-operation-failure.json'),
  managePermissionFailure: require('./v1.0.0/manage-permission-failure.json'),
  manageRememberProcessing: require('./v1.0.0/manage-remember-processing.json'),
  manageRememberResult: require('./v1.0.0/manage-remember-result.json'),
  manageRevisionConflict: require('./v1.0.0/manage-revision-conflict.json'),
  manageSetProcessingResult: require('./v1.0.0/manage-set-processing-result.json'),
  manageValidationError: require('./v1.0.0/manage-validation-error.json'),
  manageViewEpisodesReady: require('./v1.0.0/manage-view-episodes-ready.json'),
  manageViewReady: require('./v1.0.0/manage-view-ready.json'),
  overviewEmpty: require('./v1.0.0/overview-empty.json'),
  overviewLoading: require('./v1.0.0/overview-loading.json'),
  overviewReady: require('./v1.0.0/overview-ready.json'),
  overviewReloadResult: require('./v1.0.0/overview-reload-result.json'),
  overviewSuspended: require('./v1.0.0/overview-suspended.json'),
  overviewUnavailable: require('./v1.0.0/overview-unavailable.json')
}

module.exports = deepFreeze(fixtures)

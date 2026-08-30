'use strict'

class S1TerminalSessionReconciler {
  async reconcile (notification) {
    if (!notification || typeof notification !== 'object' || Array.isArray(notification) ||
        Object.keys(notification).length !== 1 || typeof notification.sessionId !== 'string' ||
        notification.sessionId.length === 0) {
      throw new TypeError('terminal session notification is invalid')
    }
    return Object.freeze({
      eligibility: 'provider_not_configured',
      createdRunCount: 0,
      createdReportCount: 0
    })
  }
}

module.exports = { S1TerminalSessionReconciler }

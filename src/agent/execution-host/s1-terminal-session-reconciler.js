'use strict'

class S1TerminalSessionReconciler {
  constructor (options = {}) {
    this.getEligibility = typeof options.getEligibility === 'function'
      ? options.getEligibility
      : async () => 'provider_not_configured'
  }

  async reconcile (notification) {
    if (!notification || typeof notification !== 'object' || Array.isArray(notification) ||
        Object.keys(notification).length !== 1 || typeof notification.sessionId !== 'string' ||
        notification.sessionId.length === 0) {
      throw new TypeError('terminal session notification is invalid')
    }
    const eligibility = await this.getEligibility({ sessionId: notification.sessionId })
    if (typeof eligibility !== 'string') throw new TypeError('eligibility result is invalid')
    return Object.freeze({
      eligibility,
      createdRunCount: 0,
      createdReportCount: 0
    })
  }
}

module.exports = { S1TerminalSessionReconciler }

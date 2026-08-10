'use strict'

const OVERLAY_ROLES = Object.freeze(['caption', 'toolbar'])

function createOverlayGestureTerminal ({
  getActiveSenderId,
  stopInteractions,
  resetInteractionGeneration,
  degradeInteractions
}) {
  if (typeof getActiveSenderId !== 'function' ||
      typeof stopInteractions !== 'function' ||
      typeof resetInteractionGeneration !== 'function' ||
      typeof degradeInteractions !== 'function') {
    throw new TypeError('overlay gesture terminal dependencies are invalid')
  }

  let primaryOwnerSenderId = null

  const finishPrimarySequence = (receivingSenderId) => {
    const activeSenderId = getActiveSenderId()
    const knownOwners = [primaryOwnerSenderId, activeSenderId]
      .filter((value) => Number.isSafeInteger(value))
    if (knownOwners.length === 0) return

    const crossedOverlay = knownOwners.some((senderId) => senderId !== receivingSenderId)
    primaryOwnerSenderId = null
    stopInteractions()
    if (!crossedOverlay) return
    let reset = false
    try { reset = resetInteractionGeneration() === true } catch { /* fixed degradation below */ }
    if (!reset) degradeInteractions()
  }

  const bind = ({ role, webContents }) => {
    if (!OVERLAY_ROLES.includes(role)) return false
    if (!webContents || typeof webContents.on !== 'function' ||
        !Number.isSafeInteger(webContents.id)) {
      throw new TypeError('overlay gesture terminal webContents is invalid')
    }

    webContents.on('before-mouse-event', (_event, input) => {
      if (!input || typeof input !== 'object') return
      if (input.type === 'mouseDown' && input.button === 'left') {
        primaryOwnerSenderId = webContents.id
        return
      }
      const primaryReleased = input.type === 'mouseUp' && input.button === 'left'
      const primaryMissingDuringMove = input.type === 'mouseMove' &&
        Array.isArray(input.modifiers) && !input.modifiers.includes('leftbuttondown')
      if (primaryReleased || primaryMissingDuringMove) {
        finishPrimarySequence(webContents.id)
      }
    })
    return true
  }

  return Object.freeze({ bind })
}

module.exports = { createOverlayGestureTerminal }

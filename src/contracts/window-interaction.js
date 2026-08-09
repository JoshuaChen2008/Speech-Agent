'use strict'

const INTERACTION_SCHEMA_VERSION = 1
const INTERACTION_PHASES = Object.freeze(['suspend', 'resume'])
const INTERACTION_ROLES = Object.freeze(['caption', 'toolbar', 'settings', 'history'])
const POINTER_ROLES = Object.freeze(['caption', 'toolbar'])
const RESIZE_EDGES = Object.freeze(['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'])

function isExactObject (value, keys) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function isGeneration (value) {
  return Number.isSafeInteger(value) && value > 0
}

function isPointer (value) {
  return isExactObject(value, ['x', 'y']) && Number.isFinite(value.x) && Number.isFinite(value.y)
}

function isInteractionSync (value, role) {
  if (!INTERACTION_ROLES.includes(role) || value?.schemaVersion !== INTERACTION_SCHEMA_VERSION ||
      !isGeneration(value?.generation) || !INTERACTION_PHASES.includes(value?.phase)) return false
  if (value.phase === 'suspend') {
    return isExactObject(value, ['schemaVersion', 'generation', 'phase'])
  }
  if (!isExactObject(value, ['schemaVersion', 'generation', 'phase', 'pointer'])) return false
  return POINTER_ROLES.includes(role) ? isPointer(value.pointer) : value.pointer === null
}

function isMouseThroughIntent (value) {
  return isExactObject(value, ['schemaVersion', 'generation', 'ignore']) &&
    value.schemaVersion === INTERACTION_SCHEMA_VERSION && isGeneration(value.generation) &&
    typeof value.ignore === 'boolean'
}

function isInteractionReadyIntent (value) {
  return isExactObject(value, ['schemaVersion']) &&
    value.schemaVersion === INTERACTION_SCHEMA_VERSION
}

function isGestureIntent (value) {
  return isExactObject(value, ['schemaVersion', 'generation']) &&
    value.schemaVersion === INTERACTION_SCHEMA_VERSION && isGeneration(value.generation)
}

function isResizeStartIntent (value) {
  return isExactObject(value, ['schemaVersion', 'generation', 'edge']) &&
    value.schemaVersion === INTERACTION_SCHEMA_VERSION && isGeneration(value.generation) &&
    RESIZE_EDGES.includes(value.edge)
}

function suspendSync (generation) {
  if (!isGeneration(generation)) throw new TypeError('window interaction generation is invalid')
  return Object.freeze({ schemaVersion: INTERACTION_SCHEMA_VERSION, generation, phase: 'suspend' })
}

function resumeSync (generation, pointer) {
  if (!isGeneration(generation) || !(pointer === null || isPointer(pointer))) {
    throw new TypeError('window interaction resume payload is invalid')
  }
  return Object.freeze({
    schemaVersion: INTERACTION_SCHEMA_VERSION,
    generation,
    phase: 'resume',
    pointer: pointer === null ? null : Object.freeze({ x: pointer.x, y: pointer.y })
  })
}

module.exports = {
  INTERACTION_PHASES,
  INTERACTION_ROLES,
  INTERACTION_SCHEMA_VERSION,
  POINTER_ROLES,
  RESIZE_EDGES,
  isGestureIntent,
  isInteractionReadyIntent,
  isInteractionSync,
  isMouseThroughIntent,
  isResizeStartIntent,
  resumeSync,
  suspendSync
}

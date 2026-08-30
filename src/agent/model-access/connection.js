'use strict'

const pathSegments = (value) => value.split('/').filter(Boolean)

function canonicalizeConnection (httpsOrigin, basePath = '/v1') {
  if (typeof httpsOrigin !== 'string' || typeof basePath !== 'string') throw new TypeError('MODEL_CONFIG_INVALID')
  let url
  try { url = new URL(httpsOrigin) } catch { throw new TypeError('MODEL_CONFIG_INVALID') }
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new TypeError('MODEL_CONFIG_INVALID')
  }
  if (!basePath.startsWith('/') || basePath.includes('?') || basePath.includes('#') ||
      pathSegments(basePath).some((segment) => decodeURIComponent(segment) === '..')) {
    throw new TypeError('MODEL_CONFIG_INVALID')
  }
  const normalizedPath = basePath === '/' ? '/' : `/${pathSegments(basePath).join('/')}`
  return Object.freeze({ httpsOrigin: url.origin, basePath: normalizedPath })
}

function joinEndpoint (connection, endpointSegment) {
  if (!['/chat/completions', '/models'].includes(endpointSegment)) throw new TypeError('endpoint is not registered')
  const base = connection.basePath === '/' ? '' : connection.basePath
  return `${connection.httpsOrigin}${base}${endpointSegment}`
}

function providerKindForOrigin (httpsOrigin) {
  const hostname = new URL(httpsOrigin).hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (hostname === 'localhost' || hostname === '::1') return 'local'
  const parts = hostname.split('.').map(Number)
  if (parts.length === 4 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255) && parts[0] === 127) return 'local'
  return 'cloud'
}

module.exports = { canonicalizeConnection, joinEndpoint, providerKindForOrigin }

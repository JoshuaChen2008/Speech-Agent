/* Vite serve executes local UMD files as side-effect modules and exposes their
   browser globals. The production build wraps the same files as CommonJS.
   Keep renderer entries compatible with both shapes until those shared APIs
   are migrated without breaking their Node test consumers. */
function isApiObject (value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object'
}

export function resolveLegacyUmdApi (
  moduleNamespace: unknown,
  globalApi: unknown,
  requiredMethod: string,
  label: string
): Record<string, unknown> {
  const namespace = isApiObject(moduleNamespace) ? moduleNamespace : null
  const candidates = [namespace?.default, namespace, globalApi]
  for (const candidate of candidates) {
    if (isApiObject(candidate) && typeof candidate[requiredMethod] === 'function') return candidate
  }
  throw new Error(`renderer API unavailable: ${label}`)
}

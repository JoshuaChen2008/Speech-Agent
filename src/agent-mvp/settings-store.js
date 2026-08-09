'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { AgentCoreError } = require('../agent-core/errors')
const { providerConfiguration } = require('../agent-core/contracts')

const DEFAULT_SETTINGS = Object.freeze({ provider: 'deterministic-test', baseUrl: '', model: 'fixture-model', cloudDisclosureAccepted: false })

function validateSettings (value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'baseUrl,cloudDisclosureAccepted,model,provider' ||
      !['deterministic-test', 'openai-compatible'].includes(value.provider) || typeof value.model !== 'string' || value.model.length < 1 || value.model.length > 160 ||
      typeof value.baseUrl !== 'string' || typeof value.cloudDisclosureAccepted !== 'boolean') throw new AgentCoreError('AGENT_REQUEST_INVALID')
  if (value.provider === 'openai-compatible') {
    if (!value.cloudDisclosureAccepted) throw new AgentCoreError('AGENT_REQUEST_INVALID')
    const configuration = providerConfiguration({ provider: value.provider, baseUrl: value.baseUrl, model: value.model })
    return { provider: value.provider, baseUrl: configuration.baseUrl, model: configuration.model, cloudDisclosureAccepted: true }
  }
  return { ...DEFAULT_SETTINGS }
}

class AgentMvpSettingsStore {
  constructor (settingsPath) { this.settingsPath = path.resolve(settingsPath); this.value = this.load() }
  load () {
    try { return validateSettings(JSON.parse(fs.readFileSync(this.settingsPath, 'utf8'))) } catch { return { ...DEFAULT_SETTINGS } }
  }
  save (value) {
    const next = validateSettings(value)
    fs.mkdirSync(path.dirname(this.settingsPath), { recursive: true })
    const temporary = `${this.settingsPath}.tmp`
    fs.writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', flag: 'w' })
    fs.renameSync(temporary, this.settingsPath); this.value = next; return this.get()
  }
  get () { return { ...this.value } }
}

module.exports = { AgentMvpSettingsStore, DEFAULT_SETTINGS, validateSettings }

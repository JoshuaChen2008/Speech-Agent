'use strict'

const crypto = require('node:crypto')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

function execute (executable, args, cwd) {
  const child = spawnSync(executable, args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true
  })
  if (child.error) throw child.error
  const rawOutput = [child.stdout, child.stderr].filter(Boolean).join('\n')
  return {
    exitCode: child.status,
    rawOutput,
    rawOutputSha256: crypto.createHash('sha256').update(rawOutput, 'utf8').digest('hex')
  }
}

function parseRecognizerLoadSeconds (output) {
  const match = output.match(/recognizer created in\s+([0-9.]+)\s*s/i)
  return match ? Number(match[1]) : null
}

function parseOnlineOutput (output, expectedWavs) {
  const pattern = /(?:^|\r?\n)([^\r\n]+\.wav)\r?\nNumber of threads:\s*(\d+),\s*Elapsed seconds:\s*([0-9.]+),\s*Audio duration \(s\):\s*([0-9.]+),\s*Real time factor \(RTF\)\s*=\s*[^\r\n]*?=\s*([0-9.]+)\r?\n([^\r\n]*)\r?\n(\{[^\r\n]+\})/g
  const samples = []
  let match
  while ((match = pattern.exec(output)) !== null) {
    samples.push({
      wav: path.basename(match[1]),
      numThreads: Number(match[2]),
      elapsedSeconds: Number(match[3]),
      durationSeconds: Number(match[4]),
      rtf: Number(match[5]),
      text: match[6],
      result: JSON.parse(match[7])
    })
  }
  if (samples.length !== expectedWavs.length) {
    throw new Error(`Parsed ${samples.length} online samples; expected ${expectedWavs.length}`)
  }
  return samples
}

function parseSenseVoiceOutput (output, expectedWavs) {
  const elapsedMatch = output.match(/Elapsed seconds:\s*([0-9.]+)\s*s/)
  const rtfMatch = output.match(/Real time factor \(RTF\):\s*([0-9.]+)\s*\/\s*([0-9.]+)\s*=\s*([0-9.]+)/)
  const results = [...output.matchAll(/^(\{"lang":.*\})\r?$/gm)].map((match) => JSON.parse(match[1]))
  if (!elapsedMatch || !rtfMatch || results.length !== expectedWavs.length) {
    throw new Error(`Could not parse SenseVoice output: ${results.length} results for ${expectedWavs.length} WAV files`)
  }
  return {
    elapsedSeconds: Number(elapsedMatch[1]),
    durationSeconds: Number(rtfMatch[2]),
    rtf: Number(rtfMatch[3]),
    samples: expectedWavs.map((wav, index) => ({
      wav: path.basename(wav),
      text: results[index].text,
      result: results[index]
    }))
  }
}

function runOnline (config) {
  const modelType = config.modelType || 'transducer'
  if (!['transducer', 'zipformer', 'zipformer2', 'paraformer'].includes(modelType)) {
    throw new Error(`unsupported online model type: ${modelType}`)
  }
  const modelArgs = modelType === 'paraformer'
    ? [
        `--paraformer-encoder=${config.model.encoder}`,
        `--paraformer-decoder=${config.model.decoder}`
      ]
    : [
        `--encoder=${config.model.encoder}`,
        `--decoder=${config.model.decoder}`,
        `--joiner=${config.model.joiner}`
      ]
  const args = [
    `--tokens=${config.model.tokens}`,
    ...modelArgs,
    `--num-threads=${config.numThreads}`,
    '--provider=cpu',
    '--print-args=false',
    ...config.wavs
  ]
  const execution = execute(path.join(config.cliBin, 'sherpa-onnx.exe'), args, config.cliBin)
  if (execution.exitCode !== 0) throw new Error(`${config.id} exited with ${execution.exitCode}`)
  return {
    report: {
      id: config.id,
      mode: modelType === 'paraformer' ? 'online-paraformer' : 'online-transducer',
      numThreads: config.numThreads,
      modelFiles: Object.fromEntries(Object.entries(config.model).map(([key, value]) => [key, path.basename(value)])),
      recognizerLoadSeconds: parseRecognizerLoadSeconds(execution.rawOutput),
      rawOutputSha256: execution.rawOutputSha256,
      samples: parseOnlineOutput(execution.rawOutput, config.wavs)
    },
    rawOutput: execution.rawOutput
  }
}

function runSenseVoice (config) {
  const args = [
    `--tokens=${config.model.tokens}`,
    `--sense-voice-model=${config.model.model}`,
    '--sense-voice-use-itn=true',
    `--num-threads=${config.numThreads}`,
    '--provider=cpu',
    '--print-args=false',
    ...config.wavs
  ]
  const execution = execute(path.join(config.cliBin, 'sherpa-onnx-offline.exe'), args, config.cliBin)
  if (execution.exitCode !== 0) throw new Error(`${config.id} exited with ${execution.exitCode}`)
  const parsed = parseSenseVoiceOutput(execution.rawOutput, config.wavs)
  return {
    report: {
      id: config.id,
      mode: 'sense-voice',
      numThreads: config.numThreads,
      modelFiles: Object.fromEntries(Object.entries(config.model).map(([key, value]) => [key, path.basename(value)])),
      recognizerLoadSeconds: parseRecognizerLoadSeconds(execution.rawOutput),
      rawOutputSha256: execution.rawOutputSha256,
      elapsedSeconds: parsed.elapsedSeconds,
      durationSeconds: parsed.durationSeconds,
      rtf: parsed.rtf,
      samples: parsed.samples
    },
    rawOutput: execution.rawOutput
  }
}

module.exports = {
  parseOnlineOutput,
  parseSenseVoiceOutput,
  runOnline,
  runSenseVoice
}

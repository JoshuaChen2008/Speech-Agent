'use strict'

// @ts-check

/* Recognizer adapter 契约（B2.3）。
   --------------------------------------------------------------------------
   worker 与 SessionCoordinator 都不得绑定具体模型文件名或推理库；模型实现
   通过本工厂注册并按 profile 解析。接口（每 source 一个实例）：

     adapter.acceptFrame(samples: Float32Array, timestampSeconds: number): void
       — 段内每帧调用，喂 16k mono PCM。
     adapter.poll(): string | null
       — 段内每帧后调用；返回当前 partial 文本（无更新可返回同一文本；
         null/空串表示尚无文本）。
     adapter.endSegment(): string | null
       — 段收束时调用；返回定稿文本并复位内部流状态；null/空串表示放弃
         本段（不发 final）。
     adapter.dispose(): void

   Gate 0B 结论是 FAIL：默认注册表里只有 NullRecognizerAdapter——它消费帧
   但永不产出文本。worker 因此可以完成 frame/VAD/queue 结构验证，而不伪造
   任何"看起来成功"的字幕。真实模型 adapter 由模型验证轨在通过基准后注册。 */

class NullRecognizerAdapter {
  constructor () {
    this.framesAccepted = 0
  }

  acceptFrame (samples) {
    this.framesAccepted += 1
  }

  poll () {
    return null
  }

  endSegment () {
    return null
  }

  dispose () {}
}

const FACTORIES = new Map([
  ['null', () => new NullRecognizerAdapter()]
])

/**
 * @param {string} profile 注册表键；B2.3 只有 'null'
 */
function createRecognizerAdapter (profile) {
  const factory = FACTORIES.get(profile)
  if (!factory) throw new TypeError(`unknown recognizer profile: ${String(profile)}`)
  return factory()
}

/** 模型轨用：注册真实实现。重复注册视为编程错误。 */
function registerRecognizerAdapter (profile, factory) {
  if (typeof profile !== 'string' || profile.length === 0) throw new TypeError('profile must be a non-empty string')
  if (typeof factory !== 'function') throw new TypeError('factory must be a function')
  if (FACTORIES.has(profile)) throw new TypeError(`recognizer profile already registered: ${profile}`)
  FACTORIES.set(profile, factory)
}

module.exports = { NullRecognizerAdapter, createRecognizerAdapter, registerRecognizerAdapter }

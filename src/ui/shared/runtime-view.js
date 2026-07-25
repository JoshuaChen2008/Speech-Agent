'use strict'

// @ts-check

/* RuntimeSnapshot → 纯视图模型。
   --------------------------------------------------------------------------
   这是「一个运行状态长什么样」的唯一决定处。预览页和真工具条共用它，
   所以 8 个 phase 的表达只会被决定一次，不会两边各写一遍然后漂移。

   三条硬规则：
   1. 只读 snapshot，不产生副作用，不发命令，不碰 DOM。
   2. 不发明事实。每个输出字段都能追溯到 snapshot 的某个字段；
      禁用理由和下一步一律取自 capabilities.limitations / lastError，
      不在这里编文案。
   3. 状态永远三重编码：icon（形状）+ label（文案）+ tone（颜色）。
      tone 只是冗余通道，去掉颜色后 icon 和 label 仍然能区分全部 8 个 phase。

   UMD：renderer 走 file:// + CSP script-src 'self'，ES module 会被 CORS 挡掉，
   所以用全局挂载；Node 侧仍可 require 来跑测试。 */

;(function (root) {
  /**
   * 需要用户知情或介入的 phase。
   * 工具条平时只显示图标（形状 + 色调两个通道就够区分状态）；
   * 只有这三个 phase 会额外带出一行说明文字，因为它们的信息量
   * 无法压进一个图标 —— 用户需要知道「缺什么」「在恢复什么」「为什么失败」。
   */
  const ATTENTION_PHASES = Object.freeze(['unavailable', 'recovering', 'error'])

  /** phase → 形状 / 文案 / 色调。tone 见 phases.css 的 [data-tone]。 */
  const PHASE_VIEW = Object.freeze({
    unavailable: { icon: 'ban', label: '不可用', tone: 'neutral' },
    idle: { icon: 'ready', label: '待命', tone: 'neutral' },
    starting: { icon: 'spinner', label: '启动中', tone: 'busy' },
    listening: { icon: 'wave', label: '监听中', tone: 'live' },
    paused: { icon: 'pause', label: '已暂停', tone: 'warn' },
    stopping: { icon: 'stopping', label: '结束中', tone: 'busy' },
    recovering: { icon: 'recover', label: '恢复中', tone: 'warn' },
    error: { icon: 'alert', label: '出错', tone: 'danger' }
  })

  const SOURCE_STATE_VIEW = Object.freeze({
    unavailable: { label: '不可用', tone: 'neutral' },
    inactive: { label: '未启用', tone: 'neutral' },
    starting: { label: '启动中', tone: 'busy' },
    active: { label: '监听中', tone: 'live' },
    paused: { label: '已暂停', tone: 'warn' },
    recovering: { label: '恢复中', tone: 'warn' },
    error: { label: '异常', tone: 'danger' }
  })

  const MODEL_STATE_VIEW = Object.freeze({
    missing: { label: '未安装', tone: 'neutral' },
    downloading: { label: '下载中', tone: 'busy' },
    verifying: { label: '校验中', tone: 'busy' },
    ready: { label: '就绪', tone: 'neutral' },
    error: { label: '异常', tone: 'danger' }
  })

  const PROFILE_LABEL = Object.freeze({
    fast: '极速',
    balanced: '均衡',
    accurate: '精准'
  })

  /** NEXT_ACTIONS 是闭集，所以这里可以穷举；新增值会在 resolve 时暴露为 null。 */
  const NEXT_ACTION_VIEW = Object.freeze({
    retry: { label: '重试', icon: 'retry' },
    'open-settings': { label: '打开设置', icon: 'settings' },
    'open-model-manager': { label: '管理模型', icon: 'model' },
    'request-permission': { label: '授予权限', icon: 'permission' }
  })

  /** 主按钮的三种意图。哪一种可用完全由 capabilities 决定，不按 phase 硬编码。 */
  const INTENTS = Object.freeze({
    start: { act: 'start', capability: 'start', field: 'canStart', icon: 'play', label: '开始' },
    pause: { act: 'pause', capability: 'pause', field: 'canPause', icon: 'pause', label: '暂停' },
    resume: { act: 'resume', capability: 'resume', field: 'canResume', icon: 'play', label: '继续' }
  })

  /** 全部命令都不可用时，按 phase 决定「摆出哪个意图的禁用态」。 */
  const FALLBACK_INTENT = Object.freeze({
    unavailable: 'start',
    idle: 'start',
    starting: 'pause',
    listening: 'pause',
    paused: 'resume',
    stopping: 'pause',
    recovering: 'pause',
    error: 'start'
  })

  function findLimitation (snapshot, capability) {
    const list = snapshot.capabilities.limitations
    for (const item of list) {
      if (item.capability === capability) return item
    }
    return null
  }

  function sourcesInState (snapshot, states) {
    return snapshot.sources.filter((source) => states.indexOf(source.state) !== -1)
  }

  function joinLabels (sources) {
    return sources.map((source) => source.label).join(' · ')
  }

  /** 状态区第二行：说明「这个 phase 具体作用在什么上」。 */
  function buildDetail (snapshot) {
    const model = snapshot.model
    switch (snapshot.phase) {
      case 'unavailable':
        if (model.state !== 'ready') return '模型' + MODEL_STATE_VIEW[model.state].label
        return joinLabels(snapshot.sources) || '没有可用音频源'
      case 'idle':
        return joinLabels(sourcesInState(snapshot, ['inactive'])) || '没有可用音频源'
      case 'starting':
        return joinLabels(sourcesInState(snapshot, ['starting']))
      case 'listening':
        return joinLabels(sourcesInState(snapshot, ['active']))
      case 'paused':
        return '会话保留中'
      case 'stopping':
        return '正在写入会话'
      case 'recovering':
        return joinLabels(sourcesInState(snapshot, ['recovering', 'error']))
      case 'error':
        return joinLabels(sourcesInState(snapshot, ['error']))
      default:
        return ''
    }
  }

  /**
   * 主按钮。
   * 注意这里刻意不用 aria-pressed：按钮的可及名称本身在「开始 / 暂停 / 继续」
   * 之间切换，再叠一个 pressed 语义会让屏幕阅读器读出互相矛盾的两份状态。
   * 锁定按钮才是真正的 toggle（名称稳定），aria-pressed 留给它。
   */
  function buildPrimary (snapshot) {
    const capabilities = snapshot.capabilities
    const order = ['pause', 'resume', 'start']

    for (const key of order) {
      const intent = INTENTS[key]
      if (capabilities[intent.field]) {
        return {
          act: intent.act,
          icon: intent.icon,
          label: intent.label,
          ariaLabel: intent.label,
          disabled: false,
          reason: null
        }
      }
    }

    const intent = INTENTS[FALLBACK_INTENT[snapshot.phase] || 'start']
    const limitation = findLimitation(snapshot, intent.capability)
    /* limitation 说明「这个命令为什么不能用」，lastError 说明「运行时出了什么事」。
       前者更具体，优先；都没有时才退到泛化文案，不自行编造原因。 */
    const reason = limitation
      ? limitation.message
      : (snapshot.lastError ? snapshot.lastError.message : null)

    return {
      act: intent.act,
      icon: intent.icon,
      label: intent.label,
      ariaLabel: reason ? intent.label + '（' + reason + '）' : intent.label + '（当前不可用）',
      disabled: true,
      reason
    }
  }

  /** 停止 / 重试。只在语义成立时出现：没有会话就没有「停止」。 */
  function buildSecondary (snapshot) {
    const capabilities = snapshot.capabilities
    const actions = []

    const stopLimitation = findLimitation(snapshot, 'stop')
    if (snapshot.sessionId !== null) {
      actions.push({
        act: 'stop',
        icon: 'stop',
        label: '停止',
        ariaLabel: capabilities.canStop || !stopLimitation
          ? '停止'
          : '停止（' + stopLimitation.message + '）',
        disabled: !capabilities.canStop,
        reason: stopLimitation ? stopLimitation.message : null
      })
    }

    const retryLimitation = findLimitation(snapshot, 'retry')
    if (capabilities.canRetry || retryLimitation) {
      actions.push({
        act: 'retry',
        icon: 'retry',
        label: '重试',
        ariaLabel: capabilities.canRetry || !retryLimitation
          ? '重试'
          : '重试（' + retryLimitation.message + '）',
        disabled: !capabilities.canRetry,
        reason: retryLimitation ? retryLimitation.message : null
      })
    }

    return actions
  }

  /**
   * 「下一步」。来源优先级：lastError > 阻塞 start 的 limitation。
   * nextAction 是后端给的闭集枚举，UI 只负责把它翻译成按钮，不自行决定去哪。
   */
  function buildNextAction (snapshot) {
    const error = snapshot.lastError
    const source = error && error.nextAction
      ? { action: error.nextAction, message: error.message }
      : null

    const fallback = source || (() => {
      const limitation = findLimitation(snapshot, 'start')
      return limitation && limitation.nextAction
        ? { action: limitation.nextAction, message: limitation.message }
        : null
    })()

    if (!fallback) return null
    const view = NEXT_ACTION_VIEW[fallback.action]
    if (!view) return null

    return {
      action: fallback.action,
      icon: view.icon,
      label: view.label,
      message: fallback.message
    }
  }

  /**
   * 字幕卡上的说明条。只在「字幕区本来就没内容可显示」的 phase 出现，
   * 避免盖住正在滚动的字幕。stopping 有字幕，所以不给说明条。
   *
   * 说明条内不放交互控件：字幕窗是 focusable:false，按钮在那里键盘够不到。
   * 可执行的下一步一律由工具条承载。
   */
  function buildNotice (snapshot) {
    const phase = snapshot.phase
    const shows = phase === 'unavailable' || phase === 'starting' ||
                  phase === 'recovering' || phase === 'error'
    if (!shows) return null

    const view = PHASE_VIEW[phase]
    let message = ''
    if (snapshot.lastError) {
      message = snapshot.lastError.message
    } else {
      const limitation = findLimitation(snapshot, 'start') || findLimitation(snapshot, 'retry')
      message = limitation ? limitation.message : ''
    }

    return {
      tone: view.tone,
      icon: view.icon,
      title: view.label,
      message,
      detail: buildDetail(snapshot)
    }
  }

  function buildModel (snapshot) {
    const model = snapshot.model
    const view = MODEL_STATE_VIEW[model.state]
    const parts = [view.label]
    if (model.profile) parts.push(PROFILE_LABEL[model.profile] || model.profile)
    return {
      state: model.state,
      tone: view.tone,
      label: parts.join(' · '),
      progress: model.progress,
      showProgress: model.state === 'downloading' || model.state === 'verifying'
    }
  }

  /**
   * @param {*} snapshot 已通过 assertRuntimeSnapshot 的 RuntimeSnapshot
   */
  function buildRuntimeView (snapshot) {
    const view = PHASE_VIEW[snapshot.phase]
    if (!view) throw new TypeError('未知 phase: ' + String(snapshot.phase))

    const notice = buildNotice(snapshot)
    const secondary = buildSecondary(snapshot)
    let nextAction = buildNextAction(snapshot)
    /* 次按钮里已经有「重试」时，下一步不再重复给一个重试入口 */
    if (nextAction && nextAction.action === 'retry' &&
        secondary.some((item) => item.act === 'retry')) {
      nextAction = null
    }

    return {
      revision: snapshot.revision,
      phase: snapshot.phase,
      sessionId: snapshot.sessionId,
      status: {
        icon: view.icon,
        label: view.label,
        tone: view.tone,
        detail: buildDetail(snapshot),
        /* quiet：只渲染图标。attention：额外渲染 message。 */
        emphasis: ATTENTION_PHASES.indexOf(snapshot.phase) === -1 ? 'quiet' : 'attention',
        /* 需要用户看到的那一句。取自后端，不在这里编。 */
        message: notice ? notice.message : '',
        /* 屏幕阅读器读到的完整状态。图标是装饰性的，语义全靠这一串，
           所以无论 quiet 还是 attention 都要完整。 */
        ariaLabel: view.label + (buildDetail(snapshot) ? '，' + buildDetail(snapshot) : '')
      },
      primary: buildPrimary(snapshot),
      secondary,
      nextAction,
      notice,
      model: buildModel(snapshot),
      sources: snapshot.sources.map((source) => {
        const stateView = SOURCE_STATE_VIEW[source.state]
        return {
          id: source.id,
          label: source.label,
          state: source.state,
          stateLabel: stateView.label,
          tone: stateView.tone,
          level: source.level,
          /* 电平只在 active 时有意义，契约已保证其余状态 level 为 0 */
          showLevel: source.state === 'active'
        }
      })
    }
  }

  const api = {
    PHASE_VIEW,
    SOURCE_STATE_VIEW,
    MODEL_STATE_VIEW,
    PROFILE_LABEL,
    NEXT_ACTION_VIEW,
    buildRuntimeView
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = api
  else root.RuntimeView = api
})(typeof globalThis !== 'undefined' ? globalThis : this)

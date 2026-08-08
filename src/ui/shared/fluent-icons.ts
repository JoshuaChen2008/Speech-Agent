import alert from '@fluentui/svg-icons/icons/alert_20_regular.svg?raw'
import arrowClockwise from '@fluentui/svg-icons/icons/arrow_clockwise_20_regular.svg?raw'
import box from '@fluentui/svg-icons/icons/box_20_regular.svg?raw'
import dismiss from '@fluentui/svg-icons/icons/dismiss_20_regular.svg?raw'
import drag from '@fluentui/svg-icons/icons/drag_20_regular.svg?raw'
import history from '@fluentui/svg-icons/icons/history_20_regular.svg?raw'
import key from '@fluentui/svg-icons/icons/key_20_regular.svg?raw'
import lockClosed from '@fluentui/svg-icons/icons/lock_closed_20_regular.svg?raw'
import lockOpen from '@fluentui/svg-icons/icons/lock_open_20_regular.svg?raw'
import pause from '@fluentui/svg-icons/icons/pause_20_regular.svg?raw'
import play from '@fluentui/svg-icons/icons/play_20_regular.svg?raw'
import power from '@fluentui/svg-icons/icons/power_20_regular.svg?raw'
import prohibited from '@fluentui/svg-icons/icons/prohibited_20_regular.svg?raw'
import recordStop from '@fluentui/svg-icons/icons/record_stop_20_regular.svg?raw'
import settings from '@fluentui/svg-icons/icons/settings_20_regular.svg?raw'
import soundWave from '@fluentui/svg-icons/icons/sound_wave_circle_20_regular.svg?raw'
import spinner from '@fluentui/svg-icons/icons/spinner_ios_20_regular.svg?raw'
import stop from '@fluentui/svg-icons/icons/stop_20_regular.svg?raw'

const ICONS: Readonly<Record<string, string>> = Object.freeze({
  ban: prohibited,
  ready: power,
  spinner,
  wave: soundWave,
  pause,
  stopping: recordStop,
  recover: arrowClockwise,
  alert,
  play,
  stop,
  retry: arrowClockwise,
  settings,
  model: box,
  permission: key,
  grip: drag,
  history,
  lock: lockClosed,
  unlock: lockOpen,
  close: dismiss
})

const NAMES = Object.freeze(Object.keys(ICONS))

function installSprite (): void {}

function iconMarkup (name: string): string {
  const svg = ICONS[name]
  if (!svg) throw new TypeError(`Fluent icon is not registered: ${name}`)
  return svg.replace('<svg ', '<svg class="icon" aria-hidden="true" focusable="false" fill="currentColor" ')
}

export default Object.freeze({ NAMES, installSprite, iconMarkup })

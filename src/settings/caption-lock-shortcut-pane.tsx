import { useEffect, useRef, useState, type KeyboardEvent, type ReactElement } from 'react'
import {
  DEFAULT_CAPTION_LOCK_SHORTCUT, KEY_VK, MODIFIERS, canonicalShortcut,
  isCaptionLockShortcut, modifierGroup, normalizePressedKeys, shortcutLabel
} from '../contracts/caption-lock-shortcut.js'

type Dict = Record<string, any>
type Phase = 'idle' | 'preparing' | 'recording' | 'saving'

export function CaptionLockShortcutPane ({ shell, config, onConfigRefresh }: {
  shell: any, config: Dict | null, onConfigRefresh: () => Promise<void>
}): ReactElement {
  const [phase, setPhase] = useState<Phase>('idle')
  const [draft, setDraft] = useState<string[] | null>(null)
  const [keysDown, setKeysDown] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const recorder = useRef<HTMLInputElement>(null)
  const recordButton = useRef<HTMLButtonElement>(null)
  const generation = useRef(0)
  const mounted = useRef(true)
  const focusOnIdle = useRef(false)
  const held = useRef(new Set<string>())
  const peak = useRef<string[]>([])
  const invalid = useRef(false)
  const keys: string[] = config?.captionLockShortcut ?? [...DEFAULT_CAPTION_LOCK_SHORTCUT]
  const enabled = config?.captionLockShortcutEnabled !== false
  const busy = phase === 'preparing' || phase === 'saving'

  const endRecording = (returnFocus = true) => {
    generation.current += 1
    held.current.clear(); peak.current = []; invalid.current = false
    setKeysDown(false); setDraft(null); setError(''); setPhase('idle')
    void shell.setCaptionLockShortcutRecording({ recording: false }).catch(() => {})
    focusOnIdle.current = returnFocus
  }
  useEffect(() => {
    mounted.current = true
    const blur = () => endRecording(false)
    window.addEventListener('blur', blur)
    return () => {
      mounted.current = false; generation.current += 1
      window.removeEventListener('blur', blur)
      void shell.setCaptionLockShortcutRecording({ recording: false }).catch(() => {})
    }
  }, [shell])
  useEffect(() => {
    if (phase === 'recording') recorder.current?.focus()
    else if (phase === 'idle' && focusOnIdle.current) { focusOnIdle.current = false; recordButton.current?.focus() }
  }, [phase])
  useEffect(() => {
    if (phase !== 'recording' && phase !== 'preparing') return
    const escape = (event: globalThis.KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); endRecording() } }
    window.addEventListener('keydown', escape)
    return () => window.removeEventListener('keydown', escape)
  }, [phase, shell])

  const beginRecording = async () => {
    const requestedAt = ++generation.current
    setPhase('preparing'); setDraft(null); setError(''); setNotice('')
    held.current.clear(); peak.current = []; invalid.current = false; setKeysDown(false)
    try {
      const result = await shell.setCaptionLockShortcutRecording({ recording: true })
      // Cancellation already sent its later, ordered IPC request. A stale
      // reply must not stop a newer recording that the user has since begun.
      if (!mounted.current || generation.current !== requestedAt) return
      if (!result?.ok) { setError(result?.message || '无法开始录入，请保持设置窗口处于前台。'); setPhase('idle'); return }
      setPhase('recording')
    } catch {
      if (mounted.current && generation.current === requestedAt) { setError('无法开始录入，请重试。'); setPhase('idle') }
    }
  }
  const recordKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    // Plain Tab retains keyboard access to Save and Cancel.
    if (event.code === 'Tab' && !event.ctrlKey && !event.altKey && !event.shiftKey) return
    event.preventDefault(); event.stopPropagation()
    if (event.code === 'Escape' || event.key === 'Escape') { endRecording(); return }
    if (event.repeat) return
    if (held.current.size === 0) { peak.current = []; invalid.current = false; setError(''); setDraft(null) }
    if (!Object.hasOwn(KEY_VK, event.code) && !MODIFIERS.includes(event.code)) {
      invalid.current = true; setError('这个按键暂不支持。请用 Ctrl、Alt、Shift、字母、数字、功能键或导航键。')
      held.current.add(event.code); setKeysDown(true); return
    }
    const group = modifierGroup(event.code)
    if (group) held.current.delete(group)
    held.current.add(event.code)
    for (const [modifier, isDown] of [['Control', event.ctrlKey], ['Alt', event.altKey], ['Shift', event.shiftKey]] as const) {
      if (isDown && ![...held.current].some(key => modifierGroup(key) === modifier)) held.current.add(modifier)
    }
    held.current = new Set(normalizePressedKeys([...held.current]))
    const captured = canonicalShortcut([...held.current])
    if (captured.length >= peak.current.length || event.code === 'AltRight') peak.current = captured
    setDraft([...peak.current]); setKeysDown(true)
  }
  const recordKeyUp = (event: KeyboardEvent<HTMLInputElement>) => {
    event.preventDefault(); event.stopPropagation()
    held.current.delete(event.code)
    if (!event.ctrlKey) held.current.delete('Control')
    if (!event.altKey) held.current.delete('Alt')
    if (!event.shiftKey) held.current.delete('Shift')
    if (held.current.size !== 0) return
    setKeysDown(false)
    if (!invalid.current && !isCaptionLockShortcut(peak.current)) {
      setError('请使用至多一个普通键与不同修饰键；F12、Alt+Tab、Alt+F4、Ctrl+Alt+Delete 和左 Ctrl+右 Alt 不能录入。')
      invalid.current = true
    }
  }
  const save = async (patch: Dict, recordingSave = false) => {
    const requestedAt = generation.current
    setPhase('saving'); setError(''); setNotice('')
    try {
      const result = await shell.setConfig(patch)
      await onConfigRefresh()
      if (!mounted.current || generation.current !== requestedAt) return
      if (!result?.ok) {
        setError(result?.message || '快捷键设置未保存，请重试。')
        setPhase(recordingSave ? 'recording' : 'idle'); return
      }
      if (recordingSave) endRecording()
      else setPhase('idle')
      setNotice(patch.captionLockShortcutEnabled === false ? '快捷键已关闭，仍可使用工具条锁定按钮。' : '快捷键设置已保存。')
    } catch {
      await onConfigRefresh()
      if (!mounted.current || generation.current !== requestedAt) return
      setError('快捷键设置未保存，请重试。'); setPhase(recordingSave ? 'recording' : 'idle')
    }
  }
  const stateText = !enabled ? '已关闭；仍可点击工具条锁定按钮。' : config?.captionLockShortcutStatus === 'unavailable'
    ? '未能启用。请换一个键位，或使用工具条锁定按钮。'
    : phase === 'recording' ? '正在录入，本功能暂时停用。' : `按 ${shortcutLabel(keys)} 切换字幕窗锁定。`

  return <>
    <h1>快捷键</h1><p className="sub">在其他应用中也可以切换字幕窗锁定。</p>
    <div className="group shortcut-settings">
      <div className="row"><div><div className="label">字幕窗锁定快捷键</div>
        <p className="hint shortcut-hint" id="captionShortcutState" role="status">{stateText}</p></div>
        <label className="switch"><input id="captionShortcutEnabled" type="checkbox" checked={enabled}
          disabled={!config || phase !== 'idle'} aria-describedby="captionShortcutState" aria-label="启用字幕窗锁定快捷键"
          onChange={event => void save({ captionLockShortcutEnabled: event.currentTarget.checked })} /><span>启用</span></label></div>
      <div className="row shortcut-binding"><kbd id="captionShortcutCurrent">{shortcutLabel(keys)}</kbd>
        <div className="shortcut-actions"><button className="secondary-btn" id="captionShortcutRecord" ref={recordButton}
          disabled={!config || phase !== 'idle'} onClick={() => void beginRecording()}>{phase === 'preparing' ? '正在准备…' : '录入按键'}</button>
          <button className="link-btn" id="captionShortcutReset" disabled={!config || phase !== 'idle'}
            onClick={() => void save({ captionLockShortcut: [...DEFAULT_CAPTION_LOCK_SHORTCUT], captionLockShortcutEnabled: true })}>恢复默认</button></div></div>
      {(phase === 'recording' || phase === 'saving' && draft) && <div className="shortcut-recorder">
        <label className="label" htmlFor="captionShortcutInput">按下想使用的按键，然后全部松开</label>
        <input id="captionShortcutInput" ref={recorder} type="text" readOnly disabled={busy}
          value={draft && isCaptionLockShortcut(draft) ? shortcutLabel(draft) : '请按下单键或组合键…'}
          aria-describedby="captionShortcutHelp captionShortcutError" aria-invalid={Boolean(error)}
          onKeyDown={recordKeyDown} onKeyUp={recordKeyUp} />
        <p className="hint shortcut-hint" id="captionShortcutHelp">支持左、右 Ctrl / Alt / Shift；Tab 前往按钮，Esc 取消。点击保存后生效。</p>
        <div className="shortcut-actions"><button className="primary-btn" id="captionShortcutSave"
          disabled={busy || keysDown || invalid.current || !draft || !isCaptionLockShortcut(draft)}
          onClick={() => void save({ captionLockShortcut: draft }, true)}>{phase === 'saving' ? '正在保存…' : '保存'}</button>
          <button className="secondary-btn" id="captionShortcutCancel" disabled={phase === 'saving'} onClick={() => endRecording()}>取消</button></div>
      </div>}
      <p className="shortcut-error" id="captionShortcutError" role="alert" hidden={!error}>{error}</p>
      <p className="hint shortcut-hint" role="status" hidden={!notice}>{notice}</p>
    </div>
    <p className="note">单独右 Alt 或其他纯修饰键在松开时切换一次；按住它输入其他字符时不会触发。右 Alt 在部分键盘布局中也用于输入特殊字符。</p>
    <p className="note">快捷键全局生效，请避开经常使用的键位。关闭后会保留设置的按键；工具条锁定按钮始终保留。</p>
  </>
}

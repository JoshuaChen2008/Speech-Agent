import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import Icons from '../ui/shared/fluent-icons'

type Dict = Record<string, any>
type Version = 'original' | 'refined'
type CursorEntry = { cursor: Dict | null, offset: number }
const PAGE_SIZE = 50

function unwrap (response: Dict): Dict {
  if (!response || response.ok !== true) throw new Error(response?.error?.message || '历史记录暂时不可用')
  return response.value
}
function sourceLabel (sourceId: string): string { return sourceId === 'mic' ? '麦克风听写' : '系统音频字幕' }
function stateLabel (state: string): string { return state === 'interrupted' ? '会话被中断' : '正常结束' }
const date = (value: number, full = false): string => new Intl.DateTimeFormat('zh-CN', full
  ? { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }
  : { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value))
function durationText (start: number, end: number): string {
  const total = Math.max(0, Math.round((end - start) / 1000)); const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60); const seconds = total % 60
  return hours > 0 ? `${hours} 小时 ${minutes} 分钟` : minutes > 0 ? `${minutes} 分 ${seconds} 秒` : `${seconds} 秒`
}
function clock (milliseconds: number): string {
  const total = Math.max(0, Math.floor(milliseconds / 1000)); const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60); const seconds = total % 60; const pad = (n: number) => String(n).padStart(2, '0')
  return hours > 0 ? `${pad(hours)}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`
}
function metadata (value: Dict | null): Dict | null {
  if (!value || !Number.isInteger(value.segmentCount) || value.segmentCount < 0 ||
    !Number.isInteger(value.refinedSegmentCount) || value.refinedSegmentCount < 0 || value.refinedSegmentCount > value.segmentCount) return null
  return { segmentCount: value.segmentCount, refinedSegmentCount: value.refinedSegmentCount,
    refinementFaultCode: typeof value.refinementFaultCode === 'string' ? value.refinementFaultCode : null,
    refinementResultStatus: value.refinementResultStatus === 'not_recorded' ? 'not_recorded' : 'known' }
}
function refinementText (value: Dict | null): string {
  if (!value) return ''
  const { segmentCount: total, refinedSegmentCount: refined, refinementFaultCode: fault, refinementResultStatus: result } = value
  let text = total === 0 ? (fault ? '精修进程异常结束；本会话未产生可精修的已定稿字幕' : '')
    : refined === 0 ? '本会话未生成精修稿'
      : fault && refined === total ? `精修进程异常结束，但本次已生成 ${refined}/${total} 段精修稿`
        : refined < total ? `已精修 ${refined}/${total} 段，${total - refined} 段使用原始版` : `已精修 ${refined}/${total} 段`
  if (fault && total > 0 && refined !== total) text = `精修进程异常结束；${text}`
  if (result === 'not_recorded') text = text ? `${text}；未记录精修运行状态` : '未记录精修运行状态'
  return text
}
function assertPage (value: Dict, sessionId: string): Dict {
  if (!value?.session || value.session.sessionId !== sessionId || !Array.isArray(value.items) || value.items.length > PAGE_SIZE ||
    !Number.isSafeInteger(value.totalCount) || value.totalCount < 0 || (value.nextCursor !== null &&
      (!Number.isSafeInteger(value.nextCursor?.t0Ms) || !Number.isSafeInteger(value.nextCursor?.firstEventOrder)))) {
    throw new Error('历史记录分页响应无效')
  }
  return value
}
function Icon ({ name }: { name: string }): ReactElement {
  return <span dangerouslySetInnerHTML={{ __html: Icons.iconMarkup(name) }} />
}

export function HistoryView (): ReactElement {
  const api = window.historyApi
  if (!api) throw new Error('history preload bridge is missing')
  const titlebar = useRef<HTMLElement>(null)
  const [sessions, setSessions] = useState<Dict[]>([]); const [nextCursor, setNextCursor] = useState<Dict | null>(null)
  const [listPending, setListPending] = useState(false); const [selected, setSelected] = useState<string | null>(null)
  const [version, setVersion] = useState<Version>('original'); const [page, setPage] = useState<Dict | null>(null)
  const [pageIndex, setPageIndex] = useState(0); const [cursors, setCursors] = useState<CursorEntry[]>([{ cursor: null, offset: 0 }])
  const [detailPending, setDetailPending] = useState(false); const [detailError, setDetailError] = useState<string | null>(null)
  const [refinement, setRefinement] = useState<Dict | null>(null); const [globalStatus, setGlobalStatus] = useState('')
  const [exportPending, setExportPending] = useState(false); const [exportStatus, setExportStatus] = useState('')
  const generation = useRef(0); const exportGeneration = useRef(0)

  const clearDetail = useCallback(() => {
    generation.current += 1; exportGeneration.current += 1; setSelected(null); setVersion('original'); setPage(null); setPageIndex(0)
    setCursors([{ cursor: null, offset: 0 }]); setDetailPending(false); setDetailError(null); setRefinement(null); setExportPending(false); setExportStatus('')
  }, [])
  const loadSessions = useCallback(async (reset: boolean) => {
    if (listPending) return; setListPending(true); if (reset) clearDetail(); setGlobalStatus('')
    try {
      const result = unwrap(await api.listSessions(PAGE_SIZE, reset ? null : nextCursor))
      setSessions((current) => reset ? result.items : current.concat(result.items)); setNextCursor(result.nextCursor)
    } catch (error) { setGlobalStatus(error instanceof Error ? error.message : '历史记录暂时不可用') }
    finally { setListPending(false) }
  }, [api, clearDetail, listPending, nextCursor])

  const loadPage = useCallback(async (sessionId: string, index: number, stack: CursorEntry[]) => {
    const cursorEntry = stack[index]; if (!cursorEntry) return
    const token = ++generation.current; exportGeneration.current += 1; setExportPending(false); setExportStatus('')
    setDetailPending(true); setDetailError(null); setPage(null); setPageIndex(index); setGlobalStatus('正在读取会话…')
    try {
      const result = assertPage(unwrap(await api.getSessionPage(sessionId, PAGE_SIZE, cursorEntry.cursor)), sessionId)
      if (token !== generation.current) return
      const nextMetadata = metadata(result.refinement); setRefinement(nextMetadata)
      if (!nextMetadata || nextMetadata.refinedSegmentCount === 0) setVersion('original')
      setPage(result); const nextStack = stack.slice(0, index + 1)
      if (result.nextCursor !== null) nextStack.push({ cursor: result.nextCursor, offset: cursorEntry.offset + result.items.length })
      setCursors(nextStack); setGlobalStatus('')
    } catch (error) {
      if (token !== generation.current) return; const message = error instanceof Error ? error.message : '历史记录暂时不可用'
      setDetailError(message); setGlobalStatus(message)
    } finally { if (token === generation.current) setDetailPending(false) }
  }, [api])
  const selectSession = useCallback((sessionId: string) => {
    if (sessionId === selected && (detailPending || page)) return
    generation.current += 1; setSelected(sessionId); setVersion('original'); setRefinement(null); setExportStatus('')
    const stack = [{ cursor: null, offset: 0 }]; setCursors(stack); setPageIndex(0); setPage(null); setDetailError(null)
    void loadPage(sessionId, 0, stack)
  }, [detailPending, loadPage, page, selected])
  const exportSelected = async (format: string) => {
    if (!selected || exportPending) return; const sessionId = selected; const token = ++exportGeneration.current; const pageToken = generation.current
    setExportPending(true); setExportStatus('正在准备导出…')
    try {
      const result = unwrap(await api.exportSession(sessionId, format, version))
      if (token !== exportGeneration.current || pageToken !== generation.current) return
      setExportStatus(result.status === 'saved' ? (version === 'refined' ? '字幕精修稿已导出' : '字幕原文已导出') : '已取消导出')
    } catch (error) { if (token === exportGeneration.current && pageToken === generation.current) setExportStatus(error instanceof Error ? error.message : '导出不可用') }
    finally { if (token === exportGeneration.current && pageToken === generation.current) setExportPending(false) }
  }
  useEffect(() => {
    const dispose = api.onConfig((config: Dict) => { document.documentElement.dataset.theme = config.theme === 'auto' ? (config.systemDark ? 'dark' : 'light') : config.theme })
    void api.getConfig().then((config: Dict) => { document.documentElement.dataset.theme = config.theme === 'auto' ? (config.systemDark ? 'dark' : 'light') : config.theme }).catch(() => {})
    void loadSessions(true); return () => { if (typeof dispose === 'function') dispose() }
  }, []) // initial subscription and first keyset page only
  useEffect(() => {
    const drag = window.ManualWindowDrag; if (!drag || !titlebar.current) return
    const controller = drag.bindManualWindowDrag({ handle: titlebar.current, canStart: (event: Event) => !drag.isInteractiveDragEvent(event), onStart: () => api.dragStart(), onEnd: () => api.dragEnd() })
    const dispose = typeof api.onInteractionSync === 'function'
      ? api.onInteractionSync(() => controller.cancel?.())
      : null
    return () => { if (typeof dispose === 'function') dispose(); controller.cancel?.() }
  }, [api])

  const selectedSession = sessions.find((item) => item.sessionId === selected) ?? null
  const canRefine = refinement !== null && refinement.refinedSegmentCount > 0
  const controlsDisabled = detailPending || exportPending || page === null
  const offset = cursors[pageIndex]?.offset ?? 0
  const body = (item: Dict) => version === 'refined' ? (typeof item.refinedText === 'string' && item.refinedText.length > 0 ? item.refinedText : `[原始版回退] ${item.text}`) : item.text

  return <><header className="titlebar" id="titlebar" ref={titlebar}><div className="title-group"><strong>字幕历史</strong><span>文本复盘，不包含录音</span></div>
    <div className="title-actions"><div className="global-status" id="globalStatus" role="status" aria-live="polite">{globalStatus}</div>
      <button className="text-button" id="refresh" disabled={listPending} aria-busy={listPending} onClick={() => void loadSessions(true)}>刷新</button>
      <button className="icon-button close-button" id="close" title="关闭" aria-label="关闭历史记录" onClick={() => api.close()}><Icon name="close" /></button></div></header>
    <main className="history-layout"><aside className="session-panel" aria-label="历史会话"><div className="panel-heading"><div><h1>会话</h1><p id="sessionCount">{listPending ? '正在读取…' : sessions.length === 0 ? '暂无会话' : `已显示 ${sessions.length} 条会话`}</p></div></div>
      <div className="session-list" id="sessionList" role="list">{sessions.length === 0 && !listPending ? <div className="session-list-item" role="listitem"><p className="list-message">还没有可复盘的字幕会话。完成一次监听后，它会自动出现在这里。</p></div> : sessions.map((item) => <div className="session-list-item" role="listitem" key={item.sessionId}><button className="session-card" data-session-id={item.sessionId} aria-current={item.sessionId === selected} onClick={() => selectSession(item.sessionId)}><strong>{date(item.startedAt)}</strong><span className="summary">{sourceLabel(item.sourceId)} · {durationText(item.startedAt, item.endedAt)}</span><span className="state">{stateLabel(item.state)} · {item.segmentCount} 条字幕</span></button></div>)}</div>
      <button className="load-more" id="loadMore" hidden={nextCursor === null} disabled={listPending} onClick={() => void loadSessions(false)}>加载更多</button></aside>
      <section className="detail-panel" aria-label="字幕时间线"><div className="empty-state" id="emptyState" hidden={selected !== null}><h2>选择一条会话开始复盘</h2><p>这里只显示已经结束或被中断的字幕原文。临时字幕、译文和音频都不会进入历史。</p></div>
        <div className="session-detail" id="sessionDetail" hidden={selected === null}><header className="detail-heading"><div><div className="eyebrow" id="detailSource">{selectedSession ? `${sourceLabel(selectedSession.sourceId)} · ${stateLabel(selectedSession.state)}` : ''}</div><h2 id="detailTitle">{selectedSession ? date(selectedSession.startedAt, true) : '字幕会话'}</h2><p id="detailMeta">{selectedSession ? `${durationText(selectedSession.startedAt, selectedSession.endedAt)} · ${page?.totalCount ?? selectedSession.segmentCount} 条已定稿字幕` : ''}</p><p className="detail-refinement" id="detailRefinement" role="status">{refinementText(refinement)}</p></div>
          <div className="version-actions" role="radiogroup" aria-label="转写版本">{(['original', 'refined'] as Version[]).map((item) => <button key={item} data-version={item} role="radio" aria-checked={version === item} aria-disabled={controlsDisabled || (item === 'refined' && !canRefine)} disabled={controlsDisabled || (item === 'refined' && !canRefine)} onClick={() => { setVersion(item); setExportStatus('') }}>{item === 'original' ? '原始版' : '精修稿'}</button>)}</div>
          <div className="export-actions" aria-label="导出当前所选转写版本">{[['txt', 'TXT'], ['md', 'Markdown'], ['srt', 'SRT']].map(([format, label]) => <button key={format} data-export={format} disabled={controlsDisabled || (version === 'refined' && !canRefine)} onClick={() => void exportSelected(format)}>导出 {label}</button>)}</div></header>
          <div className="export-status" id="exportStatus" role="status" aria-live="polite">{exportStatus}</div>
          <nav className="timeline-navigation" aria-label="字幕批次导航"><button id="previousPage" aria-controls="timeline" disabled={detailPending || pageIndex === 0} onClick={() => selected && void loadPage(selected, pageIndex - 1, cursors)}>上一批</button>
            <div className="range-status" id="rangeStatus" role="status" aria-live="polite" aria-atomic="true">{detailError ? '读取失败，请重试' : detailPending ? '正在读取字幕批次…' : page ? (page.items.length === 0 ? (page.totalCount === 0 ? '共 0 条已定稿字幕' : `当前批次为空，共 ${page.totalCount} 条已定稿字幕`) : `第 ${offset + 1}–${offset + page.items.length} 条，共 ${page.totalCount} 条`) : ''}</div>
            <button id="nextPage" aria-controls="timeline" disabled={detailPending || !page?.nextCursor} onClick={() => selected && void loadPage(selected, pageIndex + 1, cursors)}>下一批</button>
            <button id="retryPage" aria-controls="timeline" hidden={!detailError} disabled={detailPending} onClick={() => selected && void loadPage(selected, pageIndex, cursors)}>重试</button></nav>
          <ol className="timeline" id="timeline" role="list" tabIndex={0} aria-busy={detailPending} aria-describedby="rangeStatus">{page?.items.length === 0 ? <li className="timeline-empty" role="listitem">这个会话没有已定稿字幕。</li> : page?.items.map((item: Dict, index: number) => <li className="timeline-item" role="listitem" aria-posinset={offset + index + 1} aria-setsize={page.totalCount} key={item.segmentId}><div className="time-code"><strong>{clock(item.t0Ms)}</strong><span>{new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date(page.session.startedAt + item.t0Ms))}</span></div><div className="caption-text">{body(item)}</div></li>)}</ol>
        </div></section></main></>
}

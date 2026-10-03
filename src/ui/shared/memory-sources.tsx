import type { ReactElement } from 'react'

type Dict = Record<string, any>
export function MemorySources ({ sources = [], onOpen }: { sources?: Dict[], onOpen: (target: Dict) => void }): ReactElement {
  return <ul className="agent-context-bullets" aria-label="记忆来源">{sources.map((source, index) => <li key={index}>
    <time dateTime={source.occurred_at}>{new Date(source.occurred_at).toLocaleString('zh-CN', { hour12: false })}</time>
    <p>{({ question_summary: '提问摘要', transcript_excerpt: '字幕片段', user_statement: '你提供的信息', missing_summary: '来源说明' } as Dict)[source.summary_kind]}：{source.summary}</p>
    {source.target && source.availability === 'accessible'
      ? <button type="button" className="link-btn" onClick={() => onOpen(source.target)}>查看记录</button>
      : source.availability === 'removed' && <span>来源记录已删除</span>}
  </li>)}</ul>
}

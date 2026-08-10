import React from 'react'

/* 功能性图标集。统一 16×16 网格、1.6 描边、currentColor、无填充，
   与设置窗 / 字幕历史窗的 17px 线性图标同族。
   只做功能识别，不画装饰性 AI 图形（docs/ui-design-brief.md）。
   图标永远是文字标签的补充，不允许出现只有图标没有可访问名称的控件。 */

type Props = { name: IconName; className?: string }
export type IconName =
  | 'speaker' | 'mic' | 'chat' | 'task' | 'doc' | 'chevron' | 'check' | 'close'
  | 'alert' | 'key' | 'plus' | 'clock' | 'spin' | 'retry' | 'ban' | 'question' | 'tool'

const PATHS: Record<IconName, React.ReactNode> = {
  speaker: <><path d="M3 6.5v3h2.5L9 12.5v-9L5.5 6.5H3Z" /><path d="M11.2 5.6a3.4 3.4 0 0 1 0 4.8" /></>,
  mic: <><rect x="6" y="2.2" width="4" height="7" rx="2" /><path d="M3.8 7.6a4.2 4.2 0 0 0 8.4 0M8 11.8v2" /></>,
  chat: <path d="M13.5 9.2a1.8 1.8 0 0 1-1.8 1.8H6l-3.5 2.5V4.3a1.8 1.8 0 0 1 1.8-1.8h7.4a1.8 1.8 0 0 1 1.8 1.8Z" />,
  task: <><path d="M5.5 4h8M5.5 8h8M5.5 12h8" /><path d="M2.5 4h.01M2.5 8h.01M2.5 12h.01" /></>,
  doc: <><path d="M4 2.5h5L12 5.5v8H4Z" /><path d="M9 2.5v3h3" /></>,
  chevron: <path d="M6 4l4 4-4 4" />,
  check: <path d="M3.2 8.4l3.2 3.2 6.4-7.2" />,
  close: <path d="M4 4l8 8M12 4l-8 8" />,
  alert: <><path d="M8 2.8 14 13H2Z" /><path d="M8 6.6v3M8 11.4h.01" /></>,
  key: <><circle cx="5.6" cy="6.4" r="2.6" /><path d="M7.6 8.4 13 13.8M10.4 11.2l1.4-1.4" /></>,
  plus: <path d="M8 3.5v9M3.5 8h9" />,
  clock: <><circle cx="8" cy="8" r="5.6" /><path d="M8 4.8V8l2.2 1.6" /></>,
  spin: <path d="M8 2.4a5.6 5.6 0 1 1-5.6 5.6" />,
  retry: <><path d="M13.2 8a5.2 5.2 0 1 1-1.6-3.7" /><path d="M13.4 2.6v3.2h-3.2" /></>,
  ban: <><circle cx="8" cy="8" r="5.6" /><path d="M4.2 4.2l7.6 7.6" /></>,
  question: <><circle cx="8" cy="8" r="5.6" /><path d="M6.4 6.3a1.7 1.7 0 1 1 1.9 1.9v1.1M8.2 11.6h.01" /></>,
  tool: <path d="M9.6 2.6a3.4 3.4 0 0 0 3.8 5.2L8 13.2a1.7 1.7 0 0 1-2.4-2.4l5.4-5.4A3.4 3.4 0 0 0 9.6 2.6Z" />
}

export function Icon ({ name, className }: Props) {
  return <svg className={`icon${className ? ` ${className}` : ''}`} viewBox="0 0 16 16" width="16" height="16"
    fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"
    aria-hidden="true" focusable="false">{PATHS[name]}</svg>
}

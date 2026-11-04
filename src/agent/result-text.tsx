import { type ReactElement } from 'react'

type InlineRun = { kind: 'text' | 'strong' | 'code', text: string }
type Block = { kind: 'p' | 'h3' | 'ul' | 'ol', items: Array<{ text: string, ordinal?: number }>, literal?: boolean }

const sentenceSegmenter = new Intl.Segmenter('zh', { granularity: 'sentence' })

// A deliberately small text-only subset. URLs, images and HTML never become
// interactive content, and unmatched formatting markers remain visible.
function inlineRuns (text: string): InlineRun[] {
  const runs: InlineRun[] = []
  let cursor = 0
  for (const match of text.matchAll(/\*\*([^*\n]+)\*\*|(?<!`)`([^`\n]+)`(?!`)/g)) {
    if (match.index > cursor) runs.push({ kind: 'text', text: text.slice(cursor, match.index) })
    runs.push({ kind: match[1] === undefined ? 'code' : 'strong', text: match[1] ?? match[2] })
    cursor = match.index + match[0].length
  }
  if (cursor < text.length) runs.push({ kind: 'text', text: text.slice(cursor) })
  return runs
}

function sliceRuns (runs: InlineRun[], from: number, through: number): InlineRun[] {
  let offset = 0
  return runs.flatMap(run => {
    const start = Math.max(0, from - offset)
    const end = Math.min(run.text.length, through - offset)
    offset += run.text.length
    return end > start ? [{ ...run, text: run.text.slice(start, end) }] : []
  })
}

function paragraphRuns (runs: InlineRun[]): InlineRun[][] {
  const text = runs.map(run => run.text).join('')
  if (Array.from(text).length <= 240) return [runs]
  const paragraphs: InlineRun[][] = []
  let start = 0
  let length = 0
  for (const { segment, index } of sentenceSegmenter.segment(text)) {
    const nextLength = Array.from(segment).length
    if (length > 0 && length + nextLength > 180) {
      paragraphs.push(sliceRuns(runs, start, index))
      start = index
      length = 0
    }
    length += nextLength
  }
  paragraphs.push(sliceRuns(runs, start, text.length))
  return paragraphs
}

function renderRuns (runs: InlineRun[]): ReactElement[] {
  return runs.map((run, index) => run.kind === 'strong'
    ? <strong key={index}>{run.text}</strong>
    : run.kind === 'code' ? <code key={index}>{run.text}</code> : <span key={index}>{run.text}</span>)
}

export function ResultText ({ text }: { text: string }): ReactElement {
  const blocks: Block[] = []
  let current: Block | null = null
  let fence: string | null = null
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    if (fence) {
      current!.items[0].text += '\n' + line
      if (line.trim() === fence) { fence = null; current = null }
      continue
    }
    const fenceStart = line.match(/^\s*(`{3,}|~{3,})/)
    if (fenceStart) {
      fence = fenceStart[1]
      current = { kind: 'p', items: [{ text: line }], literal: true }
      blocks.push(current)
      continue
    }
    if (!line.trim()) { current = null; continue }
    const heading = line.match(/^\s{0,3}#{1,3}\s+(.+)$/)
    if (heading) {
      blocks.push({ kind: 'h3', items: [{ text: heading[1] }] })
      current = null
      continue
    }
    const unordered = line.match(/^\s*[-*•]\s+(.+)$/)
    const ordered = line.match(/^\s*(\d{1,3})(?:[.)]\s+|[、）]\s*)(.+)$/)
    if (!unordered && !ordered && current && current.kind !== 'p' && /^\s+/.test(line)) {
      current.items.at(-1)!.text += '\n' + line.trimStart()
      continue
    }
    const kind = unordered ? 'ul' : ordered ? 'ol' : 'p'
    if (!current || current.kind !== kind) {
      current = { kind, items: [] }
      blocks.push(current)
    }
    if (kind === 'p' && current.items.length) current.items[0].text += '\n' + line
    else current.items.push({ text: unordered?.[1] ?? ordered?.[2] ?? line, ...(ordered ? { ordinal: Number(ordered[1]) } : {}) })
  }
  return <div className="result-prose">{blocks.flatMap((block, index) => {
    if (block.literal) return [<p key={index}>{block.items[0].text}</p>]
    if (block.kind === 'p') return paragraphRuns(inlineRuns(block.items[0].text))
      .map((runs, paragraphIndex) => <p key={`${index}.${paragraphIndex}`}>{renderRuns(runs)}</p>)
    if (block.kind === 'h3') return [<h3 key={index}>{renderRuns(inlineRuns(block.items[0].text))}</h3>]
    const items = block.items.map((item, itemIndex) => {
      const paragraphs = paragraphRuns(inlineRuns(item.text))
      return <li key={itemIndex} value={item.ordinal}>{paragraphs.length === 1 ? renderRuns(paragraphs[0])
        : paragraphs.map((runs, paragraphIndex) => <p key={paragraphIndex}>{renderRuns(runs)}</p>)}</li>
    })
    return [block.kind === 'ol' ? <ol key={index} start={block.items[0].ordinal}>{items}</ol> : <ul key={index}>{items}</ul>]
  })}</div>
}

'use strict'

const NON_PERSONAL = /(?:假如|假设|设想|如果我(?:是|担任)|这次|本次|仅这一次|(?:同事|朋友|客户|老师|别人|他|她)说|(?:替|代).{0,12}(?:问|提问)|\b(?:suppose|hypothetical|if i were|just this time|for this answer|he said|she said)\b)/iu
const LONG_TERM = /(?:以后|今后|长期|总是|每次|一直|通常|习惯|\b(?:prefer|always|from now on|in future)\b)/iu
const SELF = /(?:我|本人|\b(?:i|my)\b)/iu
const KNOWLEDGE_QUESTION = /(?:我(?:想|希望|需要)(?:知道|了解|问)|\b(?:what is|how does|what does)\b)/iu
const STYLE = /(?:例子|简短|详细|先给结论|先说结论|分步骤|列步骤|\b(?:concise|brief|example|step by step)\b)/iu

function questionSource (signal) {
  const kind = signal?.signalKind
  const text = kind === 'prompt' ? signal.prompt : ['edit', 'remember'].includes(kind) ? signal.editText : null
  const userText = typeof text === 'string' && text.length > 0 ? text : null
  const acceptedContent = ['accept', 'edit', 'remember'].includes(kind) ? signal.result : null
  if (userText === null) return { userText: null, eligibleUserSpans: [], acceptedContent }
  // Ranges are in Unicode code points, independently of JS UTF-16 offsets.
  // Quoted/code/third-party/hypothetical text remains visible as context, but
  // cannot be cited as a trusted personal statement.
  const points = Array.from(userText)
  const blocked = []
  const add = (match) => {
    const from = Array.from(userText.slice(0, match.index)).length
    blocked.push([from, from + Array.from(match[0]).length])
  }
  for (const match of userText.matchAll(/```[\s\S]*?(?:```|$)|`[^`]*`|“[^”]*”|‘[^’]*’|"[^"]*"|(?:^|\n)[ \t]*>[^\n]*/gu)) add(match)
  for (const match of userText.matchAll(/[^。！？.!?\n]+[。！？.!?\n]?/gu)) {
    if (NON_PERSONAL.test(match[0])) add(match)
  }
  const eligibleUserSpans = []
  let start = null
  for (let index = 0; index <= points.length; index += 1) {
    const allowed = index < points.length && !blocked.some(([from, through]) => index >= from && index < through)
    if (allowed && start === null) start = index
    if (!allowed && start !== null) {
      eligibleUserSpans.push({ fromCodePoint: start, throughCodePoint: index })
      start = null
    }
  }
  return { userText, eligibleUserSpans, acceptedContent }
}

function allowsQuestionCandidate (candidate, source) {
  if (!['self_statement', 'long_term_requirement', 'repeated_pattern'].includes(candidate?.attribution)) return false
  if (typeof source?.userText !== 'string') return false
  const evidence = candidate.userEvidence
  const points = Array.from(source.userText)
  if (!evidence || !Number.isSafeInteger(evidence.fromCodePoint) || !Number.isSafeInteger(evidence.throughCodePoint) ||
      evidence.fromCodePoint < 0 || evidence.throughCodePoint <= evidence.fromCodePoint ||
      evidence.throughCodePoint > points.length || evidence.throughCodePoint - evidence.fromCodePoint > 512) return false
  if (!source.eligibleUserSpans.some((range) => evidence.fromCodePoint >= range.fromCodePoint && evidence.throughCodePoint <= range.throughCodePoint)) return false
  const text = points.slice(evidence.fromCodePoint, evidence.throughCodePoint).join('')
  if (NON_PERSONAL.test(text) || KNOWLEDGE_QUESTION.test(text)) return false
  if (candidate.attribution === 'long_term_requirement') return LONG_TERM.test(text)
  if (candidate.attribution === 'repeated_pattern') return candidate.kind === 'preference' && STYLE.test(text)
  return SELF.test(text)
}

module.exports = { questionSource, allowsQuestionCandidate }

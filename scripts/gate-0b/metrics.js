'use strict'

const PUNCTUATION = new Set(Array.from('，。！？；：、,.!?;:'))

function toCharacters (value) {
  return Array.from(String(value).normalize('NFKC'))
}

function normalizeContent (value) {
  return toCharacters(value)
    .filter((char) => !PUNCTUATION.has(char) && !/\s/u.test(char) && /[\p{L}\p{N}]/u.test(char))
    .join('')
    .toLocaleLowerCase('en-US')
}

function normalizeWords (value) {
  return String(value)
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(/\s+/u)
    .filter(Boolean)
}

function editDistance (left, right) {
  const a = Array.from(left)
  const b = Array.from(right)
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index)

  for (let i = 1; i <= a.length; i += 1) {
    const current = [i]
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(
        current[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      )
    }
    previous = current
  }

  return previous[b.length]
}

function errorRate (reference, hypothesis) {
  const denominator = reference.length
  if (denominator === 0) return hypothesis.length === 0 ? 0 : 1
  return editDistance(reference, hypothesis) / denominator
}

function characterErrorRate (reference, hypothesis) {
  return errorRate(Array.from(normalizeContent(reference)), Array.from(normalizeContent(hypothesis)))
}

function wordErrorRate (reference, hypothesis) {
  return errorRate(normalizeWords(reference), normalizeWords(hypothesis))
}

function punctuationMetrics (reference, hypothesis) {
  const referenceMarks = toCharacters(reference).filter((char) => PUNCTUATION.has(char))
  const hypothesisMarks = toCharacters(hypothesis).filter((char) => PUNCTUATION.has(char))
  const referenceCounts = new Map()
  const hypothesisCounts = new Map()
  referenceMarks.forEach((mark) => referenceCounts.set(mark, (referenceCounts.get(mark) || 0) + 1))
  hypothesisMarks.forEach((mark) => hypothesisCounts.set(mark, (hypothesisCounts.get(mark) || 0) + 1))

  let truePositive = 0
  for (const [mark, count] of referenceCounts) {
    truePositive += Math.min(count, hypothesisCounts.get(mark) || 0)
  }
  const precision = hypothesisMarks.length === 0 ? (referenceMarks.length === 0 ? 1 : 0) : truePositive / hypothesisMarks.length
  const recall = referenceMarks.length === 0 ? 1 : truePositive / referenceMarks.length
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall)

  return {
    referenceCount: referenceMarks.length,
    hypothesisCount: hypothesisMarks.length,
    precision,
    recall,
    f1
  }
}

function percentile (values, probability) {
  if (!Array.isArray(values) || values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const rank = Math.max(0, Math.ceil(probability * sorted.length) - 1)
  return sorted[rank]
}

module.exports = {
  characterErrorRate,
  editDistance,
  normalizeContent,
  normalizeWords,
  percentile,
  punctuationMetrics,
  wordErrorRate
}

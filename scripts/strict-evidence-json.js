'use strict'

const { Buffer } = require('node:buffer')
const { TextDecoder } = require('node:util')

function parseStrictEvidenceJson (bytes, label = 'JSON evidence') {
  const sourceLabel = String(label)
  let text

  if (Buffer.isBuffer(bytes)) {
    if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
      throw new SyntaxError(`${sourceLabel}: UTF-8 BOM is not allowed`)
    }

    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch (error) {
      throw new SyntaxError(`${sourceLabel}: invalid UTF-8 input`, { cause: error })
    }
  } else if (typeof bytes === 'string') {
    text = bytes
  } else {
    throw new TypeError(`${sourceLabel}: expected a Buffer or UTF-8 string`)
  }

  if (text.charCodeAt(0) === 0xfeff) {
    throw new SyntaxError(`${sourceLabel}: UTF-8 BOM is not allowed`)
  }

  return new StrictJsonParser(text, sourceLabel).parse()
}

class StrictJsonParser {
  constructor (text, label) {
    this.text = text
    this.label = label
    this.index = 0
  }

  parse () {
    this.skipWhitespace()
    if (this.index === this.text.length) {
      this.fail('expected a JSON value')
    }

    const value = this.parseValue()
    this.skipWhitespace()
    if (this.index !== this.text.length) {
      this.fail('trailing input after the JSON value')
    }
    return value
  }

  parseValue () {
    const character = this.text[this.index]

    if (character === '{') return this.parseObject()
    if (character === '[') return this.parseArray()
    if (character === '"') return this.parseString()
    if (character === 't') return this.parseLiteral('true', true)
    if (character === 'f') return this.parseLiteral('false', false)
    if (character === 'n') return this.parseLiteral('null', null)
    if (character === '-' || isDigit(character)) return this.parseNumber()

    this.fail('expected a JSON value')
  }

  parseObject () {
    const value = {}
    const keys = new Set()
    this.index++
    this.skipWhitespace()

    if (this.text[this.index] === '}') {
      this.index++
      return value
    }

    while (true) {
      if (this.text[this.index] !== '"') {
        this.fail('expected a quoted object key')
      }

      const keyOffset = this.index
      const key = this.parseString()
      if (keys.has(key)) {
        this.fail(`duplicate object key ${JSON.stringify(key)}`, keyOffset)
      }
      keys.add(key)

      this.skipWhitespace()
      this.expect(':')
      this.skipWhitespace()
      const memberValue = this.parseValue()

      Object.defineProperty(value, key, {
        value: memberValue,
        enumerable: true,
        configurable: true,
        writable: true
      })

      this.skipWhitespace()
      const delimiter = this.text[this.index]
      if (delimiter === '}') {
        this.index++
        return value
      }
      if (delimiter !== ',') {
        this.fail('expected "," or "}" after an object member')
      }

      this.index++
      this.skipWhitespace()
    }
  }

  parseArray () {
    const value = []
    this.index++
    this.skipWhitespace()

    if (this.text[this.index] === ']') {
      this.index++
      return value
    }

    while (true) {
      value.push(this.parseValue())
      this.skipWhitespace()

      const delimiter = this.text[this.index]
      if (delimiter === ']') {
        this.index++
        return value
      }
      if (delimiter !== ',') {
        this.fail('expected "," or "]" after an array item')
      }

      this.index++
      this.skipWhitespace()
    }
  }

  parseString () {
    const start = this.index
    this.index++

    while (this.index < this.text.length) {
      const code = this.text.charCodeAt(this.index)
      const character = this.text[this.index]

      if (character === '"') {
        this.index++
        return JSON.parse(this.text.slice(start, this.index))
      }

      if (character === '\\') {
        const escapeOffset = this.index
        this.index++
        const escape = this.text[this.index]

        if (escape === 'u') {
          for (let offset = 1; offset <= 4; offset++) {
            if (!isHexDigit(this.text[this.index + offset])) {
              this.fail('invalid Unicode escape in string', escapeOffset)
            }
          }
          this.index += 5
          continue
        }

        if ('"\\/bfnrt'.includes(escape)) {
          this.index++
          continue
        }

        this.fail('invalid escape in string', escapeOffset)
      }

      if (code < 0x20) {
        this.fail('unescaped control character in string')
      }

      if (code >= 0xd800 && code <= 0xdbff) {
        const nextCode = this.text.charCodeAt(this.index + 1)
        if (nextCode < 0xdc00 || nextCode > 0xdfff) {
          this.fail('string input is not valid UTF-8 (unpaired surrogate)')
        }
        this.index += 2
        continue
      }
      if (code >= 0xdc00 && code <= 0xdfff) {
        this.fail('string input is not valid UTF-8 (unpaired surrogate)')
      }

      this.index++
    }

    this.fail('unterminated string', start)
  }

  parseNumber () {
    const start = this.index

    if (this.text[this.index] === '-') this.index++

    if (this.text[this.index] === '0') {
      this.index++
      if (isDigit(this.text[this.index])) {
        this.fail('leading zero is not allowed in a number')
      }
    } else if (isNonZeroDigit(this.text[this.index])) {
      while (isDigit(this.text[this.index])) this.index++
    } else {
      this.fail('expected a digit in number')
    }

    if (this.text[this.index] === '.') {
      this.index++
      if (!isDigit(this.text[this.index])) {
        this.fail('expected a digit after the decimal point')
      }
      while (isDigit(this.text[this.index])) this.index++
    }

    if (this.text[this.index] === 'e' || this.text[this.index] === 'E') {
      this.index++
      if (this.text[this.index] === '+' || this.text[this.index] === '-') this.index++
      if (!isDigit(this.text[this.index])) {
        this.fail('expected a digit in number exponent')
      }
      while (isDigit(this.text[this.index])) this.index++
    }

    const token = this.text.slice(start, this.index)
    const value = Number(token)
    if (!Number.isFinite(value)) {
      this.fail(`non-finite number ${token}`, start)
    }
    return value
  }

  parseLiteral (token, value) {
    const start = this.index
    if (this.text.slice(start, start + token.length) !== token) {
      this.fail(`invalid literal; expected ${token}`, start)
    }
    this.index += token.length
    return value
  }

  expect (character) {
    if (this.text[this.index] !== character) {
      this.fail(`expected ${JSON.stringify(character)}`)
    }
    this.index++
  }

  skipWhitespace () {
    while (isJsonWhitespace(this.text[this.index])) this.index++
  }

  fail (message, offset = this.index) {
    throw new SyntaxError(`${this.label}: ${message} at character ${offset}`)
  }
}

function isJsonWhitespace (character) {
  return character === ' ' || character === '\t' || character === '\n' || character === '\r'
}

function isDigit (character) {
  return character >= '0' && character <= '9'
}

function isNonZeroDigit (character) {
  return character >= '1' && character <= '9'
}

function isHexDigit (character) {
  return (character >= '0' && character <= '9') ||
    (character >= 'a' && character <= 'f') ||
    (character >= 'A' && character <= 'F')
}

module.exports = { parseStrictEvidenceJson }

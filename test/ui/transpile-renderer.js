'use strict'

const fs = require('node:fs')
const { stripTypeScriptTypes } = require('node:module')

function transpileRenderer (filePath) {
  return stripTypeScriptTypes(fs.readFileSync(filePath, 'utf8'), { mode: 'strip' })
    .replace(/\nexport \{\};?\s*$/, '\n')
}

module.exports = { transpileRenderer }

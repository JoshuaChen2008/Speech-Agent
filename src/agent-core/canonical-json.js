'use strict'

/* SEM-F29 候选入口与正式 storage worker 共用同一 canonical JSON 实现，
   但仍使用 ADR 0010 分离的 migration catalog。 */
module.exports = require('../runtime/storage-worker/canonical-json')

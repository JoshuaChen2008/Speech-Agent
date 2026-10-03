'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

test('SEM-F41/SEM-T04/J28-FILES: real Win32 handle excludes a competing process write and replacement through flush', { skip: process.platform !== 'win32' }, t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-native-lock-'))
  const file = path.join(directory, 'one.md'); fs.writeFileSync(file, 'synthetic old')
  const native = require('../../src/native/memory-file/memory_file_native.node')
  const handle = native.open(file, directory, false)
  t.after(() => { native.close(handle); fs.rmSync(directory, { recursive: true, force: true }) })
  const child = spawnSync(process.execPath, ['-e', `const fs=require('node:fs'); const file=process.argv[1]; let write=false,replace=false; try{fs.writeFileSync(file,'competitor')}catch{write=true} try{fs.writeFileSync(file+'.tmp','competitor'); fs.renameSync(file+'.tmp',file)}catch{replace=true} console.log(JSON.stringify({write,replace}));`, file], { encoding: 'utf8', windowsHide: true })
  assert.equal(child.status, 0); assert.deepEqual(JSON.parse(child.stdout), { write: true, replace: true })
  native.write(handle, Buffer.from('synthetic target')); assert.equal(native.read(handle).toString(), 'synthetic target')
  assert.throws(() => fs.renameSync(directory, `${directory}-moved`))
  native.close(handle); fs.writeFileSync(file, 'external after release'); assert.equal(fs.readFileSync(file, 'utf8'), 'external after release')
})

test('SEM-F41/SEM-T04/J28-FILES: Win32 handle rejects escaped root and hard links', { skip: process.platform !== 'win32' }, t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-native-roots-')); const root = path.join(directory, 'root'); fs.mkdirSync(root)
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const native = require('../../src/native/memory-file/memory_file_native.node'); const outside = path.join(directory, 'outside.md'); fs.writeFileSync(outside, 'synthetic')
  assert.throws(() => native.open(outside, root, false))
  const link = path.join(root, 'link.md'); fs.linkSync(outside, link); assert.throws(() => native.open(link, root, false))
})

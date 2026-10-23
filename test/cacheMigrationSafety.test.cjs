'use strict'
// 缓存迁移安全机制的源码契约测试（迁移逻辑在 main.cjs 闭包内，直测需 electron mock；
// 关键行为用源码断言锁定，防止回归删除）：
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const test = require('node:test')

const mainSource = fs.readFileSync(path.resolve('desktop/main.cjs'), 'utf8')
const configSource = fs.readFileSync(path.resolve('desktop/config-manager.cjs'), 'utf8')

test('迁移使用 O_EXCL 哨兵锁（防双实例并发互删）', () => {
  assert.match(mainSource, /openSync\(migrateLock, 'wx'\)/)
  assert.match(mainSource, /rmSync\(migrateLock/)
})

test('跨盘迁移是两阶段（先全量复制后删源）', () => {
  const start = mainSource.indexOf('跨盘：EXDEV')
  assert.ok(start >= 0, '跨盘分支存在')
  const endMark = mainSource.indexOf('缓存已迁移（copy）', start)
  assert.ok(endMark > start, 'copy 完成日志存在')
  const block = mainSource.slice(start, endMark)
  const pushIdx = block.indexOf('copiedEntries.push')
  const rmIdx = block.indexOf('rmSync(from')
  assert.ok(pushIdx >= 0, '复制阶段应先收集 copiedEntries')
  assert.ok(rmIdx > pushIdx, '删源必须在全部复制完成之后')
})

test('迁移时改写音频索引的绝对路径（防孤儿清理）', () => {
  assert.match(mainSource, /cache-index\.json/)
  assert.match(mainSource, /path\.relative\(newTempRoot/)
})

test('默认缓存路径：应用目录优先，写探针失败退回 userData', () => {
  assert.match(configSource, /write-probe-/)
  assert.match(configSource, /isPackaged/)
  assert.match(configSource, /userData'\), 'cache'\)/)
})

test('索引序列化为相对文件名（saveCacheIndex）', () => {
  const audioSource = fs.readFileSync(path.resolve('desktop/audio-download.cjs'), 'utf8')
  assert.match(audioSource, /path\.relative\(this\.tempRoot, resolved\)/)
})

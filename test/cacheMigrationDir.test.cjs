'use strict'

const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const test = require('node:test')
const { migrateCacheDir, rewriteAudioCacheIndexPath } = require('../desktop/config-manager.cjs')

const fixture = (t) => fs.mkdtempSync(path.join(os.tmpdir(), 'cache-migrate-dir-'))

test('同盘迁移 rename：内容完整、源目录消失', t => {
  const root = fixture(t)
  const from = path.join(root, 'old', 'cache')
  const to = path.join(root, 'new', 'cache')
  fs.mkdirSync(path.join(from, 'temp'), { recursive: true })
  fs.writeFileSync(path.join(from, 'temp', 'a.mp3'), 'audio')

  const r = migrateCacheDir(from, to)
  assert.equal(r.migrated, true)
  assert.equal(r.method, 'rename')
  assert.ok(fs.existsSync(path.join(to, 'temp', 'a.mp3')))
  assert.ok(!fs.existsSync(from), '源目录应消失')
})

test('跨盘迁移（模拟）：两阶段复制，中途失败不丢源数据', t => {
  const root = fixture(t)
  const from = path.join(root, 'old', 'cache')
  const to = path.join(root, 'new', 'cache')
  fs.mkdirSync(path.join(from, 'big'), { recursive: true })
  fs.writeFileSync(path.join(from, 'big', 'data.bin'), 'x'.repeat(1000))
  fs.writeFileSync(path.join(from, 'small.txt'), 'hello')

  // 模拟目标盘中途不可写：先占住目标文件名（目录），copyFileSync 会抛 EISDIR/EPERM
  fs.mkdirSync(path.join(to, 'small.txt'), { recursive: true })
  const r = migrateCacheDir(from, to)
  // copy 阶段失败 → migrated=false，且**源数据必须原地保留**（两阶段保证）
  assert.equal(r.migrated, false)
  assert.ok(fs.existsSync(path.join(from, 'big', 'data.bin')), '源数据不得因迁移失败丢失')
  assert.ok(fs.existsSync(path.join(from, 'small.txt')))
})

test('目标非空 → 拒绝迁移（不覆盖已有数据）', t => {
  const root = fixture(t)
  const from = path.join(root, 'old', 'cache')
  const to = path.join(root, 'new', 'cache')
  fs.mkdirSync(from, { recursive: true })
  fs.writeFileSync(path.join(from, 'a.txt'), 'old')
  fs.mkdirSync(to, { recursive: true })
  fs.writeFileSync(path.join(to, 'b.txt'), 'existing')

  const r = migrateCacheDir(from, to)
  assert.equal(r.migrated, false)
  assert.equal(r.error, 'destination not empty')
  assert.ok(fs.existsSync(path.join(to, 'b.txt')), '已有数据不动')
  assert.ok(fs.existsSync(path.join(from, 'a.txt')))
})

test('源为空 → 跳过', t => {
  const root = fixture(t)
  const from = path.join(root, 'old', 'cache')
  const to = path.join(root, 'new', 'cache')
  fs.mkdirSync(from, { recursive: true })
  fs.writeFileSync(path.join(from, 'cache-index.json'), '[]') // 仅索引 = 空语义
  const r = migrateCacheDir(from, to)
  assert.equal(r.migrated, false)
})

test('并发防护：锁被占 → 第二次调用直接拒绝', t => {
  const root = fixture(t)
  const from = path.join(root, 'old', 'cache')
  const to = path.join(root, 'new', 'cache')
  fs.mkdirSync(from, { recursive: true })
  fs.writeFileSync(path.join(from, 'a.txt'), 'data')
  // 手工占锁（模拟另一实例正在迁移）：锁在 dirname(to) 下，目录需先存在
  fs.mkdirSync(path.dirname(to), { recursive: true })
  const lockPath = path.join(path.dirname(to), `.cache-migrate-${path.basename(to)}.lock`)
  fs.writeFileSync(lockPath, 'held')
  const r = migrateCacheDir(from, to)
  assert.equal(r.migrated, false)
  assert.equal(r.error, 'another migration in progress')
  assert.ok(fs.existsSync(path.join(from, 'a.txt')), '被拒时源数据不动')
})

test('rewriteAudioCacheIndexPath：绝对路径→相对文件名，外部路径清空', t => {
  const root = fixture(t)
  const newCache = path.join(root, 'new', 'cache')
  const legacyCache = path.join(root, 'old', 'cache')
  fs.mkdirSync(path.join(newCache, 'temp'), { recursive: true })
  const idx = [
    { trackKey: 'a', filePath: path.join(legacyCache, 'temp', 'aaa.mp3') },
    { trackKey: 'b', filePath: 'bbb.mp3' },                            // 已是相对名
    { trackKey: 'c', filePath: path.join(root, 'elsewhere', 'c.mp3') }, // 外部位置
  ]
  fs.writeFileSync(path.join(newCache, 'temp', 'cache-index.json'), JSON.stringify(idx))
  const n = rewriteAudioCacheIndexPath(newCache, legacyCache)
  assert.equal(n, 2)
  const after = JSON.parse(fs.readFileSync(path.join(newCache, 'temp', 'cache-index.json'), 'utf8'))
  assert.equal(after[0].filePath, 'aaa.mp3')
  assert.equal(after[1].filePath, 'bbb.mp3')
  assert.equal(after[2].filePath, '')
})

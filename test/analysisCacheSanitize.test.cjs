'use strict'

const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const test = require('node:test')
const { sanitizeAnalysisCaches } = require('../desktop/analysis-runtime.cjs')

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'waveforge-analysis-sanitize-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 10 }))
  return root
}

const write = (root, name, content) => fs.writeFileSync(path.join(root, name), typeof content === 'string' ? content : JSON.stringify(content))
const read = (root, name) => fs.existsSync(path.join(root, name))

const GOOD = { trackKey: 'qq:1', schemaVersion: 2, duration: 200, provider: 'beat_this', beats: Array.from({ length: 400 }, (_, i) => i * 0.5), downbeats: [0, 2] }

test('sanitizeAnalysisCaches cures all four poisoned shapes and keeps good records', t => {
  const root = fixture(t)
  // F1 损坏 JSON（半截写入）
  write(root, 'f1.json', '{"trackKey":"qq:broken","dur')
  // F2 trackKey 缺失
  write(root, 'f2.json', { duration: 100, beats: [1, 2] })
  // F3 duration 非正但带节拍
  write(root, 'f3.json', { trackKey: 'qq:f3', duration: 0, beats: [1, 2, 3] })
  // F4 节拍越界（qq:857362 实测形态：176s 音频带 251s 节拍）
  write(root, 'f4.json', { trackKey: 'qq:f4', duration: 176, beats: Array.from({ length: 100 }, (_, i) => i * 2.6) })
  // 好记录必须保留
  write(root, 'good.json', GOOD)
  // 非 .json 文件不管
  write(root, 'note.txt', 'keep me')

  const r = sanitizeAnalysisCaches([root])
  assert.equal(r.scanned, 5)
  assert.equal(r.cured, 4)
  assert.ok(!read(root, 'f1.json'), 'F1 损坏 json 应删除')
  assert.ok(!read(root, 'f2.json'), 'F2 缺 trackKey 应删除')
  assert.ok(!read(root, 'f3.json'), 'F3 duration 非正应删除')
  assert.ok(!read(root, 'f4.json'), 'F4 节拍越界应删除')
  assert.ok(read(root, 'good.json'), '好记录保留')
  assert.ok(read(root, 'note.txt'), '非 json 文件不管')
})

test('sanitizeAnalysisCaches tolerates the +1s tolerance and missing dirs', t => {
  const root = fixture(t)
  // 节拍恰好超出 1s 以内（尾帧对齐误差）→ 不算毒
  write(root, 'edge-ok.json', { trackKey: 'qq:edge', duration: 100, beats: Array.from({ length: 50 }, (_, i) => i * 2.0), downbeats: [0] })
  const r = sanitizeAnalysisCaches([root, path.join(root, 'not-exist')])
  assert.equal(r.cured, 0)
  assert.ok(read(root, 'edge-ok.json'))
})

test('sanitizeAnalysisCaches cures weak browser-fallback records (F5, pre-guard legacy)', t => {
  const root = fixture(t)
  // 弱 browser-fallback（conf<0.55）——isWeakBrowserFallback 守卫上线前的历史残留
  //（实测磁盘 123 条，写入时间 09-20→10-15）。读取侧已免疫，治疗侧也要能清。
  write(root, 'weak-fb.json', { trackKey: 'qq:weak-fb', provider: 'browser-fallback', confidence: 0.16, duration: 134, beats: Array.from({ length: 200 }, (_, i) => i * 0.4), downbeats: [0, 2] })
  // 强 browser-fallback（conf>=0.55）必须保留——它是合法可用的分析
  write(root, 'strong-fb.json', { trackKey: 'qq:strong-fb', provider: 'browser-fallback', confidence: 0.8, duration: 134, beats: Array.from({ length: 200 }, (_, i) => i * 0.4), downbeats: [0, 2] })
  const r = sanitizeAnalysisCaches([root])
  assert.equal(r.cured, 1)
  assert.ok(!read(root, 'weak-fb.json'), '弱 fallback 应删除')
  assert.ok(read(root, 'strong-fb.json'), '强 fallback 保留')
})

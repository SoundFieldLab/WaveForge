'use strict'

// QQ 音质候选链契约（2026-10-20 审计修复：手动档不再按过期 isVip 裁剪，vkey 是唯一事实标准）
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const test = require('node:test')

const src = fs.readFileSync(path.resolve('local-server.mjs'), 'utf8')

const functionBody = () => {
  const start = src.indexOf('function getQQQualityCandidates')
  return src.slice(start, src.indexOf('\n}', start))
}

test('getQQQualityCandidates 签名不含 isVip（手动档与自动档同口径）', () => {
  assert.match(src, /function getQQQualityCandidates\(preference\) \{/)
  assert.ok(!functionBody().includes('isVip'), '候选链内不得消费 vip 标志')
})

test('无损/Hi-Res 手动档候选链含 flac（非 VIP 也先探测，由 vkey 裁决）', () => {
  const body = functionBody()
  assert.ok(body.includes("case 'lossless': return ['flac', '320', '128', 'm4a']"))
  // hi-res 与 lossless 共享回落链（fall-through case）
  assert.ok(body.includes("case 'hi-res':"))
  assert.ok(body.includes("case 'lossless': return ['flac'"))
})

test('自动档链不含超级会员专享档（设计口径：自动不上超专档）', () => {
  const autoLine = functionBody().match(/preference === 'auto'\) return \[[^\]]+\]/)?.[0] || ''
  assert.ok(!autoLine.includes('dolby') && !autoLine.includes('master') && !autoLine.includes('atmos2'))
})

test('QQ 路由调用点已不传 isVip', () => {
  assert.match(src, /const candidates = getQQQualityCandidates\(qualityPreference\)/)
  assert.ok(!src.includes('getQQQualityCandidates(qualityPreference, isVip)'))
})

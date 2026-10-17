'use strict'

// 「放几首就放不了」这一类的可观测性契约。
//
// 线上现象：QQ 音频 URL 在 05:22:29 解析、05:26:30 才交给 <audio> 加载（间隔 4 分 01 秒），
// 加载失败但日志只打出 `{}`——因为 MediaError 不是 Error，code/message 在原型上。
// 于是既看不出失败原因，也看不出 URL 年龄，无从判断是不是链接过期。
//
// 这里守住：错误必须可读、URL 年龄必须可查、重试路径必须留痕。
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8')

test('媒体加载失败必须给出 MediaError 的 code，而不是 {}', () => {
  const player = read('src/hooks/useAudioPlayer.ts')
  assert.ok(player.includes('SRC_NOT_SUPPORTED'), '缺少 MediaError code 名称映射')
  assert.ok(player.includes('media load failed: code='), '失败信息应带 code')
  // 不许再原样 reject(active.error)——那正是日志变成 {} 的原因
  assert.ok(
    !player.includes('reject(active.error || new Error('),
    '不得原样 reject MediaError（会被序列化成 {}）',
  )
})

test('日志转发要认识 MediaError / DOMException 这类宿主对象', () => {
  const entry = read('src/main.tsx')
  assert.ok(entry.includes('hasCode'), 'describeConsoleArg 需要识别 code 字段')
  assert.ok(entry.includes('renderer-warn'), 'console.warn 也应转发到后端日志（重试诊断是 warn 级）')
})

test('QQ 音频 URL 缓存必须封顶，避免把已失效链接交给播放器', () => {
  const api = read('src/services/musicApi.ts')
  assert.ok(api.includes('QQ_SONG_URL_MAX_TTL = 2 * 60 * 1000'), 'QQ URL 缓存应封顶 2 分钟')
  assert.ok(
    api.includes("platform === 'qq'") && api.includes('Math.min(rawTtl ?? QQ_SONG_URL_MAX_TTL, QQ_SONG_URL_MAX_TTL)'),
    'QQ 需按封顶值收窄 TTL',
  )
  // 需要记录解析时刻才能算年龄（否则只剩 expiresAt，无法回答「这条链接多老了」）
  assert.ok(api.includes('resolvedAt: url ? now : 0'), '缓存项需记录 resolvedAt')
})

test('命中偏老 URL 与重试路径都要留痕', () => {
  const api = read('src/services/musicApi.ts')
  assert.ok(api.includes('[SongUrl] 命中偏老 URL'), '命中偏老 URL 时应 warn（带 platform/id/age）')

  const app = read('src/App.tsx')
  assert.ok(app.includes('首次加载失败，重试'), '重试要打出 trackKey 与原 URL 年龄')
  assert.ok(app.includes('getSongUrl 返回 null'), '重试拿不到新链接时要有明确留痕')
  assert.ok(app.includes('取到与失败 URL 相同的链接'), '重试拿到同一链接时要有明确留痕')
})

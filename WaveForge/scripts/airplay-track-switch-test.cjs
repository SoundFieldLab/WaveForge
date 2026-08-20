// 切歌行为自测：连接 → 推音频 → 中途 setMetadata(换 trackKey，触发 sender.reset/FLUSH)
// → 观察是否 session-ended / 自动重连 / buffer 抖动（双重奏与重连音效的根源）。
'use strict'
const { AirplaySenderService } = require('../desktop/airplay/airplay-sender-service.cjs')

const CHUNK_FRAMES = 4096
const SAMPLE_RATE = 44100
const CHANNELS = 2

const svc = new AirplaySenderService({
  debug: true,
  onStatus: (status) => {
    const mark = status.phase === 'streaming' || status.phase === 'connected' ? '' : ' <<<<'
    console.log(`[status] phase=${status.phase} mode=${status.connectedMode || '-'}${status.message ? ' msg=' + status.message : ''}${mark}`)
  },
})

function tonePcm(seconds) {
  const frames = seconds * SAMPLE_RATE
  const pcm = Buffer.alloc(frames * CHANNELS * 2)
  for (let f = 0; f < frames; f += 1) {
    const t = f / SAMPLE_RATE
    const v = (Math.floor(t / 0.5) % 2 === 0) ? Math.sin(2 * Math.PI * 1000 * t) * 0.12 : 0
    const s = Math.round(v < 0 ? v * 0x8000 : v * 0x7fff)
    for (let c = 0; c < CHANNELS; c += 1) pcm.writeInt16LE(s, (f * CHANNELS + c) * 2)
  }
  return pcm
}

function pushOnce(pcm) {
  svc.sendPcm(pcm)
}

svc.ensureBrowsing()
console.log('🔎 发现设备…')
setTimeout(() => {
  const target = svc.listDevices().find((d) => /xiaomi/i.test(d.name)) || svc.listDevices()[0]
  if (!target) { console.log('❌ 无设备'); process.exit(1) }
  console.log(`🎯 ${target.name}`)
  const res = svc.connect(target.id, 'airplay2')
  if (!res?.success) { console.log('❌ 连接失败'); process.exit(1) }
  console.log('✅ 已连接，推流中…')
  svc.setStreaming(true)
  const song1 = tonePcm(5)
  const song2 = tonePcm(5)
  const t0 = Date.now()
  // 推歌1（分块，实时节奏）
  let offset = 0
  const pushTimer = setInterval(() => {
    const chunk = song1.subarray(offset, Math.min(offset + CHUNK_FRAMES * CHANNELS * 2, song1.length))
    if (chunk.length > 0) { pushOnce(chunk); offset += chunk.length } else { clearInterval(pushTimer); onSongEnd(1) }
  }, 90)
  function onSongEnd(n) {
    console.log(`\n--- 歌${n}推完，切歌（setMetadata 换 trackKey）… ---`)
    svc.setMetadata({ trackKey: `song-${n + 1}`, title: `Song ${n + 1}`, artist: 'test', album: '', coverUrl: '', durationMs: 5000, elapsedMs: 0 })
    // 推歌2
    let off2 = 0
    const t2 = setInterval(() => {
      const chunk = song2.subarray(off2, Math.min(off2 + CHUNK_FRAMES * CHANNELS * 2, song2.length))
      if (chunk.length > 0) { pushOnce(chunk); off2 += chunk.length } else { clearInterval(t2); finish() }
    }, 90)
  }
  function finish() {
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1)
    console.log(`\n✅ 完成，总耗时 ${elapsed}s`)
    svc.setStreaming(false)
    setTimeout(() => { svc.disconnect(); process.exit(0) }, 1500)
  }
}, 3000)

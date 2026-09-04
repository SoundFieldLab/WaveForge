// AirPlay 延迟自测脚本（真机）：
// 1. 验证连接模式与设备是否响应 Audio-Latency（latencyFrames 生效与否）
// 2. 量化"暂停后音箱残余播放"：停止推流瞬间读取发送端缓冲剩余 + 反推 RTP 时间轴锚点
// 用法：node scripts/airplay-latency-self-test.cjs [mode]
//   mode: auto | airplay2 | raop（默认 auto）
'use strict'
const { AirplaySenderService } = require('../desktop/airplay/airplay-sender-service.cjs')

const TARGET_MODE = process.argv[2] || 'auto'
const CHUNK_FRAMES = 4096
const SAMPLE_RATE = 44100
const CHANNELS = 2
const PACKET_FRAMES = 352 // RAOP 每包帧数
const TEST_SECONDS = 12

const svc = new AirplaySenderService({
  debug: true,
  onStatus: (status) => {
    console.log(`[status] phase=${status.phase} mode=${status.connectedMode || '-'}${status.message ? ' msg=' + status.message : ''}`)
  },
})

const stats = {
  connectStartMs: 0,
  pushStartMs: 0,
  pushEndMs: 0,
  rtpTimeRef: null, // 从 metrics 反推：rtpTimeRef = Date.now() - deltaMs - seq*7.98ms
  lastMetricsAt: 0,
  lastSeq: 0,
  lastDeltaMs: 0,
  lastLatencyFrames: 0,
  bufferRemainBytes: 0,
}

function pushTestTone(seconds, onDone) {
  svc.setStreaming(true)
  const totalChunks = Math.ceil((seconds * SAMPLE_RATE) / CHUNK_FRAMES)
  let pushed = 0
  stats.pushStartMs = Date.now()
  const timer = setInterval(() => {
    if (pushed >= totalChunks) {
      clearInterval(timer)
      stats.pushEndMs = Date.now()
      // 停止推流瞬间读取发送端缓冲剩余（暂停后音箱还会继续播的部分）
      const cb = svc.sender?.airtunes?.circularBuffer
      stats.bufferRemainBytes = cb?.currentSize ?? 0
      svc.setStreaming(false)
      onDone()
      return
    }
    const pcm = Buffer.alloc(CHUNK_FRAMES * CHANNELS * 2)
    for (let f = 0; f < CHUNK_FRAMES; f += 1) {
      const t = (pushed * CHUNK_FRAMES + f) / SAMPLE_RATE
      // 1kHz 短音 + 静音交替：便于人耳/录音确认设备确有播放
      const v = (Math.floor(t / 0.5) % 2 === 0) ? Math.sin(2 * Math.PI * 1000 * t) * 0.15 : 0
      const s = Math.round(v < 0 ? v * 0x8000 : v * 0x7fff)
      for (let c = 0; c < CHANNELS; c += 1) pcm.writeInt16LE(s, (f * CHANNELS + c) * 2)
    }
    svc.sendPcm(pcm)
    pushed += 1
  }, 92)
}

function attachMetrics() {
  const airtunes = svc.sender?.airtunes
  if (!airtunes) return
  airtunes.removeAllListeners('metrics')
  let syncCount = 0
  airtunes.on('metrics', (m) => {
    if (m?.type !== 'sync') return
    syncCount += 1
    stats.lastSeq = m.seq
    stats.lastDeltaMs = m.deltaMs
    stats.lastLatencyFrames = m.latencyFrames || 0
    stats.lastMetricsAt = Date.now()
    // rtpTimeRef = Date.now() - deltaMs - seq * 7.98ms（deltaMs 为发送时刻与 RTP 播放时刻的偏差）
    stats.rtpTimeRef = Date.now() - m.deltaMs - m.seq * (PACKET_FRAMES / SAMPLE_RATE) * 1000
    if (syncCount <= 8 || syncCount % 10 === 0) {
      console.log(`[metrics] seq=${m.seq} deltaMs=${m.deltaMs.toFixed(1)}ms latencyFrames=${m.latencyFrames}（≈${((m.latencyFrames || 0) / SAMPLE_RATE * 1000).toFixed(0)}ms）`)
    }
  })
}

function report() {
  console.log('\n===== 延迟量化报告 =====')
  console.log(`连接模式: ${svc.connectedMode}`)
  const elapsedFromConnect = Date.now() - stats.connectStartMs

  // 1. 补偿是否激活：latencyFrames > 0 表示 setLatencyFrames 生效
  const compensated = stats.lastLatencyFrames > 0
  console.log(`补偿机制: ${compensated ? `激活（latencyFrames=${stats.lastLatencyFrames}，≈${(stats.lastLatencyFrames / SAMPLE_RATE * 1000).toFixed(0)}ms）` : '未激活（latencyFrames=0，设备未响应 Audio-Latency）'}`)

  // 2. RTP 时间轴锚点：对比「前移量」与「连接后经过时间」，
  //    前移量 = 补偿前移(如有) + 连接后经过时间 → 差值即补偿前移量
  if (stats.rtpTimeRef !== null) {
    const shift = Date.now() - stats.rtpTimeRef
    console.log(`RTP 时间轴前移量: ${(shift / 1000).toFixed(2)}s（连接后经过 ${(elapsedFromConnect / 1000).toFixed(2)}s，差值 ${((shift - elapsedFromConnect) / 1000).toFixed(2)}s = 补偿前移量）`)
  }

  // 3. 停止推流时发送端缓冲剩余 = 暂停后音箱还会继续播的真实音频（发送端部分）
  const remainPackets = stats.bufferRemainBytes / (PACKET_FRAMES * CHANNELS * 2)
  const remainMs = (remainPackets * PACKET_FRAMES / SAMPLE_RATE) * 1000
  console.log(`停止推流瞬间发送端缓冲剩余: ${stats.bufferRemainBytes} 字节 ≈ ${remainMs.toFixed(0)}ms 音频`)

  // 4. 推流节奏核对（应≈实时）
  const pushedMs = (stats.pushEndMs - stats.pushStartMs)
  const audioMs = TEST_SECONDS * 1000
  console.log(`推流节奏: ${audioMs}ms 音频 / ${pushedMs}ms 实际耗时（越接近实时越好）`)

  console.log('==============================')
  console.log('说明：')
  console.log('  发送端缓冲剩余 = 暂停后音箱继续响的发送端部分（新缓冲 60 包≈0.48s 上限）。')
  console.log('  补偿激活 + 设备按时间戳播放时，暂停后残余应≈发送端缓冲剩余（<0.5s）；')
  console.log('  若实测仍远大于此值，剩余来自音箱自身缓冲/积累（协议无法消除）。')
}

function runMode(mode, done) {
  const devices = svc.listDevices()
  // 优先选支持 AirPlay 2 的 Xiaomi Sound（延迟可协商路径），其次名字匹配音箱，最后任意
  const target =
    devices.find((d) => /xiaomi/i.test(d.name)) ||
    devices.find((d) => d.hasAirplay2) ||
    devices.find((d) => /sound|mini|homepod|tv/i.test(d.name)) ||
    devices[0]
  if (!target) {
    console.log('❌ 未发现任何 AirPlay 设备')
    done(null)
    return
  }
  console.log(`📋 全部设备: ${devices.map((d) => `${d.name}[${d.hasAirplay2 ? 'AP2' : 'RAOP'}]`).join('、')}`)
  console.log(`\n🎯 设备: ${target.name}（hasRaop:${target.hasRaop} hasAirplay2:${target.hasAirplay2} ip:${target.addresses?.[0] || target.host}）`)
  stats.connectStartMs = Date.now()
  const res = svc.connect(target.id, mode)
  console.log(`🔌 connect(${mode}) ->`, JSON.stringify(res))
  if (!res?.success) {
    done(null)
    return
  }
  attachMetrics()
  setTimeout(() => {
    console.log(`▶️  推送 ${TEST_SECONDS}s 测试音频（1kHz 断续音）…`)
    pushTestTone(TEST_SECONDS, () => {
      console.log('⏹️  停止推流（模拟暂停，音箱应继续播完缓冲中的音频）')
      report()
      setTimeout(() => {
        svc.disconnect()
        done(res)
      }, 2500)
    })
  }, 2000)
}

svc.ensureBrowsing()
console.log(`🔎 正在发现 AirPlay 设备（目标模式 ${TARGET_MODE}）…`)
setTimeout(() => {
  const devices = svc.listDevices()
  if (devices.length === 0) {
    console.log('❌ 3s 内未发现设备，继续等待…')
  } else {
    console.log(`📋 已发现: ${devices.map((d) => d.name).join('、')}`)
  }
  runMode(TARGET_MODE, (res) => {
    if (res) console.log('\n✅ 测试完成（该模式可连接并推流）')
    else console.log('\n❌ 测试失败')
    process.exit(0)
  })
}, 3000)

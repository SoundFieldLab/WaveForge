/**
 * DG_LAB 郊狼中继/控制器（local-server 内嵌模块）。
 *
 * 职责：
 * 1) 本地 WS 服务器（默认 30082 端口，可配置）：
 *    - /dglab/v3    —— V3 协议（郊狼 3.0，手机 DG-Lab App 扫码连入，1 控制端 : 1 App）
 *    - /dglab/v4    —— V4 协议（郊狼 4.0/新 App，App 以 ?tid=控制端ID 连入，1 : N）
 *    - /dglab/ctrl  —— WaveForge 渲染端控制/音频数据通道（引擎启停、设置、30fps 音频特征）
 * 2) 内置控制器：V3 bind 配对、strength/clear/波形帧下发；V4 devices.get RPC、
 *    device.op 指令（动作码 0 AppendPulseData / 3 AddIntensity / 4 SetTempIntensity / 7 SetIntensity）。
 * 3) 音频→电流映射引擎（Energy/Onset 双驱动、灵敏度/曲线/平滑、0-200 软钳位
 *    min(用户上限, App softLimit)，断链/停止/静音自动 clear 归零）。
 *
 * 协议细节以 dungeonlab-open/dglab-websocket-server 与 DG-LAB-OPENSOURCE 官方文档为准；
 * V3 波形帧采用官方 8 字节帧（4×频率字节 + 4×强度字节，≈100ms/帧）。
 * 真实 App 联调差异可在控制台「调试日志」面板观察实际下发帧。
 */

const http = require('http')
const os = require('os')
const crypto = require('crypto')
const { WebSocketServer, WebSocket } = require('ws')
const QRCode = require('qrcode')

const DEFAULT_PORT = 30082
const MAX_LOGS = 120

/* ---------------------------------- 常量 ---------------------------------- */

// V3 通道：A=1 / B=2（在线帧用数字通道）
const V3_CHANNEL = { A: 1, B: 2 }
void V3_CHANNEL // 保留注释性引用（通道映射见 v3ChannelNumber）

// V4 动作码与通道
const V4_ACTION = { Pulse: 0, AddIntensity: 3, SetTempIntensity: 4, SetIntensity: 7 }
const V4_CHANNEL = { A: 0, B: 1 }

// 扫码 schema：与官方/成熟实现（PyDGLab-WS dg_lab_client_qrcode）逐字符一致——
// V3 的 ws 地址「原样拼接不编码」：...#DGLAB-SOCKET#ws://host:port/<targetId>
const QR_V4 = (wsUrl) => `https://dungeon-lab.cn/s/?v=1&action=socket&url=${encodeURIComponent(wsUrl)}`
const QR_V3 = (wsUrl) => `https://www.dungeon-lab.com/app-download.php#DGLAB-SOCKET#${wsUrl}`

/* ---------------------------------- 工具 ---------------------------------- */

/** 网卡列表（含名称），私网段优先、跳过链路本地；供控制台选择「用哪个网卡给手机扫码」。 */
function networkInterfaces() {
  const list = []
  const isPrivate = (addr) => {
    const parts = String(addr).split('.').map(Number)
    if (parts.length !== 4) return false
    return parts[0] === 10
      || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
      || (parts[0] === 192 && parts[1] === 168)
  }
  try {
    const nets = os.networkInterfaces()
    for (const key of Object.keys(nets)) {
      for (const item of nets[key] || []) {
        if (!item.internal && item.family === 'IPv4' && item.address && !item.address.startsWith('169.254.')) {
          list.push({ address: item.address, name: `${key}${isPrivate(item.address) ? '' : ''}` })
        }
      }
    }
  } catch {
    /* ignore */
  }
  return list.length ? list : [{ address: '127.0.0.1', name: 'localhost' }]
}

function lanAddresses() {
  return networkInterfaces().map(i => i.address)
}

function nowStamp() {
  return new Date().toLocaleTimeString('zh-CN', { hour12: false })
}

function uuid() {
  return crypto.randomUUID()
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

function clamp01Local(v) {
  return clamp(v, 0, 1)
}

/* ---------------------------------- 波形帧工具 ---------------------------------- */

/** 官方 V3 波形帧：8 字节 = 4×频率 + 4×强度。 */
function frameToHex({ freq, strength }) {
  const f = clamp(Math.round(freq), 0, 255)
  const s = clamp(Math.round(strength), 0, 200)
  return [f, f, f, f, s, s, s, s].map(b => b.toString(16).toUpperCase().padStart(2, '0')).join('')
}

/**
 * 内置波形生成（帧序列，每帧 ≈100ms）：
 * - continuous 连续：固定频率、固定强度
 * - breath     呼吸：频率恒定、强度正弦渐变
 * - tide       潮汐：频率与强度同步渐进（官方示例形态）
 * - beat       节拍：短促冲击，首帧峰值后快速衰减
 */
function generateBuiltinWave(id, { freq = 20, strength = 100 } = {}) {
  const frames = []
  if (id === 'continuous') {
    for (let i = 0; i < 8; i += 1) frames.push({ freq, strength })
  } else if (id === 'breath') {
    const n = 16
    for (let i = 0; i < n; i += 1) {
      const env = Math.sin((Math.PI * i) / (n - 1))
      frames.push({ freq, strength: Math.round(10 + env * strength) })
    }
  } else if (id === 'tide') {
    const n = 16
    for (let i = 0; i < n; i += 1) {
      const t = i / (n - 1)
      frames.push({ freq: Math.round(10 + t * 50), strength: Math.round(20 + t * (strength - 20)) })
    }
  } else if (id === 'dglab-sweep') {
    // 官方实时音频机制模板（1:1 对齐官方 assets/M2_simple.csv）：
    // 触发后播放一段 freq 10→30Hz + 强度 0→100→20 的攻击-衰减扫掠段（≈0.9s）
    // 官方 lookup：freq=10,10,10,20,20,20,30,30,30  strength=0,20,40,60,80,100,100,60,20
    const m2 = [0, 20, 40, 60, 80, 100, 100, 60, 20]
    for (let i = 0; i < m2.length; i += 1) {
      const f = [10, 10, 10, 20, 20, 20, 30, 30, 30][i] ?? 10
      frames.push({ freq: f, strength: Math.round((m2[i] / 100) * strength) })
    }
  } else {
    // beat：冲击 + 快速衰减
    for (let i = 0; i < 5; i += 1) {
      const mult = i === 0 ? 1 : Math.max(0.12, 1 - i * 0.28)
      frames.push({ freq: freq + i * 6, strength: Math.round(strength * mult) })
    }
  }
  return frames
}

/* ---------------------------------- 中继工厂 ---------------------------------- */

function createDGLabRelay() {
  const state = {
    running: false,
    server: null,
    wss: null,
    settings: {
      version: 'v3', // 'v3' | 'v4'
      port: DEFAULT_PORT,
      lanEnabled: true, // 默认局域网可连（手机扫码需要），可在控制台关闭
      devMode: false, // 开发者模式：详细调试日志
      /** 体感风格（7 套）。默认「立体声」：A=左、B=右。 */
      feelStyle: 'stereo',
      sensitivity: 1,
      smoothing: 0.5,
      /** 强度差档位（体质）：strong=强(30)/medium=中(12)/weak=弱(5)/custom=自定义 stepLimit。默认弱（最轻度）。 */
      stepPreset: 'weak',
      /** 自定义强度差（stepPreset=custom 时生效）。 */
      stepLimit: 5,
      /** 恢复适应时间档位：快 1s / 中 2.5s / 慢 5s。默认慢（最轻度）。 */
      rampPreset: 'slow',
      /** 动态适配：根据歌曲轻响自动分配强度（AGC）。 */
      dynamicRange: true,
      /** 实时映射（对齐官方实时音频）：auto=自适应 / manual=自定义 */
      rtMode: 'auto',
      rtGain: 1, // 数据增益
      rtRange: 0.6, // 范围（窗口宽度）
      rtHigh: 0.25, // 高适应系数（信号强时自适应速度）
      rtLow: 0.08, // 低适应系数（信号弱时回落速度）
      rtHys: 0.05, // 迟滞系数（阈值附近防抖）
      rtBand: 'all', // 观察频段：all/low/mid/high/stereo
      rtFreqMap: 'linear', // 频率映射：linear/log/deep/bright
      caps: { A: 60, B: 60 }, // 0-200 用户上限
      driveMode: 'energy', // 'energy' | 'onset'
      pulseEnabled: true,
      waveId: 'beat',
      waveFrames: null, // 导入波形帧（渲染端下发）
      waveFreq: 20,
      waveStrength: 100,
      systemCapture: false, // 整机监听（系统扬声器 loopback）：豁免播放暂停门控
    },
    engine: { running: false, lastAudioAt: 0, lastSendAt: 0, seenAudio: false, requested: false, warnedEngineIdle: false },
    listenRetries: 0,
    app: { v3: null, v4: new Map() }, // v3: 单 App ws；v4: Map(tid -> ws)
    ctrlClients: new Set(),
    clientId: uuid(),
    v3AppId: null,
    devices: [], // V4 slot snapshot
    softLimit: null, // {A,B}（V3 App 反馈）
    deviceStrength: null, // {A,B}（App 反馈的设备当前强度）
    bound: false,
    logs: [],
    timers: { heartbeat: null, silence: null },
  }

  const log = (message) => {
    const line = `[${nowStamp()}] ${message}`
    state.logs.push(line)
    if (state.logs.length > MAX_LOGS) state.logs.splice(0, state.logs.length - MAX_LOGS)
    broadcastCtrl({ t: 'log', line })
    // 信息级日志（连接/bind/启停/扫码地址等）始终输出到后端进程控制台；
    // 帧内容/下发明细等调试级日志由 verboseLog（devMode）控制
    if (process.env.NODE_ENV !== 'test') console.log(`[DG_LAB] ${message}`)
  }

  /** 开发者模式详细日志（settings.devMode 开启后输出到后端控制台与调试面板）。 */
  const verboseLog = (message) => {
    if (state.settings.devMode) log(`[调试] ${message}`)
  }

  // 强度帧下发日志节流（30Hz 全打会刷屏，500ms 汇总一条）
  let lastVerboseSend = 0
  const verboseThrottled = (message) => {
    if (!state.settings.devMode) return
    const now = Date.now()
    if (now - lastVerboseSend < 500) return
    lastVerboseSend = now
    log(`[调试] ${message}`)
  }

  /** 把收到的帧转成可读摘要（解析失败给 hex 预览）。 */
  const summarizeFrame = (raw) => {
    const text = raw.toString()
    try {
      const parsed = JSON.parse(text)
      return JSON.stringify(parsed).slice(0, 200)
    } catch {
      return `raw(${text.length}B): ${text.slice(0, 80).replace(/[^\x20-\x7E]/g, '·')}`
    }
  }

  const connected = () => {
    if (state.settings.version === 'v3') return Boolean(state.app.v3 && !state.app.v3.isClosed && state.bound)
    return state.app.v4.size > 0
  }

  /* ------------------------------ 渲染端广播 ------------------------------ */

  const buildStatus = () => {
    // 手机扫码需要局域网可达：优先用户手选的网卡地址，否则取第一个可用局域网 IP
    const all = networkInterfaces()
    const picked = state.settings.address && all.some(i => i.address === state.settings.address)
      ? state.settings.address
      : (all[0]?.address || '127.0.0.1')
    // V3/V4：App 通过 Socket 控制「扫码/手输」连入。官方 README 的 V3 二维码格式为
    // ws://host:port/<控制端targetId>（targetId 放路径），URL query/tid 作为兼容回退
    const base = `ws://${picked}:${state.settings.port}`
    const urlV3 = `${base}/${state.clientId}`
    const urlV4 = `${base}/dglab/v4?tid=${state.clientId}`
    return {
      t: 'status',
      running: state.running,
      state: !state.running ? 'idle' : connected() ? 'bound' : 'waiting',
      version: state.settings.version,
      port: state.settings.port,
      lanIps: all.map(i => i.address),
      ips: all,
      devMode: Boolean(state.settings.devMode),
      qrV3: state.settings.version === 'v3' ? QR_V3(urlV3) : null,
      qrV4: state.settings.version === 'v4' ? QR_V4(urlV4) : null,
      qrGenerated: false,
      deviceName: state.devices[0]?.name || (state.v3AppId ? 'DG-Lab App' : null),
      slotIds: state.devices.map(d => d.slotId),
      softLimit: state.softLimit,
      deviceStrength: state.deviceStrength,
      bound: state.bound,
    }
  }

  const broadcastCtrl = (message) => {
    const payload = JSON.stringify(message)
    for (const client of state.ctrlClients) {
      if (client.readyState === WebSocket.OPEN) client.send(payload)
    }
  }

  const broadcastStatus = () => broadcastCtrl(buildStatus())

  const pushLogsTo = (client) => {
    for (const line of state.logs) {
      if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify({ t: 'log', line }))
    }
  }

  /* ------------------------------ 安全：归零 ------------------------------ */

  // 安全归零日志浓缩：只在真正发送给已连接设备时记录，且 50s 内最多一条
  let lastClearLogAt = 0
  const logClearCondensed = (message) => {
    const now = Date.now()
    if (now - lastClearLogAt > 50000) {
      lastClearLogAt = now
      log(message)
    }
  }

  const sendClear = () => {
    let sent = false
    for (const ch of ['A', 'B']) {
      if (state.settings.version === 'v3' && state.app.v3 && state.bound) {
        sendV3Clear(ch)
        sent = true
      } else if (state.settings.version === 'v4' && state.app.v4.size > 0) {
        for (const [slotId] of state.app.v4) {
          sendV4Rpc(slotId, { m: 'device.op.clear', data: { s: slotId, c: V4_CHANNEL[ch] } })
          sent = true
        }
      }
    }
    // 仅当设备已连接并实际收到 clear 时才记日志（未连接时不刷屏）
    if (sent) logClearCondensed('安全归零：已发送 clear')
  }

  const safetyStop = (reason) => {
    if (!state.engine.running && !connected()) return
    log(reason)
    state.engine.running = false
    try { sendClear() } catch { /* ws closed */ }
    broadcastStatus()
  }

  /* ------------------------------ V3 指令（与官方 v3-server 帧格式一致） ------------------------------ */

/** 通道 → 数字（V3 在线帧用 1/2 表示 A/B）。 */
const v3ChannelNumber = (channel) => (channel === 'B' || channel === 'b' || channel === 2 ? 2 : 1)

const sendV3Strength = (channel, strength) => {
  if (!state.app.v3 || !state.bound) return
  const message = `strength-${v3ChannelNumber(channel)}+2+${clamp(strength, 0, 200)}` // op: 0减 1加 2设定
  state.app.v3.send(JSON.stringify({ type: 'msg', clientId: state.clientId, targetId: state.v3AppId, message }))
  verboseThrottled(`V3 下发强度 ${message}`)
}

const sendV3Clear = (channel) => {
  if (!state.app.v3 || !state.bound) return
  const message = `clear-${v3ChannelNumber(channel)}`
  state.app.v3.send(JSON.stringify({ type: 'msg', clientId: state.clientId, targetId: state.v3AppId, message }))
  // 单通道清除不单独打日志：由 sendClear 的「安全归零」汇总日志（50s 浓缩）覆盖，避免刷屏
}

const sendV3Pulse = (channel, frames) => {
  if (!state.app.v3 || !state.bound || !frames?.length) return
  // 官方：pulse-<通道字母>:["16位HEX帧",...]（16 位 HEX = 8 字节帧）
  const message = `pulse-${channel}:${JSON.stringify(frames.map(frameToHex))}`
  state.app.v3.send(JSON.stringify({ type: 'msg', clientId: state.clientId, targetId: state.v3AppId, message }))
  verboseLog(`V3 下发脉冲 ${channel} ${frames.length}帧 message=${message.slice(0, 80)}...`)
}

  /* ------------------------------ V4 指令 ------------------------------ */

  const sendV4Rpc = (slotId, { m, data }) => {
    const app = state.app.v4.get(findAppForSlot(slotId))
    if (!app || app.readyState !== WebSocket.OPEN) return
    app.send(JSON.stringify({ t: 'req', reqId: uuid(), m, data: { ...data, s: slotId } }))
  }

  const findAppForSlot = (slotId) => {
    for (const [tid, app] of state.app.v4) {
      if (!app.isClosed) return tid
    }
    return state.app.v4.keys().next().value
  }

  const sendV4Strength = (channelIdx, strength) => {
    const slotId = state.devices[0]?.slotId
    if (!slotId) return
    for (const tid of state.app.v4.keys()) {
      const app = state.app.v4.get(tid)
      if (app.isClosed) continue
      const value = clamp(strength, 0, 200)
      const data = { c: channelIdx, t: V4_ACTION.SetIntensity, v: value }
      app.send(JSON.stringify({ t: 'req', reqId: uuid(), m: 'device.op', data: { s: slotId, ...data } }))
      verboseThrottled(`V4 下发强度 c=${channelIdx}=${value}（slot=${slotId}）`)
      break // 1:N 时后续扩展：默认首个已连接设备
    }
  }

  const sendV4Pulse = (channelIdx, frames) => {
    const slotId = state.devices[0]?.slotId
    if (!slotId) return
    const hex = frames.map(frameToHex)
    const data = { c: channelIdx, t: V4_ACTION.Pulse, v: hex, p: 1, ver: 3 }
    for (const app of state.app.v4.values()) {
      if (!app.isClosed) {
        app.send(JSON.stringify({ t: 'req', reqId: uuid(), m: 'device.op', data: { s: slotId, ...data } }))
        verboseLog(`V4 下发脉冲 c=${channelIdx} ${frames.length}帧 hex0=${hex[0]}`)
        break
      }
    }
  }

  /* ------------------------------ 体感风格引擎 ------------------------------ */

  // 强度差档位（体质）：单次更新(≈30Hz)最大强度变化量
  const STEP_PRESETS = { strong: 30, medium: 12, weak: 5 }
  // 恢复适应时间（秒）：暂停后续播 / 输出重新启用 / 引擎启动时的淡入时长
  const RAMP_PRESETS = { fast: 1, medium: 2.5, slow: 5 }
  // 各风格脉冲载体频率（Hz）：决定「敲击」的手感（低频沉、高频锐）
  const STYLE_CARRIER = { stereo: 35, heartbeat: 40, breath: 150, wave: 60, tap: 3, ride: 120, rumble: 25 }
  // 默认档位（最轻度）：强度差=弱、恢复=慢
  const DEFAULT_STEP_PRESET = 'weak'
  const DEFAULT_RAMP_PRESET = 'slow'

  const engineState = {
    A: { target: 0, current: 0 },
    B: { target: 0, current: 0 },
    agc: 0.25, // 动态适配基线（歌曲响度慢速均值）
    speed: 1, // 乐速因子（快歌跟手快、慢歌起伏缓）
    lastBeatAt: -1000,
    prevBeat: 0, // 上一帧 beat（脉冲上升沿触发用）
    lastPulseAt: -1000, // 上一次脉冲时间（冷却）
    pulsePeriod: 0.5, // 节拍间隔（由 BPM 估计得出，用于节拍锁定连续触发）
    liveWaveAt: 0, // LiveWave 实时波形流计时（每 100ms 一帧）
    liveWaveSide: 'A', // A/B 交替
    tick: 0, // 帧计数（事件脉冲的时间轴）
    phase1: 0, // 呼吸/潮汐 LFO 相位（多相）
    phase2: 0,
    eventsA: [], // 事件脉冲 {born, amp, tau(帧)}
    eventsB: [],
    tapSide: 'A',
    lastTapAt: -1000,
    fluxMean: 0.015,
    ramp: null, // { startedAt, duration }
    paused: false, // 播放暂停：立即归零
    outputOn: true, // 波形输出启禁（播放页按钮）
    dutyOn: 0,
    dutyWindowStart: Date.now(),
    energyEnv: 0.2, // 持续振动层能量包络（句级，1:1 跟歌）
    envPeak: 0.4, // 原厂自动量程的近期峰值基线
    rtHeld: 0, // 迟滞死带的当前保持值
    loggedLR: false,
  }

  /** 上限预算系数（轻段巡航参照；最终按能量动态 45%~100%）。 */
  const CAP_BUDGET = 0.62

  /** 事件脉冲入队（用于心跳/敲击/重拳等节拍触发层）。 */
  const pushEvent = (arr, amp, tauFrames) => {
    if (amp > 0.02) arr.push({ born: engineState.tick, amp: Math.min(1, amp), tau: tauFrames })
    if (arr.length > 12) arr.shift()
  }
  /** 事件层当前幅值（指数衰减）。 */
  const eventsLevel = (arr) => {
    let level = 0
    for (let i = arr.length - 1; i >= 0; i -= 1) {
      const e = arr[i]
      const age = engineState.tick - e.born
      if (age > e.tau * 5) arr.splice(i, 1)
      else level = Math.max(level, e.amp * Math.exp(-age / Math.max(1, e.tau)))
    }
    return level
  }

  /**
   * 7 套体感风格：输入 ctx 返回 {A, B}（0..1 目标强度）。
   * ctx: { bass, mid, high, overall, beat, accent, flux, L, R, slowG }
   * A/B 通道角色与自研事件脉冲均在此定义（不依赖原厂波形）。
   */
  const STYLES = {
    stereo: {
      id: 'stereo',
      label: '立体声',
      desc: 'A=左声道、B=右声道——感受歌曲真实的左右声像，贴大腿左右最有区分度',
      render: (ctx) => {
        const { bass, mid, high, beat, accent, L, R } = ctx
        const hasLR = (L.overall > 0.001 || R.overall > 0.001)
        let A, B
        if (hasLR) {
          // 左/右为主，同时并入各自中高频（人声/旋律）纹理——正常唱歌也持续有波形
          A = clamp(L.overall * 1.0 + L.bass * 0.35 + L.mid * 0.22 + L.high * 0.12, 0, 1)
          B = clamp(R.overall * 1.0 + R.mid * 0.3 + R.high * 0.18 + R.bass * 0.18, 0, 1)
        } else {
          A = clamp(bass * 0.9 + mid * 0.3 + high * 0.15, 0, 1)
          B = clamp(mid * 0.8 + high * 0.45 + bass * 0.2, 0, 1)
        }
        if (beat > 0.3) pushEvent(engineState.eventsA, beat, 0.18 * 30)
        if (accent > 0.3) pushEvent(engineState.eventsB, accent, 0.15 * 30)
        A = clamp(A * 0.75 + eventsLevel(engineState.eventsA) * 0.55, 0, 1)
        B = clamp(B * 0.75 + eventsLevel(engineState.eventsB) * 0.55, 0, 1)
        // 通道比保持：归一化到 max=1，保住左右对比度，上限对两通道等比缩放
        const m = Math.max(A, B)
        if (m > 0.001) {
          A /= m
          B /= m
        }
        return { A, B }
      },
    },
    heartbeat: {
      id: 'heartbeat',
      label: '心跳',
      desc: '每一拍一次「咚-哒」双脉冲，从 A 侧扫到 B 侧——像贴近心脏的律动',
      render: (ctx) => {
        const { bass, mid, beat, accent } = ctx
        if (beat > 0.3) {
          pushEvent(engineState.eventsA, 0.9 * Math.min(1, beat), 0.12 * 30)
          pushEvent(engineState.eventsB, 0.65 * (0.5 + 0.5 * accent), 0.09 * 30)
        }
        return {
          A: clamp(bass * 0.4 + eventsLevel(engineState.eventsA), 0, 1),
          B: clamp(mid * 0.3 + eventsLevel(engineState.eventsB), 0, 1),
        }
      },
    },
    breath: {
      id: 'breath',
      label: '呼吸',
      desc: '6-10 秒一次缓慢起伏，两个通道交替扩张收缩——轻柔绵长',
      render: (ctx) => {
        const { bass, mid, slowG } = ctx
        const T = 8
        engineState.phase1 = (engineState.phase1 + 1 / (T * 30)) % 1
        const depth = 0.45 + 0.5 * slowG
        const envA = 0.15 + 0.65 * (0.5 + 0.5 * Math.sin(engineState.phase1 * 2 * Math.PI))
        const envB = 0.15 + 0.65 * (0.5 + 0.5 * Math.sin((engineState.phase1 + 0.5) * 2 * Math.PI))
        return {
          A: clamp(envA * depth + bass * 0.12, 0, 1),
          B: clamp(envB * depth + mid * 0.1, 0, 1),
        }
      },
    },
    wave: {
      id: 'wave',
      label: '潮汐',
      desc: '波浪从一侧缓缓滚到另一侧——像潮汐一样来回流动',
      render: (ctx) => {
        const { bass, mid, overall } = ctx
        const T1 = (14 - mid * 6) / 2 // 双 LFO 合成滚动
        const T2 = 3
        engineState.phase1 = (engineState.phase1 + 1 / (Math.max(3, T1 * 30))) % 1
        engineState.phase2 = (engineState.phase2 + 1 / (T2 * 30)) % 1
        const tri = (p) => 1 - Math.abs(((p * 2) % 2) - 1)
        const env = (p, tb) => 0.12 + 0.5 * tri(p) + 0.22 * (0.5 + 0.5 * Math.sin(p * 2 * Math.PI)) + 0.1 * tb
        const off = 0.3
        return {
          A: clamp(env(engineState.phase1, overall) + bass * 0.12, 0, 1),
          B: clamp(env((engineState.phase1 + off) % 1, overall) + mid * 0.12, 0, 1),
        }
      },
    },
    tap: {
      id: 'tap',
      label: '敲击',
      desc: '鼓点与瞬态变成短促点击，左右交替——节奏感最清晰的风格',
      render: (ctx) => {
        const { beat, flux, nowMs } = ctx
        engineState.fluxMean = engineState.fluxMean + (flux - engineState.fluxMean) * 0.06
        const onset = flux > Math.max(0.02, engineState.fluxMean * 1.5)
        if (onset && nowMs - engineState.lastTapAt > 90) {
          engineState.lastTapAt = nowMs
          const side = engineState.tapSide
          pushEvent(side === 'A' ? engineState.eventsA : engineState.eventsB, 1, 0.05 * 30)
          if (beat > 0.3) pushEvent(engineState.eventsA, beat * 0.6, 0.06 * 30)
          engineState.tapSide = side === 'A' ? 'B' : 'A'
        }
        return {
          A: clamp(eventsLevel(engineState.eventsA), 0, 1),
          B: clamp(eventsLevel(engineState.eventsB), 0, 1),
        }
      },
    },
    ride: {
      id: 'ride',
      label: '流动',
      desc: '连绵平缓的基底，随歌声轻柔起伏——最温和的连续风格',
      render: (ctx) => {
        const { overall, nowMs } = ctx
        const slow = 0.5 + 0.5 * Math.sin(((nowMs % 7000) / 7000) * 2 * Math.PI)
        return {
          A: clamp(0.2 + 0.3 * overall + 0.15 * slow, 0, 0.65),
          B: clamp(0.2 + 0.3 * overall + 0.12 * slow, 0, 0.65),
        }
      },
    },
    rumble: {
      id: 'rumble',
      label: '重拳',
      desc: '低音重击 + 持续低音基底——最有力的低音体感，建议小强度起步',
      render: (ctx) => {
        const { bass, beat, accent } = ctx
        if (beat > 0.3) {
          pushEvent(engineState.eventsA, Math.min(1, beat), 0.15 * 30)
          pushEvent(engineState.eventsB, Math.min(1, beat) * 0.6, 0.12 * 30)
        }
        if (accent > 0.3) pushEvent(engineState.eventsA, accent * 0.6, 0.11 * 30)
        return {
          A: clamp(bass * 0.35 + eventsLevel(engineState.eventsA), 0, 1),
          B: clamp(0.05 + 0.3 * bass + eventsLevel(engineState.eventsB), 0, 1),
        }
      },
    },
    stock: {
      id: 'stock',
      label: '原厂',
      desc: '1:1 复刻官方实时机制：观察频段→自适应增益→频率映射→LiveWave',
      render: (ctx) => {
        // 直接以「观察能量（rt 增益后）」为强度，不做风格整形——官方实时引擎的原始行为
        const e = clamp01Local(ctx.overall)
        return { A: e, B: clamp01Local(e * 0.92) }
      },
    },
  }

  const getStyle = () => STYLES[state.settings.feelStyle] || STYLES.stereo

  /** 恢复淡入（续播/输出启用/启动）：按「恢复档」从 0 缓升。 */
  const startRamp = () => {
    const duration = RAMP_PRESETS[state.settings.rampPreset] ?? RAMP_PRESETS[DEFAULT_RAMP_PRESET]
    engineState.ramp = { startedAt: Date.now(), duration }
  }

  /** 设备(重)连接后自动恢复引擎：渲染端仍希望运行时（requested），断链归零后可自动续跑并带恢复淡入。 */
  const maybeAutoRunEngine = () => {
    if (state.engine.requested && !state.engine.running && connected()) {
      state.engine.running = true
      state.engine.lastAudioAt = Date.now()
      state.engine.warnedEngineIdle = false
      engineState.A = { target: 0, current: 0 }
      engineState.B = { target: 0, current: 0 }
      startRamp()
      startSilenceGuard()
      log('设备已(重)连接，映射引擎按「恢复档」自动续跑')
      broadcastStatus()
    }
  }

  const mapAudio = (audio) => {
    const s = state.settings
    const bass = audio.bass ?? 0
    const mid = audio.mid ?? 0
    const high = audio.high ?? 0
    const overall = clamp(audio.overall ?? 0, 0, 1)
    const beat = audio.beat ?? 0
    const accent = audio.accent ?? 0
    const flux = audio.flux ?? 0
    const L = audio.left ?? { bass: 0, mid: 0, high: 0, overall: 0 }
    const R = audio.right ?? { bass: 0, mid: 0, high: 0, overall: 0 }
    const now = Date.now()

    engineState.tick += 1

    // ===== 观察频段 + 实时增益（对齐官方实时音频参数体系）=====
    // 观察频段：驱动增益/实时波形的频段能量
    const rtBand = s.rtBand || 'all'
    let obsE = overall
    if (rtBand === 'low') obsE = bass
    else if (rtBand === 'mid') obsE = mid
    else if (rtBand === 'high') obsE = high
    else if (rtBand === 'stereo') obsE = Math.max(L.overall, R.overall)
    const inV = clamp(obsE * (s.rtGain ?? 1), 0, 1.5)
    let gainNorm
    if (s.rtMode === 'auto') {
      // 自适应：增益随输入能量持续自适应（高适应系数=信号强时的收敛速度，低适应系数=弱时的回落速度）
      engineState.agc += (inV - engineState.agc) * (inV > engineState.agc ? (s.rtHigh ?? 0.25) : (s.rtLow ?? 0.08))
      gainNorm = clamp((s.rtRange ?? 0.6) / Math.max(engineState.agc, 0.01), 0.3, 3)
    } else {
      // 自定义：数据增益 → 范围窗口归一 → 迟滞死带（阈值附近防抖）
      const lowE = 0.03
      const highE = lowE + (s.rtRange ?? 0.6)
      let x = clamp((inV - lowE) / Math.max(highE - lowE, 0.01), 0, 1)
      const hs = s.rtHys ?? 0.05
      if (Math.abs(x - engineState.rtHeld) > hs) engineState.rtHeld = x
      else x = engineState.rtHeld
      gainNorm = x
    }
    const agcGain = s.rtMode === 'auto' ? (s.feelStyle === 'stock' ? clamp(gainNorm, 0.3, 4.5) : gainNorm) : 0.2 + gainNorm * 1.2
    const norm = (v) => clamp((v ?? 0) * agcGain, 0, 1.2)

    // 观察能量包络（驱动持续振动层与实时波形频率）
    // 原厂自适应 = 自动量程：相对「近期峰值基线」（强段→1.0 贴近上限、安静回落快），其余风格沿用窗口归一
    let envSrc
    let envDecay
    if (s.feelStyle === 'stock' && s.rtMode === 'auto') {
      engineState.envPeak = Math.max(obsE, engineState.envPeak * 0.99)
      envSrc = (s.rtGain ?? 1) * clamp(obsE / Math.max(engineState.envPeak, 0.05), 0, 1.2)
      envDecay = 0.25
    } else {
      envSrc = norm(obsE)
      envDecay = 0.1
    }
    engineState.energyEnv += (clamp01Local(envSrc) - engineState.energyEnv) * (clamp01Local(envSrc) > engineState.energyEnv ? 0.3 : envDecay)

    // 乐速估计（升降快慢随歌）：节拍间隔 + flux 速率加权；同时刷新节拍间隔供脉冲节拍锁定
    if (beat > 0.3) {
      const ibi = now - engineState.lastBeatAt
      if (ibi > 200 && ibi < 3000) {
        const bpm = 60000 / ibi
        const ibiPart = clamp((bpm - 80) / 260, 0, 1) * 0.8
        const fluxPart = clamp((flux - 0.006) / 0.03, 0, 1) * 0.4
        engineState.speed += (clamp(0.5 + ibiPart + fluxPart, 0.5, 1.8) - engineState.speed) * 0.12
        engineState.pulsePeriod = ibi / 1000
      }
      engineState.lastBeatAt = now
    } else {
      const fluxPart = clamp((flux - 0.006) / 0.03, 0, 1) * 0.4
      engineState.speed += (clamp(0.5 + fluxPart, 0.5, 1.8) - engineState.speed) * 0.04
    }

    // 风格映射（0..1）
    const slowG = engineState.agc // 复用 AGC 基线作为慢包络参考
    const ctx = { bass: norm(bass), mid: norm(mid), high: norm(high), overall: norm(overall), beat, accent, flux, L, R, slowG, nowMs: now }
    let { A: rawA, B: rawB } = getStyle().render(ctx)
    const isStock = (state.settings.feelStyle === 'stock')

    // ===== 持续振动层（苹果式循环反馈）：非原厂风格持续有体感；原厂 1:1 直通不做整形 =====
    if (!isStock) {
      const floor = 0.10 + 0.22 * engineState.energyEnv
      rawA = clamp(rawA * 0.78 + floor, 0, 1)
      rawB = clamp(rawB * 0.78 + floor, 0, 1)
    }
    rawA = clamp01Local(rawA)
    rawB = clamp01Local(rawB)

    // 真静音（≈无声音）才归零；轻柔乐句由持续层兜住
    if (overall < 0.008) {
      rawA = 0
      rawB = 0
    }

    // 立体声左右声道可用性（诊断一次；等音乐真正响起来（主信号有能量）再判定）
    if (state.settings.feelStyle === 'stereo' && !engineState.loggedLR && overall > 0.05) {
      engineState.loggedLR = true
      const hasLR = (L.overall + L.bass + R.overall + R.bass) > 0.001
      log(hasLR ? '立体声：左右声道数据可用（真实左右声像体感）' : '立体声：左右声道未接入（可能音效合并了声道），走频段退化（A=低频 B=中高频）')
    }

    // 灵敏度曲线 + 平滑（快歌跟手快；非原厂 1.2 更温和，原厂线性 1.0 直通）
    const curve = (v) => Math.pow(clamp(v * s.sensitivity, 0, 1), isStock ? 1.0 : 1.2)
    const sp = engineState.speed
    const attack = (0.12 + s.smoothing * 0.2) / sp
    const decay = (0.25 + s.smoothing * 0.32) / sp
    const tier = STEP_PRESETS[s.stepPreset] != null ? STEP_PRESETS[s.stepPreset] : Math.max(0, s.stepLimit ?? STEP_PRESETS[DEFAULT_STEP_PRESET])
    const step = Math.max(0, tier * sp)
    const glide = (ch, raw) => {
      const c = engineState[ch]
      const target = clamp(raw * 200, 0, 200)
      c.target = target
      const alpha = target >= c.current ? attack : decay
      let delta = (target - c.current) * alpha
      if (step > 0) delta = clamp(delta, -step, step)
      c.current = clamp(c.current + delta, 0, 200)
    }
    glide('A', curve(rawA))
    glide('B', curve(rawB))

    // 恢复淡入（续播/输出启用）：0→1 线性
    let rampGain = 1
    if (engineState.ramp) {
      const el = (now - engineState.ramp.startedAt) / (engineState.ramp.duration * 1000)
      rampGain = clamp(el, 0, 1)
      if (el >= 1) engineState.ramp = null
    }

    // 占空比守卫：30s 内高强占比过高 → 连续层自动收敛（抗疲劳）
    const windowMs = 30000
    if (engineState.dutyWindowStart + windowMs < now) {
      engineState.dutyWindowStart = now
      engineState.dutyOn = 0
    }
    if (engineState.A.current > 16 || engineState.B.current > 16) engineState.dutyOn += 1 / 30
    const duty = engineState.dutyOn / (windowMs / 1000)
    let dutyTaper = 1
    if (duty > 0.7) dutyTaper = duty > 0.75 ? 0.1 : 1 - ((duty - 0.7) / 0.05) * 0.3

    // 通道上限（硬上限，用户设定就该可达）+ 上限预算动态化：
    // 轻段巡航≈45% 上限，强段/大能量自动逼近 100% 上限（用户开 200 强段就能到 200）
    const aCap = Math.min(s.caps.A ?? 60, state.softLimit?.A ?? 200)
    const bCap = Math.min(s.caps.B ?? 60, state.softLimit?.B ?? 200)
    const rawAmp = engineState.A.current * rampGain * dutyTaper
    const rawBmp = engineState.B.current * rampGain * dutyTaper
    const budgetCeilA = Math.max(0.3, 0.45 + 0.55 * engineState.energyEnv) * aCap
    const budgetCeilB = Math.max(0.3, 0.45 + 0.55 * engineState.energyEnv) * bCap
    let outA
    let outB
    if (isStock) {
      // 原厂直通：强度 = 自适应相对能量 × 动态预算上限（强段贴近用户上限，无风格整形/曲线）；
      // 恢复淡入 + 抗疲劳守卫与其余风格一致（恢复从 0 缓升）
      outA = clamp(Math.round(budgetCeilA * clamp01Local(engineState.energyEnv) * rampGain * dutyTaper), 0, aCap)
      outB = clamp(Math.round(budgetCeilB * clamp01Local(engineState.energyEnv * 0.92) * rampGain * dutyTaper), 0, bCap)
      if (overall < 0.008) { outA = 0; outB = 0 }
    } else {
      // 预算按对等比缩放（钳位前计算，保住左右/风格对比）
      const budgetScale = Math.min(1, budgetCeilA / Math.max(rawAmp, 1), budgetCeilB / Math.max(rawBmp, 1))
      outA = clamp(rawAmp * budgetScale, 0, aCap)
      outB = clamp(rawBmp * budgetScale, 0, bCap)
    }
    return { A: Math.round(outA), B: Math.round(outB), beat, accent }
  }

  const runEngine = (audio) => {
    if (!state.engine.running || !connected() || !audio) return
    state.engine.lastAudioAt = Date.now()
    // 播放暂停 / 波形输出禁用：归零态保持（清理由 pause/output 消息负责）
    // 整机监听（systemCapture）时豁免「播放暂停」：监听的是系统扬声器，本软件是否在播歌不影响输出
    if ((engineState.paused && !state.settings.systemCapture) || !engineState.outputOn) return
    const now = Date.now()
    if (now - state.engine.lastSendAt < 1000 / 30) return
    state.engine.lastSendAt = now

    // 节拍脉冲：上升沿立即触发 + 节拍锁定（持续鼓点时按节拍间隔连续敲击），
    // 且与上次间隔 ≥ max(120ms, 节拍×0.85)
    const prevBeat = engineState.prevBeat
    engineState.prevBeat = audio.beat ?? 0

    const out = mapAudio(audio)
    const beatPeriodMs = Math.max(0.12, (engineState.pulsePeriod || 0.5) * 0.85) * 1000
    const risingEdge = prevBeat <= 0.22 && out.beat > 0.35
    const tempoLocked = out.beat > 0.35 && (now - engineState.lastPulseAt) >= beatPeriodMs
    const pulseNow = state.settings.pulseEnabled && (risingEdge || tempoLocked) && out.beat > 0.3
    if (pulseNow) {
      engineState.lastPulseAt = now
      // 脉冲频率即时调制：风格 carrier 为基底，随高频能量与乐速上升（频率维度也 1:1 跟歌）
      const carrier = clamp((STYLE_CARRIER[state.settings.feelStyle] ?? 35) + (audio.high ?? 0) * 60 + engineState.speed * 8, 20, 150)
      // 「原厂」风格：节拍触发段用官方 M2 扫掠模板（1:1 复刻官方实时打击段）
      const pulseId = state.settings.feelStyle === 'stock' ? 'dglab-sweep' : null
      const frames = resolvePulseFrames(out.beat, carrier, pulseId)
      if (frames.length) {
        // A 通道：主脉冲；B 通道：同拍回声（0.55 强度，让 B 也有波形与体感，不再只有强度）
        const framesB = frames.map(f => ({ ...f, strength: Math.round(f.strength * 0.55) })).filter(f => f.strength > 1)
        if (state.settings.version === 'v3') {
          sendV3Pulse('A', frames)
          if (framesB.length) sendV3Pulse('B', framesB)
        } else {
          sendV4Pulse(V4_CHANNEL.A, frames)
          if (framesB.length) sendV4Pulse(V4_CHANNEL.B, framesB)
        }
      }
    }
    if (state.settings.version === 'v3') {
      sendV3Strength('A', out.A)
      sendV3Strength('B', out.B)
    } else {
      sendV4Strength(V4_CHANNEL.A, out.A)
      sendV4Strength(V4_CHANNEL.B, out.B)
    }

    // LiveWave 实时波形流：每 100ms 追加一帧「实时 freq+强度」波形帧（A/B 交替），
    // 让 App 端实时波形像官方实时音频模式一样**连续绘制、频率随音乐变化**（队列 500 帧≈50s，10帧/s 不掉队）。
    if (now - engineState.liveWaveAt >= 100) {
      engineState.liveWaveAt = now
      const side = engineState.liveWaveSide
      engineState.liveWaveSide = side === 'A' ? 'B' : 'A'
      const freq = clamp((STYLE_CARRIER[state.settings.feelStyle] ?? 35) + (audio.high ?? 0) * 70 + (audio.bass ?? 0) * 40 + engineState.speed * 10, 20, 160)
      // 官方实时频率映射：能量在观察窗口的位置 → 实时波形频率（线性/对数/深沉/明亮）
      // 「原厂」风格用官方量程 10~30Hz（对齐官方 assets/M2_simple.csv 的 freq 阶梯 10→30）；
      // 其余风格保留更宽的 25~150Hz（频率更丰富、有层次）
      const rtFreq = (() => {
        const x = clamp01Local(engineState.energyEnv)
        const stock = state.settings.feelStyle === 'stock'
        const lo = stock ? 10 : 25
        const hi = stock ? 30 : 150
        const map = state.settings.rtFreqMap || 'linear'
        if (map === 'log') return lo * Math.pow(hi / lo, x)
        if (map === 'deep') return lo + x * x * (hi - lo)
        if (map === 'bright') return lo + (1 - Math.pow(1 - x, 2)) * (hi - lo)
        return lo + x * (hi - lo)
      })()
      const useFreq = clamp(Math.round(state.settings.rtMode === 'auto' || state.settings.rtMode === 'manual' ? rtFreq : freq), 20, 160)
      const strengthNow = side === 'A' ? out.A : out.B
      const frame = { freq: useFreq, strength: Math.max(1, strengthNow) }
      if (state.settings.version === 'v3') sendV3Pulse(side, [frame])
      else sendV4Pulse(side === 'A' ? V4_CHANNEL.A : V4_CHANNEL.B, [frame])
    }

    broadcastCtrl({ t: 'output', out })
  }

  /** 暂停归零：立即清零并停止映射下发。 */
  const pauseOutput = () => {
    engineState.paused = true
    engineState.A = { target: 0, current: 0 }
    engineState.B = { target: 0, current: 0 }
    try { sendClear() } catch { /* ignore */ }
    broadcastCtrl({ t: 'output', out: { A: 0, B: 0, beat: 0 } })
    log('播放暂停：波形输出已归零')
  }

  /** 续播恢复：按「恢复档」从 0 缓慢升到目标（给身体适应）。 */
  const resumeOutput = () => {
    engineState.paused = false
    engineState.A = { target: 0, current: 0 }
    engineState.B = { target: 0, current: 0 }
    startRamp()
    log(`续播：按恢复档(${state.settings.rampPreset ?? DEFAULT_RAMP_PRESET})从 0 缓慢恢复`)
  }

  /** 解析节拍脉冲帧：统一短促衰减包络（≤6 帧），强度按 beat 缩放并钳到通道上限。 */
  const resolvePulseFrames = (beat, carrierFreq = 20, overrideId = null) => {
    const s = state.settings
    let frames = s.waveFrames
    if (!frames || !frames.length) {
      const id = overrideId || (s.waveId === 'continuous' ? 'beat' : s.waveId) || 'beat'
      frames = generateBuiltinWave(id, { freq: s.waveFreq ?? carrierFreq, strength: s.waveStrength })
    }
    const env = [1, 0.6, 0.38, 0.24, 0.15, 0.09]
    const cap = Math.min(s.caps.A ?? 60, state.softLimit?.A ?? 200)
    const scale = 0.5 + Math.min(1, beat) * 0.5
    return frames.slice(0, 6).map((f, i) => ({
      ...f,
      freq: clamp(Number(f.freq) || carrierFreq, 0, 255),
      strength: clamp(Math.round((Number(f.strength) || 0) * scale * (env[i] ?? 0.25)), 0, Math.min(cap, 200)),
    })).filter(f => f.strength > 1)
  }

  /* ------------------------------ WS 处理 ------------------------------ */

  const handleCtrlConnection = (ws, req) => {
    const remote = req?.socket?.remoteAddress || '?'
    const normalizedRemote = String(remote).replace(/^::ffff:/, '')
    if (normalizedRemote !== '127.0.0.1' && normalizedRemote !== '::1') {
      try { ws.close(4003, 'control channel is local only') } catch { /* ignore */ }
      log(`拒绝非本机控制连接：${remote}`)
      return
    }
    state.ctrlClients.add(ws)
    pushLogsTo(ws)
    broadcastStatus()
    log(`渲染端已连接（控制通道 ${remote}，当前 ${state.ctrlClients.size} 个）`)
    ws.on('message', (raw) => {
      let msg
      try {
        msg = JSON.parse(raw.toString())
      } catch {
        return
      }
      if (msg.t === 'settings') {
        const prevPort = Number(state.settings.port)
        const prevDevMode = Boolean(state.settings.devMode)
        state.settings = { ...state.settings, ...msg.settings }
        state.settings.lanEnabled = undefined // 局域网恒开，不再作为开关字段使用
        const portChanged = Number(state.settings.port) !== prevPort
        if (state.running && portChanged) restartListener()
        if (!prevDevMode && state.settings.devMode) log('开发者模式已开启 → 详细调试日志已生效')
        if (prevDevMode && !state.settings.devMode) log('开发者模式已关闭')
        log(`设置已更新：${JSON.stringify(state.settings)}`)
        broadcastStatus()
      } else if (msg.t === 'audio') {
        if (state.engine.running) {
          if (!state.engine.seenAudio) {
            state.engine.seenAudio = true
            log('音频流已接入（首帧到达，映射引擎开始输出）')
          }
          runEngine(msg.data)
        } else if (!state.engine.warnedEngineIdle) {
          state.engine.warnedEngineIdle = true
          log('收到音频帧但引擎未启动（未发 start/已停止），仅提示一次；设备连接后将按「恢复档」自动续跑')
        }
      } else if (msg.t === 'start') {
        state.engine.requested = true
        state.engine.warnedEngineIdle = false
        state.engine.running = true
        engineState.A = { target: 0, current: 0 }
        engineState.B = { target: 0, current: 0 }
        engineState.agc = 0.25
        engineState.energyEnv = 0.2
        engineState.rtHeld = 0
        engineState.paused = false
        engineState.outputOn = true
        state.engine.lastAudioAt = Date.now()
        state.engine.seenAudio = false
        startRamp() // 启动淡入（按恢复档）
        startSilenceGuard()
        log('映射引擎已启动（启动淡入：按恢复档）')
        broadcastStatus()
      } else if (msg.t === 'stop') {
        state.engine.requested = false
        safetyStop('映射引擎已停止')
      } else if (msg.t === 'pause') {
        if (state.engine.running) pauseOutput()
      } else if (msg.t === 'resume') {
        if (state.engine.running) resumeOutput()
      } else if (msg.t === 'output') {
        // 播放页「波形输出启禁」：仅暂停波形输出，不断开、不关插件
        const wantOn = Boolean(msg.on)
        if (wantOn === engineState.outputOn) return
        engineState.outputOn = wantOn
        if (wantOn) {
          resumeOutput()
          log('波形输出已重新启用（按恢复档缓慢恢复）')
        } else {
          engineState.A = { target: 0, current: 0 }
          engineState.B = { target: 0, current: 0 }
          try { sendClear() } catch { /* ignore */ }
          broadcastCtrl({ t: 'output', out: { A: 0, B: 0, beat: 0 } })
          log('波形输出已暂停（连接保持）')
        }
      } else if (msg.t === 'ping') {
        ws.send(JSON.stringify({ t: 'pong' }))
      } else {
        verboseLog(`未知控制指令: ${summarizeFrame(raw)}`)
      }
    })
    ws.on('close', (code, reason) => {
      state.ctrlClients.delete(ws)
      verboseLog(`渲染端断开 code=${code} reason=${reason.toString().slice(0, 80)}`)
      if (state.ctrlClients.size === 0) safetyStop('渲染端已断开，安全归零')
    })
    ws.on('error', (error) => verboseLog(`控制通道错误: ${error?.message || error}`))
  }

  const handleV3App = (ws, req) => {
    const remote = req?.socket?.remoteAddress || '?'
    const url = req?.url || '/'
    // 解析 targetId：query(targetId|tid) || 路径首段。官方 V3 二维码 = ws://host:port/<targetId>（路径）；
    // 旧版二维码用 /dglab/v3 路径（首段 dglab 不是 targetId，按裸连处理）
    let targetId = ''
    try {
      const u = new URL(url, 'http://x')
      targetId = u.searchParams.get('targetId') || u.searchParams.get('tid') || u.pathname.slice(1).split('/')[0].trim() || ''
    } catch {
      targetId = url.split('?')[0].slice(1).split('/')[0] || ''
    }
    const legacyDglabPath = targetId === 'dglab' // 旧版 /dglab/v3 路径的伪 targetId
    const hasTarget = Boolean(targetId) && !legacyDglabPath

    if (hasTarget && targetId !== state.clientId) {
      log(`拒绝 V3 连接：targetId=${targetId.slice(0, 12)}… 与当前控制端不匹配`)
      try { ws.close(4003, 'targetId mismatch') } catch { /* ignore */ }
      return
    }

    if (state.app.v3 && !state.app.v3.isClosed) {
      log(`V3 已有 App 连接，新连接（${remote}）覆盖旧的`)
      try { state.app.v3.close(4000, 'replaced') } catch { /* ignore */ }
    }

    const appId = uuid()
    state.app.v3 = ws
    state.v3AppId = appId
    state.bound = true
    if (hasTarget) {
      log(`V3 App 已配对（${remote}，targetId 快捷接入，appId=${appId}）`)
    } else {
      log(`V3 App 已连接（${remote}，裸连/旧路径${legacyDglabPath ? ' /dglab/v3' : ''}，appId=${appId}）`)
      // 官方流程：先告知 App 自己的 clientId（hello bind），再发绑定 200
      ws.send(JSON.stringify({ type: 'bind', clientId: appId, targetId: '', message: 'targetId' }))
    }
    log(`  urlV3 = ${buildStatus().urlV3}`)
    const bindMsg = JSON.stringify({ type: 'bind', clientId: state.clientId, targetId: appId, message: '200' })
    ws.send(bindMsg)
    log(`V3 已发送 bind 200 → App（controller=${state.clientId} app=${appId}）`)
    broadcastStatus()
    startSilenceGuard()
    maybeAutoRunEngine()

    ws.on('message', (raw) => {
      verboseLog(`V3 收到 App 帧: ${summarizeFrame(raw)}`)
      let msg
      try {
        msg = JSON.parse(raw.toString())
      } catch {
        return
      }
      if (!msg) return
      if (msg.type === 'heartbeat') {
        ws.send(JSON.stringify({ type: 'heartbeat', clientId: state.clientId, targetId: state.v3AppId || '', message: '200' }))
        verboseLog('V3 心跳往返')
      } else if (msg.type === 'bind') {
        log(`V3 收到 bind：clientId=${msg.clientId ?? '-'} targetId=${msg.targetId ?? '-'} message=${msg.message ?? '-'}`)
        // App 可能回 bind 确认（message=200）；保持已配对状态
        if (msg.message === '200') log('V3 App 已确认绑定（bind 200）')
      } else if (msg.type === 'msg' || typeof msg.type === 'number' || msg.type === 'clientMsg') {
        const text = String(msg.message ?? '')
        verboseLog(`V3 消息帧 type=${msg.type} message=${text.slice(0, 120)}`)
        // App 反馈（PyDGLab-WS parse_strength_data 同款格式）：
        //   strength-<当前A>+<当前B>+<上限A>+<上限B> → 更新软上限与设备当前强度
        if (text.startsWith('strength-')) {
          const parts = text.split('-')[1]?.split('+').map(Number)
          if (parts && parts.length >= 4 && parts.every(Number.isFinite)) {
            const [a, b, aLimit, bLimit] = parts
            state.softLimit = { A: aLimit, B: bLimit }
            state.deviceStrength = { A: a, B: b }
            log(`V3 App 反馈：设备强度 A=${a} B=${b}，软上限 A=${aLimit} B=${bLimit}（已作为钳位依据）`)
            broadcastStatus()
          }
        } else if (text.startsWith('feedback-')) {
          verboseLog(`V3 App 按钮反馈：${text}`)
        }
        // 兼容带 props.softLimit 的扩展反馈
        if (msg.props?.softLimit && typeof msg.props.softLimit === 'object') {
          state.softLimit = msg.props.softLimit
          log(`V3 收到设备软上限 softLimit.A=${state.softLimit.A} softLimit.B=${state.softLimit.B}`)
          broadcastStatus()
        }
      } else {
        verboseLog(`V3 未识别帧: ${summarizeFrame(raw)}`)
      }
    })
    ws.on('close', (code, reason) => {
      if (state.app.v3 === ws) {
        state.app.v3 = null
        state.bound = false
        state.v3AppId = null
        state.softLimit = null
        state.deviceStrength = null
        log(`V3 App 已断开（code=${code} reason=${reason.toString().slice(0, 100) || '无'}）`)
        safetyStop('V3 App 断开，安全归零')
        broadcastStatus()
      }
    })
    ws.on('error', (error) => verboseLog(`V3 连接错误: ${error?.message || error}`))
  }

  const handleV4App = (ws, req) => {
    const remote = req?.socket?.remoteAddress || '?'
    const url = req?.url || ''
    const tid = new URL(url, 'http://x').searchParams.get('tid')
    if (!tid || tid !== state.clientId) {
      log(`V4 连接被拒（${remote}）：tid 不匹配（url=${url}）`)
      ws.close(4000, 'tid mismatch')
      return
    }
    state.app.v4.set(tid, ws)
    state.bound = true
    log(`V4 App 已连接（${remote}，tid=${tid}）`)
    // 官方 v4-server 时序：先 hello（告知 App 自身 clientId）→ controller_attached（告知控制端 ID）→ 再设备列表
    const appClientId = uuid()
    ws.send(JSON.stringify({ type: 'hello', clientId: appClientId }))
    ws.send(JSON.stringify({ type: 'controller_attached', clientId: state.clientId }))
    log(`V4 已发送 hello + controller_attached（app=${appClientId} controller=${state.clientId}）`)
    // 设备列表
    sendDevicesGet(ws)
    maybeAutoRunEngine()
    ws.on('message', (raw) => {
      verboseLog(`V4 收到 App 帧: ${summarizeFrame(raw)}`)
      let msg
      try {
        msg = JSON.parse(raw.toString())
      } catch {
        return
      }
      if (!msg) return
      if (msg.t === 'ev' && msg.ev === 'devices.snapshot') {
        state.devices = Array.isArray(msg.devices) ? msg.devices : []
        log(`V4 设备列表：${JSON.stringify(state.devices.map(d => d.name || d.slotId))}`)
        broadcastStatus()
      } else if (msg.t === 'ev' && msg.ev === 'devices.patch') {
        const added = Array.isArray(msg.added) ? msg.added : []
        const removed = Array.isArray(msg.removed) ? msg.removed : []
        if (added.length) state.devices = [...state.devices, ...added]
        if (removed.length) state.devices = state.devices.filter(d => !removed.includes(d.slotId))
        verboseLog(`V4 设备增量：+${added.length} -${removed.length}`)
        broadcastStatus()
      } else if (msg.t === 'ev' && msg.ev === 'slots.patch') {
        const slots = Array.isArray(msg.slots) ? msg.slots : []
        state.softLimit = extractSoftLimit(slots)
        if (state.softLimit) log(`V4 收到设备软上限 softLimit.A=${state.softLimit.A} softLimit.B=${state.softLimit.B}`)
        broadcastStatus()
      } else if (msg.t === 'resp') {
        // 命令响应（调试用）
        verboseLog(`V4 RPC 响应: ${summarizeFrame(raw)}`)
      } else if (msg.type === 'heartbeat') {
        ws.send(JSON.stringify({ type: 'heartbeat' }))
        verboseLog('V4 心跳往返')
      } else {
        verboseLog(`V4 未识别帧: ${summarizeFrame(raw)}`)
      }
    })
    ws.on('close', (code, reason) => {
      state.app.v4.delete(tid)
      if (state.app.v4.size === 0) {
        state.bound = false
        state.devices = []
        log(`V4 App 已断开（code=${code} reason=${reason.toString().slice(0, 100) || '无'}）`)
        safetyStop('V4 App 断开，安全归零')
        broadcastStatus()
      }
    })
    ws.on('error', (error) => verboseLog(`V4 连接错误: ${error?.message || error}`))
  }

  const sendDevicesGet = (ws) => {
    ws.send(JSON.stringify({ t: 'req', reqId: uuid(), m: 'devices.get', data: {} }))
  }

  const extractSoftLimit = (slots) => {
    for (const slot of slots) {
      if (typeof slot.props?.softLimit === 'object') return slot.props.softLimit
    }
    return state.softLimit
  }

  const startSilenceGuard = () => {
    if (state.timers.silence) clearInterval(state.timers.silence)
    let lastActive = Date.now()
    state.timers.silence = setInterval(() => {
      if (!state.engine.running) return
      const now = Date.now()
      if (now - state.engine.lastAudioAt > 800) {
        // 音频流静默：只清零设备输出，引擎保持运行（音乐恢复后自动继续映射）
        if (now - lastActive > 1500) {
          lastActive = now
          engineState.A = { target: 0, current: 0 }
          engineState.B = { target: 0, current: 0 }
          try { sendClear() } catch { /* ignore */ }
          broadcastCtrl({ t: 'output', out: { A: 0, B: 0, beat: 0 } })
        }
      } else {
        lastActive = now
      }
    }, 500)
  }

  const startHeartbeat = () => {
    if (state.timers.heartbeat) clearInterval(state.timers.heartbeat)
    state.timers.heartbeat = setInterval(() => {
      if (state.settings.version === 'v3' && state.app.v3 && !state.app.v3.isClosed && state.v3AppId) {
        state.app.v3.send(JSON.stringify({ type: 'heartbeat', clientId: state.clientId, targetId: state.v3AppId, message: '200' }))
      }
      for (const app of state.app.v4.values()) {
        if (!app.isClosed) app.send(JSON.stringify({ type: 'heartbeat' }))
      }
    }, 15000)
  }

  /* ------------------------------ 监听器管理 ------------------------------ */

  const startListener = () => {
    if (state.server) return
    const bind = '0.0.0.0' // 手机局域网扫码需要：恒监听所有网卡
    const port = state.settings.port || DEFAULT_PORT
    const server = http.createServer((req, res) => {
      // 与官方 v3-server 一致：非 WebSocket 请求仅返回升级提示（App 会先探测）
      res.setHeader('Content-Type', 'application/json; charset=utf-8')
      res.setHeader('Access-Control-Allow-Origin', '*')
      res.statusCode = 426
      res.end(JSON.stringify({ ok: false, error: 'websocket_required', protocol: 'DG-LAB WebSocket V3' }))
    })
    server.on('error', (error) => {
      log(`监听失败：${error?.code || error?.message || error}`)
      state.server = null
      state.running = false
      state.wss = null
      broadcastStatus()
      // 端口占用自愈：指数退避重试（最多 5 次），避免残留进程占端口导致永久不可用
      if (error?.code === 'EADDRINUSE' && state.listenRetries < 5) {
        state.listenRetries += 1
        const delay = 1500 * state.listenRetries
        log(`端口 ${port} 被占用，${delay / 1000}s 后自动重试（${state.listenRetries}/5）…`)
        setTimeout(startListener, delay)
      }
    })
    const wss = new WebSocketServer({ noServer: true })
    server.on('upgrade', (req, socket, head) => {
      const url = req.url || '/'
      const path = url.split('?')[0]
      const remote = req.socket?.remoteAddress || '?'
      // 容忍任意路径：只有明确是 ctrl / v4（带 tid）时走对应处理器，
      // 其余（含根路径 / 未知路径）一律按 V3 App 处理——App 可能连接根地址或自定义路径
      const target = path === '/dglab/ctrl' ? 'ctrl' : path === '/dglab/v4' ? 'v4' : 'v3'
      log(`WS upgrade 收到（${remote}）→ ${path}（target=${target}）`)
      socket.on('error', () => undefined)
      wss.handleUpgrade(req, socket, head, (client) => {
        wss.emit('connection', client, req, target)
      })
      wss.on('error', () => undefined)
    })
    wss.on('connection', (ws, req, target) => {
      if (target === 'ctrl') handleCtrlConnection(ws, req)
      else if (target === 'v3') handleV3App(ws, req)
      else if (target === 'v4') handleV4App(ws, req)
    })
    server.listen(port, bind, () => {
      state.server = server
      state.wss = wss
      state.running = true
      state.listenRetries = 0
      log(`DG_LAB 中继已启动：0.0.0.0:${port}（${state.settings.version}，局域网 IP 列表：${lanAddresses().join(', ') || '未检测到'}）`)
      const st = buildStatus()
      log(`  V3 扫码地址 = ${st.urlV3}`)
      log(`  V4 扫码地址 = ${st.urlV4}`)
      if (state.settings.devMode) console.log('[DG_LAB-调试] 开发者模式已开启（启动阶段）')
      startHeartbeat()
      broadcastStatus()
    })
  }

  const stopListener = () => {
    safetyStop('中继停止，安全归零')
    if (state.timers.heartbeat) {
      clearInterval(state.timers.heartbeat)
      state.timers.heartbeat = null
    }
    if (state.timers.silence) {
      clearInterval(state.timers.silence)
      state.timers.silence = null
    }
    if (state.server) {
      try { state.server.close() } catch { /* ignore */ }
      state.server = null
    }
    if (state.wss) {
      try {
        for (const app of state.app.v4.values()) app.close()
        state.app.v4.clear()
        if (state.app.v3) { try { state.app.v3.close() } catch { /* ignore */ } }
        state.app.v3 = null
      } catch { /* ignore */ }
      state.wss = null
    }
    state.running = false
    state.bound = false
    state.devices = []
    broadcastStatus()
  }

  const restartListener = () => {
    const wasRunning = state.running
    if (wasRunning) stopListener()
    startListener()
  }

  /* ------------------------------ HTTP 状态接口 ------------------------------ */

  const registerHttp = (app) => {
    app.get('/api/dglab/status', (req, res) => {
      const status = buildStatus()
      res.json({ ok: true, ...status })
    })
    app.post('/api/dglab/control', (req, res) => {
      const { action, settings } = req.body || {}
      if (action === 'start') {
        if (settings) state.settings = { ...state.settings, ...settings }
        startListener()
      } else if (action === 'stop') {
        stopListener()
      } else if (action === 'restart') {
        if (settings) state.settings = { ...state.settings, ...settings }
        restartListener()
      }
      res.json(buildStatus())
    })
    // 二维码 dataURL（Node 侧用 qrcode 生成，渲染端直接 <img>）
    app.post('/api/dglab/qr', async (req, res) => {
      try {
        const { content } = req.body || {}
        if (!content) return res.status(400).json({ error: 'missing content' })
        const dataUrl = await QRCode.toDataURL(content, { width: 260, margin: 1, color: { dark: '#0b0b0e', light: '#f5c84c' } })
        res.json({ ok: true, dataUrl })
      } catch (error) {
        res.status(500).json({ error: String(error?.message || error) })
      }
    })
  }

  return {
    registerHttp,
    start: () => startListener(),
    stop: stopListener,
    getStatus: buildStatus,
    _internal: state, // 调试用
    _engine: engineState, // 调试用（冒烟测试读取引擎内部状态）
  }
}

/* ---------------------------------- 映射预设 ---------------------------------- */

module.exports = { createDGLabRelay, DEFAULT_PORT, generateBuiltinWave, frameToHex }
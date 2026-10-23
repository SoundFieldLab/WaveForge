/**
 * In Party 郊狼设备设置（对照 DG-LAB App 逆向的 channelData 字段，1:1 语义）。
 *
 * 来源：MuMu 模拟器 com.bjsm.dungeonlabs 数据库 dglab-database → channelData 表：
 *  - remoteStrengthUL   「远程控制强度上限」(20,40,39) —— App 对 Socket 控制端的独立上限
 *  - countdownstopSwitch/countdownstopData 「倒计时停止」(29 分) —— 到点自动归零
 *  - workRestSwich/workIntervalRange/restIntervalRange 「工作休息循环」(9,29 分工作 / 9,29 分休息)
 *  - strengthJumpSwitch/strengthJumpMax 「强度跳变保护」(一次最多 ±10)
 *  - strengthAddAutoSwitch/strengthAddAutoMax 「自动增强限制」
 *  - freqPara 「波形频率」(160Hz) / strengthPara
 *  - playMode / delayStartSwitch 「延迟启动」(4s)
 *
 * 本模块 = 这些设置的「房间侧执行器」：每个 peerId 一份设置，session 在放行远端
 * 指令前先过这一层（远端指令受 remoteStrengthUL 独立钳位；跳变保护限制单次 ±n）。
 * 设置只存本机（控制的是「我的设备接受什么样的远端输入」），不随房间传输。
 */
import { INPARTY_SETTINGS_EVENT } from './settings'

const DEVICE_SETTINGS_KEY = 'waveforge:inparty-device-settings'

/** 单台设备的房间侧设置（全部对照 App 同名字段） */
export interface CoyoteDeviceSettings {
  /** 远程控制强度上限（App「远程控制」模式的上限；0-200，独立于互控授权） */
  remoteStrengthUL: { A: number; B: number }
  /** 倒计时停止：连接后 N 分钟自动归零（0=关） */
  countdownstop: { enabled: boolean; minutes: number }
  /** 工作休息循环：工作 N 分钟 → 休息 M 分钟（enabled=false 不循环） */
  workRest: { enabled: boolean; workMinutes: number; restMinutes: number }
  /** 强度跳变保护：单次远端调整最大 ±n（0=不限制） */
  strengthJump: { enabled: boolean; max: number }
  /** 自动增强限制：远端连续增强时每秒最多 +n（0=不限制） */
  autoAddLimit: { enabled: boolean; perSecond: number }
  /** 延迟启动：远端首次输出前等 N 秒（给贴片/准备时间） */
  delayStart: { enabled: boolean; seconds: number }
  /** 波形基础频率（Hz，1-240；App 默认 160） */
  freqPara: number
}

export const DEFAULT_DEVICE_SETTINGS: CoyoteDeviceSettings = {
  remoteStrengthUL: { A: 60, B: 60 },
  countdownstop: { enabled: false, minutes: 29 },
  workRest: { enabled: false, workMinutes: 9, restMinutes: 9 },
  strengthJump: { enabled: true, max: 10 },
  autoAddLimit: { enabled: false, perSecond: 10 },
  delayStart: { enabled: false, seconds: 4 },
  freqPara: 160,
}

type DeviceSettingsMap = Record<string, CoyoteDeviceSettings>

function readAll(): DeviceSettingsMap {
  try {
    const raw = localStorage.getItem(DEVICE_SETTINGS_KEY)
    if (!raw) return {}
    return JSON.parse(raw) as DeviceSettingsMap
  } catch {
    return {}
  }
}

function writeAll(map: DeviceSettingsMap): void {
  try { localStorage.setItem(DEVICE_SETTINGS_KEY, JSON.stringify(map)) } catch { /* ignore */ }
}

/** 读某台设备（peerId = 设备主人的成员 id）的设置；没有则给默认 */
export function readDeviceSettings(peerId: string): CoyoteDeviceSettings {
  const map = readAll()
  const saved = map[peerId]
  if (!saved) return structuredClone(DEFAULT_DEVICE_SETTINGS)
  return {
    ...structuredClone(DEFAULT_DEVICE_SETTINGS),
    ...saved,
    remoteStrengthUL: { ...DEFAULT_DEVICE_SETTINGS.remoteStrengthUL, ...(saved.remoteStrengthUL ?? {}) },
    countdownstop: { ...DEFAULT_DEVICE_SETTINGS.countdownstop, ...(saved.countdownstop ?? {}) },
    workRest: { ...DEFAULT_DEVICE_SETTINGS.workRest, ...(saved.workRest ?? {}) },
    strengthJump: { ...DEFAULT_DEVICE_SETTINGS.strengthJump, ...(saved.strengthJump ?? {}) },
    autoAddLimit: { ...DEFAULT_DEVICE_SETTINGS.autoAddLimit, ...(saved.autoAddLimit ?? {}) },
    delayStart: { ...DEFAULT_DEVICE_SETTINGS.delayStart, ...(saved.delayStart ?? {}) },
  }
}

export function saveDeviceSettings(peerId: string, patch: Partial<CoyoteDeviceSettings>): CoyoteDeviceSettings {
  const map = readAll()
  const current = readDeviceSettings(peerId)
  const next: CoyoteDeviceSettings = {
    ...current,
    ...patch,
    remoteStrengthUL: { ...current.remoteStrengthUL, ...(patch.remoteStrengthUL ?? {}) },
    countdownstop: { ...current.countdownstop, ...(patch.countdownstop ?? {}) },
    workRest: { ...current.workRest, ...(patch.workRest ?? {}) },
    strengthJump: { ...current.strengthJump, ...(patch.strengthJump ?? {}) },
    autoAddLimit: { ...current.autoAddLimit, ...(patch.autoAddLimit ?? {}) },
    delayStart: { ...current.delayStart, ...(patch.delayStart ?? {}) },
  }
  map[peerId] = next
  writeAll(map)
  window.dispatchEvent(new CustomEvent(INPARTY_SETTINGS_EVENT))
  return next
}

/* ───────────────────────── 执行器：远端指令过这一层 ───────────────────────── */

/** 每台设备的运行时状态（内存态；重进房间重置） */
export interface DeviceGuardState {
  /** 当前放行强度（跳变保护以它为基准） */
  current: { A: number; B: number }
  /** 最近 1s 的自动增强累计（autoAddLimit 用） */
  addWindow: { at: number; added: number }
  /** 连接/首次输出的时间（countdownstop / delayStart 用） */
  firstOutputAt: number | null
  /** 工作休息循环相位 */
  cycle: { phase: 'work' | 'rest'; phaseStartAt: number } | null
  /** 倒计时停止已触发（触发后必须手动复位才继续） */
  countdownTriggered: boolean
  /** 休息相位中（所有远端强度指令归零） */
  resting: boolean
}

const guardStates = new Map<string, DeviceGuardState>()

function stateOf(peerId: string): DeviceGuardState {
  let state = guardStates.get(peerId)
  if (!state) {
    state = {
      current: { A: 0, B: 0 },
      addWindow: { at: 0, added: 0 },
      firstOutputAt: null,
      cycle: null,
      countdownTriggered: false,
      resting: false,
    }
    guardStates.set(peerId, state)
  }
  return state
}

/** 重置某设备的运行时状态（重新启用/手动复位用） */
export function resetDeviceGuard(peerId: string): void {
  guardStates.delete(peerId)
}

/** 清空全部守卫运行时状态（离房时调——倒计时锁定/休息相位不跨房间残留） */
export function clearAllGuards(): void {
  guardStates.clear()
}

export interface GuardedOutput {
  /** 放行后的强度 */
  A: number
  B: number
  /** 拦截原因（日志/提示用；null = 放行） */
  blockedReason: string | null
  /** 休息中（所有通道归零） */
  resting: boolean
}

/**
 * 远端强度指令过安全层（在发给中继 injectRemoteOp 之前调用）：
 *  1. 倒计时停止：到点 → 强制归零 + 锁定（手动 resetDeviceGuard 解锁）
 *  2. 工作休息循环：休息相位 → 归零；相位自动切换
 *  3. 延迟启动：首次输出前 N 秒内强度=0
 *  4. 远程强度上限 remoteStrengthUL：独立硬顶（比中继的 caps 钳更早）
 *  5. 强度跳变保护：单次变化 ≤ max
 *  6. 自动增强限制：1s 窗口内累计增强 ≤ perSecond
 */
export function applyRemoteStrengthGuard(peerId: string, channel: 'A' | 'B', wantValue: number, now = Date.now()): GuardedOutput {
  const settings = readDeviceSettings(peerId)
  const state = stateOf(peerId)
  const want = Math.max(0, Math.min(200, Math.round(wantValue)))

  // 首次输出标记
  if (state.firstOutputAt === null && want > 0) state.firstOutputAt = now

  // 1. 倒计时停止
  if (settings.countdownstop.enabled && settings.countdownstop.minutes > 0 && state.firstOutputAt !== null) {
    if (!state.countdownTriggered && now - state.firstOutputAt >= settings.countdownstop.minutes * 60_000) {
      state.countdownTriggered = true
    }
    if (state.countdownTriggered) {
      state.current = { A: 0, B: 0 }
      return { A: 0, B: 0, blockedReason: `倒计时停止已触发（${settings.countdownstop.minutes} 分钟），已归零并锁定`, resting: false }
    }
  }

  // 2. 工作休息循环
  if (settings.workRest.enabled && settings.workRest.workMinutes > 0) {
    if (!state.cycle) state.cycle = { phase: 'work', phaseStartAt: now }
    const elapsed = now - state.cycle.phaseStartAt
    if (state.cycle.phase === 'work' && elapsed >= settings.workRest.workMinutes * 60_000) {
      state.cycle = { phase: 'rest', phaseStartAt: now }
      state.resting = true
    } else if (state.cycle.phase === 'rest' && elapsed >= settings.workRest.restMinutes * 60_000) {
      state.cycle = { phase: 'work', phaseStartAt: now }
      state.resting = false
    }
    if (state.resting) {
      state.current = { A: 0, B: 0 }
      return { A: 0, B: 0, blockedReason: '工作休息循环：休息中', resting: true }
    }
  }

  // 3. 延迟启动
  if (settings.delayStart.enabled && state.firstOutputAt !== null && now - state.firstOutputAt < settings.delayStart.seconds * 1000) {
    return { A: 0, B: 0, blockedReason: `延迟启动中（${settings.delayStart.seconds}s）`, resting: false }
  }

  // 4. 远程强度上限（独立于中继 caps 的 App 同名设置）
  const ul = settings.remoteStrengthUL[channel]
  let value = Math.min(want, ul)

  // 5. 强度跳变保护（单次 ±max）
  const prev = state.current[channel]
  if (settings.strengthJump.enabled && settings.strengthJump.max > 0) {
    value = Math.max(prev - settings.strengthJump.max, Math.min(prev + settings.strengthJump.max, value))
    // 归零（安全路径）不受跳变保护限制
    if (want === 0) value = 0
  }

  // 6. 自动增强限制（1s 窗口内累计增强）
  if (settings.autoAddLimit.enabled && settings.autoAddLimit.perSecond > 0 && value > prev) {
    if (now - state.addWindow.at >= 1000) state.addWindow = { at: now, added: 0 }
    const allowed = state.addWindow.added + (value - prev)
    if (allowed > settings.autoAddLimit.perSecond) {
      value = prev + Math.max(0, settings.autoAddLimit.perSecond - state.addWindow.added)
    }
    state.addWindow.added += value - prev
  }

  state.current[channel] = value
  return { A: channel === 'A' ? value : state.current.A, B: channel === 'B' ? value : state.current.B, blockedReason: null, resting: false }
}

/** 波形频率上限（App freqPara 的 2 倍作为远端脉冲频率顶，避免远端发超声帧） */
export function peekDeviceSettingsFreq(peerId: string): number {
  return readDeviceSettings(peerId).freqPara
}

/** 解除倒计时锁定（房间 UI 的「继续」按钮） */
export function unlockCountdown(peerId: string): void {
  const state = stateOf(peerId)
  state.countdownTriggered = false
  state.firstOutputAt = Date.now()
}

/** 当前运行时状态（UI 显示倒计时/循环相位） */
export function peekDeviceGuard(peerId: string): DeviceGuardState {
  return stateOf(peerId)
}

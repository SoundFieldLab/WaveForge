/**
 * TV 调试模式数据层（developerMode 开关控制）。
 *  - 前端日志：override console.* 捕获到环形缓冲；
 *  - 后端日志：轮询 /api/tv/logs（android-server 提供设备 Node 服务日志）；
 *  - 性能：rAF 帧率/帧时/内存/设备信息。
 * 全部为只读展示用途（面板 pointer-events:none + data-tv-skip，遥控器/远程光标不可选中）。
 */
import { useSyncExternalStore } from 'react'
import { isTvModeActive, isAndroid } from '../platform'

// ── 调试模式开关（localStorage developerMode + developerModeChanged 事件） ──
let debugMode = readDebugMode()
const debugListeners = new Set<() => void>()

function readDebugMode(): boolean {
  try {
    const saved = localStorage.getItem('developerMode')
    if (saved !== null) return saved === 'true'
    // 调试阶段：TV 端默认开启（软件进不去时也需要调试台可用）；PC 默认关。
    // 正式发布时把这里改回 false。
    return isTvModeActive()
  } catch {
    return isTvModeActive()
  }
}

export function isDebugMode(): boolean {
  return debugMode
}

function setDebugMode(v: boolean): void {
  if (debugMode === v) return
  debugMode = v
  debugListeners.forEach((fn) => fn())
}

function subscribeDebug(cb: () => void): () => void {
  debugListeners.add(cb)
  return () => debugListeners.delete(cb)
}

export function useDebugMode(): boolean {
  return useSyncExternalStore(subscribeDebug, isDebugMode)
}

export function initDebugMode(): void {
  window.addEventListener('developerModeChanged', (e) => setDebugMode(Boolean((e as CustomEvent<boolean>).detail)))
  setDebugMode(readDebugMode())
}

// ── 调试面板可见性（开发者模式子开关，localStorage 持久化） ──
export const DEBUG_PANEL_KEYS = {
  backend: 'waveforge:debug-show-backend',
  frontend: 'waveforge:debug-show-frontend',
  perf: 'waveforge:debug-show-perf',
}
// 默认：有无线调试台后，前端/后端日志弹窗默认关闭（日志在电脑调试台看），
// FPS 性能面板默认保留。
const DEBUG_PANEL_DEFAULT: Record<string, boolean> = {
  [DEBUG_PANEL_KEYS.backend]: false,
  [DEBUG_PANEL_KEYS.frontend]: false,
  [DEBUG_PANEL_KEYS.perf]: true,
}

export function getDebugPanelVisible(key: string): boolean {
  try {
    const saved = localStorage.getItem(key)
    if (saved !== null) return saved === '1'
    return DEBUG_PANEL_DEFAULT[key] ?? true
  } catch {
    return DEBUG_PANEL_DEFAULT[key] ?? true
  }
}

export function setDebugPanelVisible(key: string, visible: boolean): void {
  try {
    localStorage.setItem(key, visible ? '1' : '0')
  } catch {
    // ignore
  }
  window.dispatchEvent(new CustomEvent('debugPanelsChanged'))
}

// ── 前端日志 ──
export interface LogLine {
  time: string
  level: 'log' | 'info' | 'warn' | 'error' | 'debug'
  text: string
}

let frontendLogs: LogLine[] = []
const logListeners = new Set<() => void>()
const MAX_FRONTEND_LOGS = 200

function stringifyArg(a: unknown): string {
  if (typeof a === 'string') return a
  if (a instanceof Error) return a.stack || a.message
  try {
    const s = JSON.stringify(a)
    return s === undefined ? String(a) : s
  } catch {
    return String(a)
  }
}

let consoleCaptured = false

/** override console.* 捕获前端日志（仍转发原 console）。幂等。 */
export function captureFrontendConsole(): void {
  if (consoleCaptured) return
  consoleCaptured = true
  const orig = {
    log: console.log.bind(console),
    info: console.info.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
    debug: console.debug.bind(console),
  }
  const push = (level: LogLine['level'], args: unknown[]) => {
    frontendLogs.push({
      time: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
      level,
      text: args.map(stringifyArg).join(' '),
    })
    if (frontendLogs.length > MAX_FRONTEND_LOGS) frontendLogs.splice(0, frontendLogs.length - MAX_FRONTEND_LOGS)
    logListeners.forEach((fn) => fn())
  }
  console.log = (...a) => { push('log', a); orig.log(...a) }
  console.info = (...a) => { push('info', a); orig.info(...a) }
  console.warn = (...a) => { push('warn', a); orig.warn(...a) }
  console.error = (...a) => { push('error', a); orig.error(...a) }
  console.debug = (...a) => { push('debug', a); orig.debug(...a) }
}

export function getFrontendLogs(): LogLine[] {
  return frontendLogs
}

function subscribeLogs(cb: () => void): () => void {
  logListeners.add(cb)
  return () => logListeners.delete(cb)
}

export function useFrontendLogs(): LogLine[] {
  return useSyncExternalStore(subscribeLogs, getFrontendLogs)
}

// ── 后端日志（轮询 /api/tv/logs，android-server 提供） ──
let backendLogs: LogLine[] = []
const backendListeners = new Set<() => void>()
let backendPollTimer: number | null = null
let backendPollFailures = 0

async function pollBackendLogs(): Promise<void> {
  try {
    const res = await fetch('http://localhost:3001/api/tv/logs', { cache: 'no-store' })
    if (!res.ok) {
      // 后端无此接口（PC 端 local-server 未挂 tv 扩展）：连续失败后停止轮询，避免 404 刷屏
      backendPollFailures++
      if (backendPollFailures >= 5) stopBackendLogPolling()
      return
    }
    backendPollFailures = 0
    const data = (await res.json()) as { lines?: LogLine[] }
    if (Array.isArray(data.lines)) {
      backendLogs = data.lines
      backendListeners.forEach((fn) => fn())
    }
  } catch {
    backendPollFailures++
    if (backendPollFailures >= 5) stopBackendLogPolling()
  }
}

export function startBackendLogPolling(): void {
  if (backendPollTimer !== null) return
  // 后端日志接口（/api/tv/logs）仅 android-server 提供：PC 端不轮询，避免 404 刷屏
  if (!isAndroid()) return
  void pollBackendLogs()
  backendPollTimer = window.setInterval(pollBackendLogs, 1200)
}

export function stopBackendLogPolling(): void {
  if (backendPollTimer !== null) {
    window.clearInterval(backendPollTimer)
    backendPollTimer = null
  }
}

export function getBackendLogs(): LogLine[] {
  return backendLogs
}

function subscribeBackend(cb: () => void): () => void {
  backendListeners.add(cb)
  return () => backendListeners.delete(cb)
}

export function useBackendLogs(): LogLine[] {
  return useSyncExternalStore(subscribeBackend, getBackendLogs)
}

// ── 性能测量 ──
export interface PerfInfo {
  fps: number
  frameMs: number
  heapUsed: number
  heapTotal: number
  deviceMemory?: number
  cores: number
  domNodes: number
}

let perf: PerfInfo = {
  fps: 0,
  frameMs: 0,
  heapUsed: 0,
  heapTotal: 0,
  deviceMemory: undefined,
  cores: typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 0 : 0,
  domNodes: 0,
}
const perfListeners = new Set<() => void>()
let perfRaf = 0
let perfFrames = 0
let perfLast = 0
let perfRunning = false

function updatePerf(now: number): void {
  perfFrames++
  if (perfLast === 0) perfLast = now
  const dt = now - perfLast
  if (dt >= 1000) {
    const mem = (performance as unknown as { memory?: { usedJSHeapSize?: number; jsHeapSizeLimit?: number } }).memory
    const deviceMemory = (navigator as unknown as { deviceMemory?: number }).deviceMemory
    perf = {
      fps: Math.round((perfFrames * 1000) / dt),
      frameMs: +(dt / perfFrames).toFixed(2),
      heapUsed: mem?.usedJSHeapSize || 0,
      heapTotal: mem?.jsHeapSizeLimit || 0,
      deviceMemory,
      cores: perf.cores,
      domNodes: document.querySelectorAll('*').length,
    }
    perfFrames = 0
    perfLast = now
    perfListeners.forEach((fn) => fn())
  }
  perfRaf = requestAnimationFrame(updatePerf)
}

export function startPerfMeasurement(): void {
  if (perfRunning) return
  perfRunning = true
  perfFrames = 0
  perfLast = 0
  perfRaf = requestAnimationFrame(updatePerf)
}

export function stopPerfMeasurement(): void {
  perfRunning = false
  cancelAnimationFrame(perfRaf)
}

export function getPerf(): PerfInfo {
  return perf
}

function subscribePerf(cb: () => void): () => void {
  perfListeners.add(cb)
  return () => perfListeners.delete(cb)
}

export function usePerf(): PerfInfo {
  return useSyncExternalStore(subscribePerf, getPerf)
}

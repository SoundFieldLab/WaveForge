/**
 * TV 端性能模式（配置检查面板配套）：
 *  - efficiency 效能：停掉最贵的无限动画/背景，隐藏桌面模式，缓存最小档；
 *  - normal 普通（默认）：保留基础过渡，停掉昂贵的无限背景动画，桌面模式显示，缓存中档；
 *  - enhanced 增强：全开（接近 PC），桌面模式显示，缓存高档。
 *
 * 默认按设备内存自动选：navigator.deviceMemory < 3GB → 效能，否则普通；增强需手动开。
 * 生效机制：html 上打 wf-perf-* 类（tv.css 分档控制动画）+ JS 侧（组件读 usePerfMode）。
 */
import { useSyncExternalStore } from 'react'
import { isTvModeActive } from '../platform'

export type PerfMode = 'efficiency' | 'normal' | 'enhanced'

const KEY = 'waveforge:perf-mode'
const listeners = new Set<() => void>()
let mode: PerfMode = readStored()

function autoDefault(): PerfMode {
  if (!isTvModeActive()) return 'normal'
  try {
    const dm = (navigator as unknown as { deviceMemory?: number }).deviceMemory
    if (typeof dm === 'number' && dm > 0 && dm < 3) return 'efficiency'
  } catch {
    // ignore
  }
  return 'normal'
}

function readStored(): PerfMode {
  try {
    const v = localStorage.getItem(KEY)
    if (v === 'efficiency' || v === 'normal' || v === 'enhanced') return v
  } catch {
    // ignore
  }
  return autoDefault()
}

export function getPerfMode(): PerfMode {
  return mode
}

export function isPerfModeEfficiency(): boolean {
  return mode === 'efficiency'
}

export function isPerfModeEnhanced(): boolean {
  return mode === 'enhanced'
}

function emit(): void {
  listeners.forEach((fn) => fn())
}

export function setPerfMode(m: PerfMode): void {
  if (mode === m) return
  mode = m
  try {
    localStorage.setItem(KEY, m)
  } catch {
    // ignore
  }
  applyPerfModeClasses()
  emit()
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

/** React Hook：当前性能模式。 */
export function usePerfMode(): PerfMode {
  return useSyncExternalStore(subscribe, getPerfMode)
}

/** 在 html 上打模式类，供 tv.css 分档控制动画/桌面模式可见性。 */
export function applyPerfModeClasses(): void {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  root.classList.remove('wf-perf-efficiency', 'wf-perf-normal', 'wf-perf-enhanced')
  root.classList.add('wf-perf-' + mode)
}

/** 启动时调用（main.tsx）：应用模式类。 */
export function initPerfMode(): void {
  applyPerfModeClasses()
}

/**
 * 缓存上限按性能模式动态取值（TV 存储小，严格限制；PC 维持现状）。
 *  - coverCount/coverBytes/singleImage：cacheManager（localStorage 封面）
 *  - idbCoverBytes/playlistCount/playlistBytes/lyricCount/lyricBytes：indexedDBCache
 */
export interface CacheLimits {
  coverCount: number
  coverBytes: number
  singleImage: number
  idbCoverBytes: number
  playlistCount: number
  playlistBytes: number
  lyricCount: number
  lyricBytes: number
}

export function getCacheLimits(): CacheLimits {
  const MB = 1024 * 1024
  if (!isTvModeActive()) {
    return {
      coverCount: 500, coverBytes: 2 * 1024 * MB, singleImage: 10 * MB,
      idbCoverBytes: 256 * MB, playlistCount: 100, playlistBytes: 50 * MB,
      lyricCount: 1000, lyricBytes: 128 * MB,
    }
  }
  switch (mode) {
    case 'efficiency':
      return {
        coverCount: 150, coverBytes: 60 * MB, singleImage: 5 * MB,
        idbCoverBytes: 50 * MB, playlistCount: 60, playlistBytes: 30 * MB,
        lyricCount: 400, lyricBytes: 30 * MB,
      }
    case 'enhanced':
      return {
        coverCount: 500, coverBytes: 300 * MB, singleImage: 10 * MB,
        idbCoverBytes: 256 * MB, playlistCount: 100, playlistBytes: 50 * MB,
        lyricCount: 1000, lyricBytes: 128 * MB,
      }
    default:
      return {
        coverCount: 300, coverBytes: 150 * MB, singleImage: 8 * MB,
        idbCoverBytes: 120 * MB, playlistCount: 80, playlistBytes: 40 * MB,
        lyricCount: 700, lyricBytes: 80 * MB,
      }
  }
}

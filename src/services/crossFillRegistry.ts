import { useSyncExternalStore } from 'react'
import type { MusicPlatform } from './platforms'
import { getApiBase } from './apiConfig'

/**
 * 跨平台补源登记表：记录哪些曲目实际是"用别的平台音源播放的"（歌单行尾标「补」）。
 * 目前只有播放链路会写入（App.loadAndPlaySong 里补源成功时），UI 只读。
 */
export interface CrossFillInfo {
  /** 实际提供音源的平台 */
  from: MusicPlatform
  /** 记录时间戳（ms） */
  at: number
  /** 载体歌曲在该平台的 id（QQ 为 mid），供取流/音质按供源平台精确对位 */
  carrierId?: string
}

const STORAGE_KEY = 'wf_cross_filled_tracks'
const MAX_ENTRIES = 300
export const CROSS_FILL_EVENT = 'waveforge-cross-fill-changed'

type SongLike = { platform?: string; mid?: string; id?: number | string }

function keyOf(song: SongLike | null | undefined): string {
  if (!song) return ''
  const id = song.mid || song.id
  if (!id) return ''
  return `${song.platform || ''}:${id}`
}

function loadRegistry(): Map<string, CrossFillInfo> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return new Map()
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return new Map()
    return new Map(Object.entries(parsed as Record<string, CrossFillInfo>))
  } catch {
    return new Map()
  }
}

const registry = loadRegistry()
let version = 0

function persist(): void {
  try {
    // 超量时丢掉最旧的一半，避免无限膨胀（只是角标提示，不是关键数据）
    if (registry.size > MAX_ENTRIES) {
      const sorted = [...registry.entries()].sort((a, b) => (a[1]?.at || 0) - (b[1]?.at || 0))
      for (const [key] of sorted.slice(0, sorted.length - MAX_ENTRIES / 2)) registry.delete(key)
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(registry)))
  } catch { /* 忽略存储失败 */ }
}

/** 补源成功时登记一条（同一曲目重复补源只更新时间与来源；carrierId=载体歌曲在供源平台的 id） */
export function recordCrossFill(song: SongLike | null | undefined, from: MusicPlatform, carrierId?: string): void {
  const key = keyOf(song)
  if (!key || !from) return
  const previous = registry.get(key)
  registry.set(key, { from, at: Date.now(), carrierId: carrierId || previous?.carrierId || '' })
  version += 1
  persist()
  try { window.dispatchEvent(new CustomEvent(CROSS_FILL_EVENT)) } catch { /* 忽略 */ }
}

/** 该曲目是否用过跨平台补源 */
export function isCrossFilled(song: SongLike | null | undefined): CrossFillInfo | null {
  const key = keyOf(song)
  return key ? registry.get(key) || null : null
}

/** 补源音质查询：这首歌当前若由其它平台供源，返回供源平台与载体 id（音质请求要发到供源平台）。
 *  无补源记录返回 null。songId 传原平台歌曲 id。 */
export function getCrossFillSource(song: SongLike | null | undefined): { platform: MusicPlatform; carrierId: string } | null {
  const info = isCrossFilled(song)
  if (!info?.from) return null
  return { platform: info.from, carrierId: info.carrierId || '' }
}

export function clearCrossFills(): void {
  registry.clear()
  version += 1
  persist()
  try { window.dispatchEvent(new CustomEvent(CROSS_FILL_EVENT)) } catch { /* 忽略 */ }
}

/**
 * 把一次「平台可用性增强」补源决策上报后端控制台。
 *
 * 为什么要有这条：补源是渲染层决定的，打包版没有 devtools，用户只看得到一闪而过的 toast，
 * 事后完全不知道这首歌的音源到底来自哪个平台。后端控制台留一行带【平台可用性增强】前缀的记录，
 * 排查「播放异常 / 音源对不上」时可以直接对上。
 *
 * 纯诊断通道：失败静默，绝不影响播放。
 */
export function reportCrossPlatformFill(payload: {
  /** 原曲平台（播不了的那个） */
  from: MusicPlatform
  /** 实际提供音源的平台；补源失败时不传 */
  to?: MusicPlatform
  title?: string
  artist?: string
  /** 原平台不可播的原因（会员档位 / 未登录 / 解析失败等） */
  reason?: string
  success: boolean
}): void {
  try {
    void fetch(`${getApiBase()}/diagnostics/cross-platform-fill`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: payload.from,
        to: payload.to || '',
        title: payload.title || '',
        artist: payload.artist || '',
        reason: payload.reason || '',
        success: payload.success,
      }),
    }).catch(() => undefined)
  } catch { /* 忽略：诊断不影响播放 */ }
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener(CROSS_FILL_EVENT, onChange)
  return () => window.removeEventListener(CROSS_FILL_EVENT, onChange)
}

const getVersion = () => version

/** 订阅补源登记变化（曲目行尾的「补」标实时刷新） */
export function useCrossFillVersion(): number {
  return useSyncExternalStore(subscribe, getVersion, getVersion)
}

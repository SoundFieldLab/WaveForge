/**
 * 「推送至共振」的共用部分。
 *
 * 场景：用户在别的模式里（共振已挂起）右键一首歌 → 菜单多一项「推送至共振（一起听）」。
 * 为了不改动每一个右键菜单宿主，这里提供一个极小的挂起状态订阅 + 一个全局事件约定：
 * 菜单只负责派发 `waveforge:resonance-push`，由 App 转成房间曲目交给会话处理。
 */
import type { Song } from '../../services/musicApi'
import { getSongRequiredTier } from '../../utils/musicEntitlements'
import type { MusicPlatform } from '../../services/platforms'
import type { ResonanceTrack } from './model'

/** 推给房间的曲目载荷（key/seq/requestedBy 由房间自己补） */
export type ResonancePushTrack = Omit<ResonanceTrack, 'key' | 'seq' | 'requestedBy'>

/** 右键菜单里的菜单项文案（挂起时才出现） */
export const RESONANCE_PUSH_LABEL = '推送至共振（一起听）'

/** 菜单 → App 的事件名；detail = Song */
export const RESONANCE_PUSH_EVENT = 'waveforge:resonance-push'

/**
 * 把任意平台的 Song 转成房间曲目。
 * 只带「元数据 + 来源 id」，不带音源地址：别人要用自己的账号去解析。
 */
export function songToResonanceTrack(song: Song): ResonancePushTrack {
  return {
    title: song.name,
    artists: (song.artists || []).map(artist => artist.name),
    album: song.album?.name || '',
    durationMs: song.duration || 0,
    coverUrl: song.album?.picUrl || '',
    sources: [{
      platform: (song.platform || 'netease') as MusicPlatform,
      id: Number(song.id) || 0,
      mid: song.mid,
      appleId: song.appleId,
      vip: getSongRequiredTier(song) !== 'free',
    }],
  }
}

// ── 挂起状态（模块级小 store，供全局右键菜单同步）─────────────────────────────

let suspended = false
const listeners = new Set<() => void>()

export function setResonanceSuspended(next: boolean): void {
  if (suspended === next) return
  suspended = next
  for (const listener of [...listeners]) {
    try { listener() } catch { /* 单个订阅者异常不影响其它 */ }
  }
}

export function isResonanceSuspended(): boolean {
  return suspended
}

export function subscribeResonanceSuspend(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

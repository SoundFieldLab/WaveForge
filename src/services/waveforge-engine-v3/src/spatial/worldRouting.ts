import type { AudioObject } from './types'

export type MusicSourceRoute = 'l' | 'r' | 'both' | 'side'

/** 世界声源绑定的是立体声节目信号，不是分离后的乐器轨。旧默认 id 固定映射以兼容持久化快照。 */
export function resolveMusicSourceRoute(source: AudioObject): MusicSourceRoute {
  if (source.route === 'l' || source.route === 'r' || source.route === 'both' || source.route === 'side') {
    return source.route
  }
  if (source.id === 'vocal' || source.id === 'guitar') return 'l'
  if (source.id === 'drums') return 'r'
  if (source.id === 'ambience') return 'both'
  if (source.position.x < 0) return 'l'
  if (source.position.x > 0) return 'r'
  return 'both'
}

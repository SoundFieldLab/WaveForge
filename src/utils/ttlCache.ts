/**
 * 极简 TTL 缓存：给「详情类」只读请求用。
 *
 * 场景：歌单/榜单/艺人/专辑详情这类面板会被反复开关（返回再进、切页签、从播放页回退），
 * 每次重新打开都重发一遍同样的请求既慢又浪费。这里按 key 存一份短 TTL 的结果，
 * 打开时先命中缓存、过期了再走网络。
 *
 * 只用内存、不落盘：跨启动不保留，避免出现「更新了歌单却一直看到旧数据」的问题。
 * 调用方负责在登录态/账号变化时 clear()。
 */
export interface TtlCache<T> {
  get(key: string): T | undefined
  set(key: string, value: T): void
  clear(): void
  /** 仅测试/诊断用 */
  size(): number
}

export function createTtlCache<T>(options: { ttlMs: number; maxEntries?: number }): TtlCache<T> {
  const { ttlMs, maxEntries = 40 } = options
  const entries = new Map<string, { value: T; at: number }>()
  return {
    get(key) {
      const hit = entries.get(key)
      if (!hit) return undefined
      if (Date.now() - hit.at > ttlMs) {
        entries.delete(key)
        return undefined
      }
      return hit.value
    },
    set(key, value) {
      // 重新插入以维持「最近写入在下」的淘汰顺序（Map 保序即 LRU 近似）
      entries.delete(key)
      entries.set(key, { value, at: Date.now() })
      while (entries.size > maxEntries) {
        const oldest = entries.keys().next().value
        if (oldest === undefined) break
        entries.delete(oldest)
      }
    },
    clear() { entries.clear() },
    size() { return entries.size },
  }
}

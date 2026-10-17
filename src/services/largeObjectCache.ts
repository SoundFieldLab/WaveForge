/**
 * 大对象缓存统一入口（深挖 localStorage 配额问题的产物）：
 * - 存储分层：IndexedDB（首选，配额以百 MB 计）→ localStorage（降级，~5MB，只允许小对象碰运气）→ 内存兜底无
 * - 适用：聚合 payload、封面墙列表等「数百 KB ~ MB 级、丢了只是慢一拍」的缓存
 * - 不适用：小设置项（继续 localStorage 同步读写）、媒体文件（走 userData 磁盘）
 * 任何失败都静默降级：缓存永远不能把「加载成功」变成「报错」。
 */

const DB_NAME = 'WaveForgeLargeCache'
const STORE = 'kv'

let dbPromise: Promise<IDBDatabase | null> | null = null

function openDb(): Promise<IDBDatabase | null> {
  if (!dbPromise) {
    dbPromise = new Promise(resolve => {
      if (typeof indexedDB === 'undefined') {
        resolve(null)
        return
      }
      try {
        const request = indexedDB.open(DB_NAME, 1)
        request.onupgradeneeded = () => {
          if (!request.result.objectStoreNames.contains(STORE)) {
            request.result.createObjectStore(STORE)
          }
        }
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => resolve(null)
        request.onblocked = () => resolve(null)
      } catch {
        resolve(null)
      }
    })
  }
  return dbPromise
}

function safeLocalSet(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify({ v: value, savedAt: Date.now() }))
  } catch {
    // 配额满：放弃落盘（缓存语义，可接受）
  }
}

function safeLocalGet<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    // 兼容本模块包装格式 { v, savedAt } 与调用方历史裸格式
    if (parsed && typeof parsed === 'object' && 'v' in parsed) return parsed.v as T
    return parsed as T
  } catch {
    return null
  }
}

export async function largeCacheGet<T>(key: string): Promise<T | null> {
  const db = await openDb()
  if (!db) return safeLocalGet<T>(key)
  try {
    const item = await new Promise<{ value: T; savedAt: number; expiresAt?: number } | undefined>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly')
      const request = tx.objectStore(STORE).get(key)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    if (!item) {
      // IDB 无此键：补一次 localStorage 兜底。set 在 IDB 写失败（磁盘满/隐私模式）
      // 时降级写 localStorage；不兜底的话那次数据在 IDB 恢复后永远读不到。
      return safeLocalGet<T>(key)
    }
    if (item.expiresAt && Date.now() > item.expiresAt) {
      void largeCacheDelete(key)
      return null
    }
    return (item.value ?? null) as T | null
  } catch {
    return safeLocalGet<T>(key)
  }
}

export async function largeCacheSet(key: string, value: unknown, ttlMs?: number): Promise<void> {
  const db = await openDb()
  const record = { value, savedAt: Date.now(), expiresAt: ttlMs ? Date.now() + ttlMs : undefined }
  if (db) {
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite')
        tx.objectStore(STORE).put(record, key)
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
        tx.onabort = () => reject(tx.error)
      })
      await sweepLargeCache(db).catch(() => undefined)
      return
    } catch {
      // IDB 写失败（隐私模式/磁盘满）→ 降级 localStorage，写不下就算了
    }
  }
  safeLocalSet(key, value)
}

export async function largeCacheDelete(key: string): Promise<void> {
  const db = await openDb()
  try {
    localStorage.removeItem(key)
  } catch {
    // 忽略
  }
  if (!db) return
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).delete(key)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
  } catch {
    // 忽略
  }
}

// 条目上限 + 过期回收。这个缓存此前没有任何淘汰策略，只靠「同键覆盖写」：
// ExploreView 存的是聚合 payload 与封面墙列表（可达 MB 级），键随账号/日期变化，
// 长期使用会无界增长（IDB 配额吃满会波及同源其他写入）。
const MAX_ENTRIES = 40
const SWEEP_INTERVAL_MS = 60_000
let lastSweepAt = 0

/** 回收已过期条目，并在超过条目上限时按 savedAt 删最旧的。尽力而为，绝不抛出。 */
async function sweepLargeCache(db: IDBDatabase): Promise<void> {
  const now = Date.now()
  if (now - lastSweepAt < SWEEP_INTERVAL_MS) return
  lastSweepAt = now
  // 过期条目统一收集后用独立 readwrite 事务删除：此前在 readonly 事务的游标里
  // cursor.delete() 会同步抛 ReadOnlyError（回调内异常逃逸 → Promise 永不落定，
  // 该次 largeCacheSet 永久挂起）。收集/删除分离后单游标只读，写删除原子完成。
  const entries = await new Promise<Array<{ key: IDBValidKey; savedAt: number; expired: boolean }>>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly')
    const request = tx.objectStore(STORE).openCursor()
    const found: Array<{ key: IDBValidKey; savedAt: number; expired: boolean }> = []
    request.onsuccess = () => {
      const cursor = request.result
      if (!cursor) {
        resolve(found)
        return
      }
      const value = cursor.value as { savedAt?: number; expiresAt?: number } | undefined
      const expired = Boolean(value?.expiresAt && now > value.expiresAt)
      // 过期项同样要收集（doomed 候选）：原实现只收活项，entries.filter(expired) 恒空，
      // 过期条目永远删不掉、持续占用 IndexedDB 配额。
      found.push({ key: cursor.primaryKey, savedAt: Number(value?.savedAt) || 0, expired })
      cursor.continue()
    }
    request.onerror = () => reject(request.error)
  }).catch(() => []) // 扫描失败按"无需回收"处理，绝不影响本次写入
  const doomed: Array<{ key: IDBValidKey; savedAt: number }> = entries.filter(entry => entry.expired)
  if (doomed.length > MAX_ENTRIES || entries.length - doomed.length > MAX_ENTRIES) {
    const alive = entries.filter(entry => !entry.expired)
    alive.sort((a, b) => a.savedAt - b.savedAt)
    for (const entry of alive.slice(0, Math.max(0, alive.length - MAX_ENTRIES))) doomed.push(entry)
  }
  if (doomed.length === 0) return
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    for (const entry of doomed) tx.objectStore(STORE).delete(entry.key)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error)
  }).catch(() => undefined) // 删除失败静默：下次 sweep 重试
}

/**
 * 清空整个大对象缓存（设置页「清理全部」调用）。
 * 本库（WaveForgeLargeCache）与 indexedDBCache 的 WaveForgeCache 是两个不同的库，
 * 清另一边不会连带清掉这里——此前「清理全部」完全够不着它。
 */
export async function largeCacheClearAll(): Promise<number> {
  const db = await openDb()
  if (!db) return 0
  try {
    const keys = await new Promise<IDBValidKey[]>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly')
      const request = tx.objectStore(STORE).getAllKeys()
      request.onsuccess = () => resolve(request.result || [])
      request.onerror = () => reject(request.error)
    })
    if (keys.length > 0) {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite')
        for (const key of keys) tx.objectStore(STORE).delete(key)
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
        tx.onabort = () => reject(tx.error)
      })
    }
    lastSweepAt = 0
    return keys.length
  } catch {
    return 0
  }
}

import type { HrtfGrid } from '../src/spatial/types'

async function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('当前环境不支持本地 HRTF 保存')); return }
    const request = indexedDB.open('hse-spatial-hrtf-v1', 1)
    request.onupgradeneeded = () => request.result.createObjectStore('profiles')
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}
export async function readActiveHrtf(): Promise<HrtfGrid | null> {
  if (typeof indexedDB === 'undefined') return null
  const db = await database()
  try { return await new Promise((resolve, reject) => {
    const request = db.transaction('profiles').objectStore('profiles').get('active')
    request.onsuccess = () => resolve(request.result ?? null); request.onerror = () => reject(request.error)
  }) } finally { db.close() }
}
export async function saveActiveHrtf(grid: HrtfGrid | null): Promise<void> {
  const db = await database()
  try { await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction('profiles', 'readwrite'), store = transaction.objectStore('profiles')
    if (grid) store.put(grid, 'active'); else store.delete('active')
    transaction.oncomplete = () => resolve(); transaction.onerror = () => reject(transaction.error)
    transaction.onabort = () => reject(transaction.error)
  }) } finally { db.close() }
}

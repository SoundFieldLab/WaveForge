/** HSE 校正/混响 IR 库：运行时缓存与 IndexedDB 持久化。 */
import { ConvolutionIrLibrary } from '../src/dsp/ConvolutionIrLibrary'
import type { ConvolutionIrMetadata } from '../src/dsp/ConvolutionIrLibrary'
import { Resampler } from '../src/dsp/Resampler'
import type { ConvolutionPurpose } from '../src/types'

interface StoredIr extends ConvolutionIrMetadata { ir: Float32Array }

const DB_NAME = 'waveforge:hse-ir-library'
const STORE_NAME = 'impulses'
const MAX_IR_ENTRIES = 32
const IR_CAPACITY_MESSAGE = 'IR 库已满（最多 32 条），请先删除不再使用的 IR'
const runtime = new ConvolutionIrLibrary(MAX_IR_ENTRIES)

function openDatabase(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null)
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1)
    request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME, { keyPath: 'id' })
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('IR 库无法打开'))
  })
}

function transact<T>(db: IDBDatabase, mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, mode)
    const request = action(tx.objectStore(STORE_NAME))
    let result: T
    request.onsuccess = () => { result = request.result }
    request.onerror = () => reject(request.error ?? new Error('IR 库操作失败'))
    tx.oncomplete = () => resolve(result)
    tx.onerror = () => reject(tx.error ?? new Error('IR 库写入失败'))
    tx.onabort = () => reject(tx.error ?? new Error('IR 库写入已取消'))
  })
}

/** 在同一写事务内检查持久化容量，避免重载或并发导入绕过缓存上限。 */
function addStoredIr(db: IDBDatabase, entry: StoredIr): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    const store = tx.objectStore(STORE_NAME)
    const count = store.count()
    let failure: Error | null = null
    count.onsuccess = () => {
      if (count.result >= MAX_IR_ENTRIES) {
        failure = new Error(IR_CAPACITY_MESSAGE)
        tx.abort()
        return
      }
      store.add(entry)
    }
    tx.oncomplete = () => resolve()
    tx.onerror = tx.onabort = () => reject(failure ?? tx.error ?? new Error('IR 库写入失败'))
  })
}

export async function saveConvolutionIr(name: string, purpose: ConvolutionPurpose, sampleRate: number, ir: Float32Array): Promise<ConvolutionIrMetadata> {
  if (runtime.list().length >= MAX_IR_ENTRIES) throw new Error(IR_CAPACITY_MESSAGE)
  const id = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`
  const metadata = runtime.register(id, ir, { name, purpose, sampleRate })
  try {
    const db = await openDatabase()
    if (db) {
      try { await addStoredIr(db, { ...metadata, ir: ir.slice() }) }
      finally { db.close() }
    }
  } catch (error) {
    runtime.remove(id)
    throw error
  }
  return metadata
}

export async function listConvolutionIr(): Promise<ConvolutionIrMetadata[]> {
  const entries = new Map(runtime.list().map((entry) => [entry.id, entry]))
  const db = await openDatabase()
  if (db) {
    try {
      const saved = await transact<StoredIr[]>(db, 'readonly', (store) => store.getAll())
      for (const entry of saved) entries.set(entry.id, {
        id: entry.id, name: entry.name, purpose: entry.purpose,
        sampleRate: entry.sampleRate, sampleCount: entry.sampleCount,
      })
    } finally { db.close() }
  }
  return Array.from(entries.values())
}

export async function loadConvolutionIr(id: string, targetSampleRate: number): Promise<{ ir: Float32Array; metadata: ConvolutionIrMetadata } | null> {
  let ir = runtime.get(id)
  let metadata = runtime.getMetadata(id)
  if (!ir || !metadata) {
    const db = await openDatabase()
    if (!db) return null
    try {
      const saved = await transact<StoredIr | undefined>(db, 'readonly', (store) => store.get(id))
      if (!saved) return null
      ir = saved.ir instanceof Float32Array ? saved.ir : new Float32Array(saved.ir)
      metadata = { id: saved.id, name: saved.name, purpose: saved.purpose,
        sampleRate: saved.sampleRate, sampleCount: saved.sampleCount }
      try { runtime.register(id, ir, metadata) } catch { /* 缓存已满时仍可从磁盘加载 */ }
    } finally { db.close() }
  }
  if (metadata.sampleRate !== targetSampleRate) ir = new Resampler(metadata.sampleRate, targetSampleRate).process(ir)
  return { ir, metadata }
}

export async function removeConvolutionIr(id: string): Promise<boolean> {
  const existed = runtime.remove(id)
  const db = await openDatabase()
  if (!db) return existed
  try {
    const saved = await transact<StoredIr | undefined>(db, 'readonly', (store) => store.get(id))
    if (saved) await transact(db, 'readwrite', (store) => store.delete(id))
    return existed || !!saved
  } finally { db.close() }
}

export async function updateConvolutionIrPurpose(id: string, purpose: ConvolutionPurpose): Promise<boolean> {
  const cached = runtime.get(id)
  const metadata = runtime.getMetadata(id)
  const db = await openDatabase()
  let saved: StoredIr | undefined
  if (db) {
    try {
      saved = await transact<StoredIr | undefined>(db, 'readonly', (store) => store.get(id))
      if (saved) await transact(db, 'readwrite', (store) => store.put({ ...saved!, purpose }))
    } finally { db.close() }
  }
  if (cached && metadata) runtime.register(id, cached, { name: metadata.name, sampleRate: metadata.sampleRate, purpose })
  return !!saved || !!metadata
}

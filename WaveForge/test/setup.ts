// vitest node 环境全局 stub：音效引擎 import @soundtouchjs/audio-worklet 需要 AudioWorkletNode；
// 引擎/场景测试依赖 localStorage 持久层。
;(globalThis as Record<string, unknown>).AudioWorkletNode = class AudioWorkletNode {}

const memoryStore = new Map<string, string>()
;(globalThis as Record<string, unknown>).localStorage = {
  getItem: (key: string) => (memoryStore.has(key) ? memoryStore.get(key) : null),
  setItem: (key: string, value: string) => { memoryStore.set(key, value) },
  removeItem: (key: string) => { memoryStore.delete(key) },
  clear: () => { memoryStore.clear() },
  key: (index: number) => Array.from(memoryStore.keys())[index] ?? null,
  get length() { return memoryStore.size },
}

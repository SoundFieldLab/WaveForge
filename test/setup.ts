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

// In Party 会话测试在 node 环境 import DGLabClient（模块级单例依赖 window）：
// 这里补最小 window 桥（各测试文件再按需覆盖具体行为）。
if (typeof (globalThis as Record<string, unknown>).window === 'undefined') {
  const minimalWindow: Record<string, unknown> = {
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => true,
    setTimeout: (handler: () => void, ms?: number) => setTimeout(handler, ms),
    clearTimeout: (id: number) => clearTimeout(id as unknown as NodeJS.Timeout),
    setInterval: () => 0,
    clearInterval: () => undefined,
  }
  ;(globalThis as Record<string, unknown>).window = minimalWindow
  ;(globalThis as Record<string, unknown>).addEventListener = minimalWindow.addEventListener
  ;(globalThis as Record<string, unknown>).removeEventListener = minimalWindow.removeEventListener
  ;(globalThis as Record<string, unknown>).dispatchEvent = minimalWindow.dispatchEvent
}

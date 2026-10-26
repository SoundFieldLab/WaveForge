/**
 * 移动端音效（v2 引擎）：纯 Web Audio 能力，手机/平板可直接跑。
 * 精简面 = 开关 + 内置场景（引擎自带 7 场景快照），完整调音室仍走 PC 端。
 * 场景持久化：localStorage 'waveforge:mobile-effects-scene'（'off' 或场景 id）。
 */
import { AudioEffectsEngine } from '../services/audio-effects-v2/AudioEffectsEngine'
import type { AudioGraphHandle } from '../hooks/useAudioPlayer'

const SCENE_KEY = 'waveforge:mobile-effects-scene'

let engine: AudioEffectsEngine | null = null
let attached = false
const listeners = new Set<() => void>()

export function getMobileEffectsScene(): string {
  try { return localStorage.getItem(SCENE_KEY) || 'off' } catch { return 'off' }
}

export function getMobileScenes(): Array<{ id: string; name: string; description?: string }> {
  // 构造无副作用（attach 才接线音频图）：设置页在未播放时也能列出可选场景
  if (!engine) engine = new AudioEffectsEngine()
  return engine.getBuiltinScenes().map(s => ({ id: s.id, name: s.name, description: s.description }))
}

export function setMobileEffectsScene(sceneId: string): void {
  try { localStorage.setItem(SCENE_KEY, sceneId) } catch { /* ignore */ }
  applyScene(sceneId)
  listeners.forEach(l => l())
}

export function subscribeMobileEffects(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

function applyScene(sceneId: string): void {
  if (!engine) return
  if (sceneId === 'off') {
    engine.dispose()
    attached = false
    return
  }
  const scene = engine.getBuiltinScenes().find(s => s.id === sceneId)
  if (scene) engine.applyScene(scene)
}

/** 音频图就绪（useAudioPlayer onAudioGraphReady）时接入；场景为 off 时保持直连。 */
export function attachMobileEffects(handle: AudioGraphHandle): void {
  if (!engine) engine = new AudioEffectsEngine()
  if (!attached) {
    engine.attach(handle)
    attached = true
  }
  const sceneId = getMobileEffectsScene()
  if (sceneId !== 'off') applyScene(sceneId)
}

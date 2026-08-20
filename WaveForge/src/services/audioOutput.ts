// 音频输出设备选择（渲染进程）：
// 依赖 main 进程 session.setDevicePermissionHandler 授权 media/audiooutput，
// 使 navigator.mediaDevices.enumerateDevices() 返回带真实标签的输出设备；
// 切换输出用 AudioContext.setSinkId —— WaveForge 所有音频都流经
// createMediaElementSource → masterGain → analyser → destination，因此打在
// AudioContext 上即可整体切换输出。

export interface AudioOutputDevice {
  deviceId: string
  label: string
  groupId: string
  isDefault: boolean
}

const STORAGE_DEVICE_ID = 'audioOutputDeviceId'
const STORAGE_DEVICE_LABEL = 'audioOutputDeviceLabel'

// 播放引擎音频图就绪后注册，供设置面板即时切换输出设备。
let activeAudioContext: AudioContext | null = null
export function registerActiveAudioContext(context: AudioContext | null): void {
  activeAudioContext = context
}
export function getActiveAudioContext(): AudioContext | null {
  return activeAudioContext
}

function getBridge(): { isSupported: () => Promise<boolean> } | null {
  return (window as any).electron?.audioOutput || null
}

// ---------- 设备缓存：应用启动即后台预载，弹窗打开直接显示 ----------
let supportedCache: boolean | null = null
let deviceCache: AudioOutputDevice[] | null = null

/** 当前运行环境是否支持输出设备枚举（Electron 桌面端；浏览器 fallback 直接不可用） */
export async function isOutputDeviceSupported(): Promise<boolean> {
  if (supportedCache !== null) return supportedCache
  if (!navigator.mediaDevices?.enumerateDevices) {
    supportedCache = false
    return false
  }
  const bridge = getBridge()
  if (!bridge) {
    supportedCache = false
    return false
  }
  try {
    supportedCache = await bridge.isSupported()
    return supportedCache
  } catch {
    supportedCache = false
    return false
  }
}

/** 实际枚举（不读缓存） */
async function enumerateOutputDevices(): Promise<AudioOutputDevice[]> {
  if (!navigator.mediaDevices?.enumerateDevices) return []
  let devices: MediaDeviceInfo[] = []
  try {
    devices = await navigator.mediaDevices.enumerateDevices()
  } catch {
    return []
  }
  const outputs = devices.filter((d) => d.kind === 'audiooutput')
  // Chromium 会附加 'default' / 'communications' 两个虚拟条目（指向当前默认设备），
  // 仅用于判定默认设备（按 groupId 关联真实设备），不展示为可选项避免重复。
  const virtualDefault = outputs.find((d) => d.deviceId === 'default')
  const defaultGroupId = virtualDefault?.groupId || ''
  const realDevices = outputs.filter((d) => d.deviceId !== 'default' && d.deviceId !== 'communications')
  return realDevices.map((d) => ({
    deviceId: d.deviceId,
    label: d.label?.trim() || '未命名设备',
    groupId: d.groupId || '',
    isDefault: Boolean(defaultGroupId && d.groupId === defaultGroupId),
  }))
}

/**
 * 应用启动时调用：预载一次设备列表（弹窗打开立即显示）。
 * 不做后台持续监听/刷新：设备列表只在打开「播放设备控制」弹窗或手动点刷新时更新。
 */
export async function initAudioOutputDevices(): Promise<void> {
  const supported = await isOutputDeviceSupported()
  if (supported) {
    deviceCache = await enumerateOutputDevices()
  } else {
    deviceCache = []
  }
}

/** 同步读取启动时预载的设备缓存（弹窗首次渲染直接显示，不触发进入动画） */
export function getCachedAudioOutputDevices(): AudioOutputDevice[] {
  return deviceCache || []
}

/** 枚举当前连接的音频输出设备（优先返回缓存，未初始化时现场枚举） */
export async function listAudioOutputDevices(): Promise<AudioOutputDevice[]> {
  if (deviceCache) return deviceCache
  const devices = await enumerateOutputDevices()
  deviceCache = devices
  return devices
}

/** 强制重新枚举并更新缓存（弹窗「刷新」按钮用） */
export async function refreshAudioOutputDevices(): Promise<AudioOutputDevice[]> {
  const devices = await enumerateOutputDevices()
  deviceCache = devices
  supportedCache = supportedCache ?? true
  return devices
}

// ---------- 选择持久化与应用 ----------

export interface StoredOutputDevice {
  deviceId: string
  label: string
}

export function getStoredOutputDevice(): StoredOutputDevice | null {
  try {
    const deviceId = localStorage.getItem(STORAGE_DEVICE_ID)
    if (!deviceId) return null
    return {
      deviceId,
      label: localStorage.getItem(STORAGE_DEVICE_LABEL) || '已选设备',
    }
  } catch {
    return null
  }
}

function persistOutputDevice(device: StoredOutputDevice | null): void {
  try {
    if (device) {
      localStorage.setItem(STORAGE_DEVICE_ID, device.deviceId)
      localStorage.setItem(STORAGE_DEVICE_LABEL, device.label)
    } else {
      localStorage.removeItem(STORAGE_DEVICE_ID)
      localStorage.removeItem(STORAGE_DEVICE_LABEL)
    }
  } catch { /* 忽略 */ }
}

/**
 * 把 AudioContext 输出切换到指定设备。成功才持久化。
 * @param deviceId 'default' 表示跟随系统默认（清除记忆）。
 * 跟随系统默认无需 AudioContext（清除记忆即可，图就绪后自然跟随系统）；
 * 切换到具体设备时若音频图未就绪，先记录选择（pending），播放器初始化图时自动应用。
 */
export async function applyOutputDevice(context: AudioContext | null, device: StoredOutputDevice | null): Promise<{ success: boolean; error?: string; pending?: boolean }> {
  const targetDeviceId = device?.deviceId && device.deviceId !== 'default' ? device.deviceId : null
  // 跟随系统默认：无需 context，直接清除记忆（即使当前无音频图，下次播放也自然跟随系统默认）
  if (!targetDeviceId) {
    persistOutputDevice(null)
    if (context && typeof (context as any).setSinkId === 'function') {
      try {
        await (context as any).setSinkId(null)
      } catch { /* 已是默认设备时 setSinkId(null) 可能被拒，忽略（目标状态已达成） */ }
    }
    return { success: true }
  }
  if (!context) {
    // 音频图未就绪：先记录选择，播放器初始化图时自动应用（applyStoredOutputDevice）
    persistOutputDevice({ deviceId: targetDeviceId, label: device?.label || targetDeviceId })
    return { success: true, pending: true }
  }
  if (typeof (context as any).setSinkId !== 'function') {
    return { success: false, error: 'setSinkId-unsupported' }
  }
  try {
    await (context as any).setSinkId(targetDeviceId)
    persistOutputDevice({ deviceId: targetDeviceId, label: device?.label || targetDeviceId })
    return { success: true }
  } catch (error) {
    console.warn('[AudioOutput] setSinkId 切换失败:', error)
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/** 音频图创建后应用已保存的输出设备（useAudioPlayer.ensureAudioGraph 调用） */
export async function applyStoredOutputDevice(context: AudioContext | null): Promise<void> {
  const stored = getStoredOutputDevice()
  if (!stored) return
  const result = await applyOutputDevice(context, stored)
  if (!result.success) {
    // 设备已拔掉：清除记忆，回落到系统默认，避免下次启动再次尝试
    persistOutputDevice(null)
  }
}

/** 清除输出设备记忆（回到跟随系统默认） */
export function clearOutputDeviceMemory(): void {
  persistOutputDevice(null)
}

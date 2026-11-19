/**
 * WE 壁纸用户属性（project.json general.properties）——设置界面可调参数。
 *
 * WE 壁纸自带用户可调属性（配色 / 滑块 / 开关 / 下拉 / 文本），服务端
 * /api/wallpaper-engine/scene/properties 下发声明；用户覆盖值存 localStorage
 * （键 wallpaperEngineUserProperties，按壁纸 id 分桶），改动广播
 * wallpaperEngineUserPropsChanged 事件：
 * - WWGL 主链：挂载选项 properties + setProperties 热更（不重拉 scene.pkg）；
 * - legacy 兜底：覆盖值转 ?prop.<name>=<value> 附在 manifest 请求上（服务端
 *   buildSceneManifest 已支持，烤进材质常量后需重挂才生效）。
 */

export type WEUserPropertyType = 'slider' | 'color' | 'bool' | 'combo' | 'textinput'

/** WE 用户属性取值标量（与 webwallgl PropertyValue 同形状） */
export type WEUserPropertyValue = boolean | number | string

/** 单条属性声明（服务端 properties 端点下发的 project.json 条目 + 属性名） */
export interface WEUserPropertyDecl {
  name: string
  type: WEUserPropertyType
  /** WE 默认值：slider=数字、color="r g b"（0..1）、bool=布尔、combo=选项值、textinput=文本 */
  value: WEUserPropertyValue
  /** 显示名（WE 编辑器里用户填的 label） */
  text?: string
  min?: number
  max?: number
  step?: number
  options?: Array<{ label: string; value: string }>
  order?: number
}

export type WEUserPropertyValues = Record<string, WEUserPropertyValue>

const STORAGE_KEY = 'wallpaperEngineUserProperties'
export const WALLPAPER_ENGINE_USER_PROPS_EVENT = 'wallpaperEngineUserPropsChanged'

interface UserPropsStore {
  [wallpaperId: string]: WEUserPropertyValues
}

function readStore(): UserPropsStore {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function writeStore(store: UserPropsStore): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store))
  } catch { /* 存储满等异常：静默，属性覆盖是增强功能 */ }
}

/** 读某壁纸的全部用户覆盖值（无覆盖返回空对象） */
export function loadWallpaperEngineUserProps(wallpaperId: string): WEUserPropertyValues {
  if (!wallpaperId) return {}
  const values = readStore()[wallpaperId]
  return values && typeof values === 'object' ? { ...values } : {}
}

/** 合并写入覆盖值并广播事件（WWGL 画布监听后 setProperties 热更） */
export function saveWallpaperEngineUserProps(wallpaperId: string, partial: WEUserPropertyValues): WEUserPropertyValues {
  if (!wallpaperId) return {}
  const store = readStore()
  const merged = { ...(store[wallpaperId] || {}), ...partial }
  store[wallpaperId] = merged
  writeStore(store)
  dispatchPropsChanged(wallpaperId, merged)
  return { ...merged }
}

/** 清空某壁纸的全部覆盖值（恢复 WE 默认）并广播事件 */
export function resetWallpaperEngineUserProps(wallpaperId: string): void {
  if (!wallpaperId) return
  const store = readStore()
  if (!store[wallpaperId]) return
  delete store[wallpaperId]
  writeStore(store)
  dispatchPropsChanged(wallpaperId, {})
}

function dispatchPropsChanged(wallpaperId: string, values: WEUserPropertyValues): void {
  try {
    window.dispatchEvent(new CustomEvent(WALLPAPER_ENGINE_USER_PROPS_EVENT, {
      detail: { wallpaperId, values },
    }))
  } catch { /* ignore */ }
}

/** 订阅属性变更（回调收到 { wallpaperId, values }）；返回退订函数 */
export function subscribeWallpaperEngineUserProps(
  handler: (detail: { wallpaperId: string; values: WEUserPropertyValues }) => void,
): () => void {
  const listener = (event: Event) => {
    const detail = (event as CustomEvent).detail
    if (detail && typeof detail.wallpaperId === 'string') handler(detail)
  }
  window.addEventListener(WALLPAPER_ENGINE_USER_PROPS_EVENT, listener)
  return () => window.removeEventListener(WALLPAPER_ENGINE_USER_PROPS_EVENT, listener)
}

/**
 * 拉取属性声明（按 order / 插入顺序排序）。失败（404 = 非场景壁纸 / 服务未起）
 * 抛错由调用方决定隐藏属性区。
 */
export async function fetchWallpaperEngineUserProperties(wallpaperId: string): Promise<WEUserPropertyDecl[]> {
  const { getApiOrigin } = await import('./apiConfig')
  const origin = getApiOrigin()
  const response = await fetch(
    `${origin}/api/wallpaper-engine/scene/properties?id=${encodeURIComponent(wallpaperId)}`,
    { cache: 'no-store' },
  )
  if (!response.ok) throw new Error(`属性声明获取失败 (${response.status})`)
  const data = await response.json()
  if (!data?.success || !data.properties || typeof data.properties !== 'object') {
    throw new Error(data?.message || '属性声明格式非法')
  }
  const decls: WEUserPropertyDecl[] = []
  for (const [name, raw] of Object.entries(data.properties as Record<string, Record<string, unknown>>)) {
    if (!raw || typeof raw !== 'object') continue
    const type = String(raw.type || '')
    if (!['slider', 'color', 'bool', 'combo', 'textinput'].includes(type)) continue
    decls.push({
      name,
      type: type as WEUserPropertyType,
      value: (raw.value ?? '') as WEUserPropertyValue,
      text: typeof raw.text === 'string' ? raw.text : undefined,
      min: typeof raw.min === 'number' ? raw.min : undefined,
      max: typeof raw.max === 'number' ? raw.max : undefined,
      step: typeof raw.step === 'number' ? raw.step : undefined,
      options: Array.isArray(raw.options)
        ? (raw.options as Array<Record<string, unknown>>)
            .filter(opt => opt && typeof opt === 'object' && typeof opt.value === 'string')
            .map(opt => ({ label: String(opt.label ?? opt.value), value: String(opt.value) }))
        : undefined,
      order: typeof raw.order === 'number' ? raw.order : undefined,
    })
  }
  decls.sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
  return decls
}

/** 覆盖值与默认值合并后的「当前生效值」 */
export function effectivePropertyValue(decl: WEUserPropertyDecl, overrides: WEUserPropertyValues): WEUserPropertyValue {
  const override = overrides[decl.name]
  return override === undefined ? decl.value : override
}

/** "r g b"（0..1 浮点三元组）→ #rrggbb（非法输入回退黑色） */
export function rgbStringToHex(value: string): string {
  const parts = String(value).trim().split(/\s+/).map(Number)
  if (parts.length !== 3 || parts.some(n => !Number.isFinite(n))) return '#000000'
  const [r, g, b] = parts.map(n => Math.round(Math.min(1, Math.max(0, n)) * 255))
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`
}

/** #rrggbb / #rgb → "r g b"（0..1 三元组，WE 色属性格式） */
export function hexToRgbString(hex: string): string {
  const match = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(hex).trim())
  if (!match) return '0 0 0'
  let digits = match[1]
  if (digits.length === 3) digits = digits.split('').map(c => c + c).join('')
  const num = parseInt(digits, 16)
  const r = ((num >> 16) & 0xff) / 255
  const g = ((num >> 8) & 0xff) / 255
  const b = (num & 0xff) / 255
  return `${round3(r)} ${round3(g)} ${round3(b)}`
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000
}

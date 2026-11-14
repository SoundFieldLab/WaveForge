/**
 * WE 场景渲染验证探针（debug-we-scene.html 入口）
 * 用法：npm run dev 后打开 http://127.0.0.1:3000/debug-we-scene.html?id=defaultprojects/beach&server=http://127.0.0.1:3019
 * - id: 壁纸相对路径（工坊 id 或 defaultprojects/<名>）
 * - server: 可选，覆盖场景 API 后端（默认 http://localhost:3001）
 * 就绪标记 window.__weProbeReady = true 供截图脚本等待。
 */

import { WallpaperEngineSceneRenderer } from '../src/services/wallpaperEngineScene/renderer'

const params = new URLSearchParams(window.location.search)
const id = params.get('id') || 'defaultprojects/beach'
const hud = document.getElementById('hud') as HTMLDivElement
// ?nohud=1：隐藏调试面板（遮挡画面对象，如虹夏头发 origin 在屏幕左下 HUD 正后方）
if (params.get('nohud')) hud.style.display = 'none'
const canvas = document.getElementById('c') as HTMLCanvasElement

async function boot() {
  try {
    // ?msaa=1 恢复 antialias（默认 false：ANGLE 下从 MSAA 默认帧缓冲 copyTexImage2D
    // 会静默拿到未解析的空内容 → blend/composelayer 快照恒为 clearColor，2026-10-29 实证）
    const msaa = Boolean(params.get('msaa'))
    const gl = canvas.getContext('webgl2', { alpha: false, antialias: msaa })
    if (!gl) throw new Error('WebGL2 不可用')
    const renderer = new WallpaperEngineSceneRenderer(canvas, gl)
    await renderer.load(id)
    const manifest = renderer.getManifest()
    if (!manifest || manifest.objects.length === 0) throw new Error('清单为空')
    // 调试：?only=<名> 白名单 / ?hide=<名> 黑名单（逗号分隔），便于逐对象排查
    const only = params.get('only')
    if (only) {
      const keep = new Set(only.split(','))
      manifest.objects = manifest.objects.filter((o) => keep.has(o.name))
      if (manifest.objects.length === 0) throw new Error('无匹配对象: ' + only)
    }
    const hide = params.get('hide')
    if (hide) {
      const drop = new Set(hide.split(','))
      manifest.objects = manifest.objects.filter((o) => !drop.has(o.name))
    }
    // 名字可能带逗号 → 另支持按 id 过滤：?onlyid=191,205 / ?hideid=191
    const onlyId = params.get('onlyid')
    if (onlyId) {
      const keep = new Set(onlyId.split(',').map(Number))
      manifest.objects = manifest.objects.filter((o) => keep.has(o.id as number))
      if (manifest.objects.length === 0) throw new Error('无匹配对象 id: ' + onlyId)
    }
    const hideId = params.get('hideid')
    if (hideId) {
      const drop = new Set(hideId.split(',').map(Number))
      manifest.objects = manifest.objects.filter((o) => !drop.has(o.id as number))
    }
    // 调试：?reverse=1 反转绘制顺序（区分前置状态污染 vs 全局破坏）
    if (params.get('reverse')) manifest.objects.reverse()
    // 调试：?clear=r,g,b 覆盖 clearColor（判定露底 vs 暗部）
    const clear = params.get('clear')
    if (clear) {
      const rgb = clear.split(',').map(Number)
      if (rgb.length === 3 && rgb.every((v) => Number.isFinite(v))) manifest.scene.clearColor = rgb
    }
    // 调试：?noblend=1 剥离对象级 colorBlendMode（无快照捕获、无 BLENDMODE combo，
    // 判定 blend 快照机制 vs 效果链本身的伪影）
    if (params.get('noblend')) manifest.objects.forEach((o) => { o.colorBlendMode = 0 })
    // 调试：?maxpass=N 每对象只保留前 N 个 pass（分离基底 pass 与效果链）
    const maxPass = Number(params.get('maxpass'))
    if (Number.isFinite(maxPass) && maxPass > 0) {
      manifest.objects.forEach((o) => { o.passes = o.passes.slice(0, maxPass) })
    }
    hud.textContent = `id: ${id}\n对象: ${manifest.objects.length}\n正交盒: ${manifest.scene.ortho.width}x${manifest.scene.ortho.height}\n纹理加载中…`
    if (params.get('debugtex')) (renderer as unknown as { debugTextures: boolean }).debugTextures = true
    // 调试：?debugdraw=1 第 300 帧打印每对象每 pass 的绘制要素（mesh/quad、skip 原因）
    if (params.get('debugdraw')) (renderer as unknown as { debugDraw: boolean }).debugDraw = true
    // 调试：?nullchain=1 强制放行链首 tex0=null 的全屏后处理对象（godrays 等；链首输入=
    // 帧快照）；?nullchain=0 强制关闭（覆盖服务端 nullChainSafe 白名单默认放行）
    {
      const nc = params.get('nullchain')
      const flag = renderer as unknown as { nullChainEnabled: boolean }
      if (nc === '0') flag.nullChainEnabled = false
      else if (nc) flag.nullChainEnabled = true
    }
    // 调试：?maxchain=N 覆盖长装饰链降级阈值（默认 5；999=关闭降级，观察完整效果链）
    const maxChain = Number(params.get('maxchain'))
    if (Number.isFinite(maxChain) && maxChain > 0) (renderer as unknown as { chainLimit: number }).chainLimit = maxChain
    // 调试：?imgcheck=1 把第一个 PNG 纹理以 <img> 叠加显示（验证 PNG 内容本身）
    if (params.get('imgcheck')) {
      const firstPng = manifest.objects
        .flatMap((o) => o.passes.flatMap((p) => p.textures || []))
        .find((t) => t && t.image === 'png')
      if (firstPng) {
        const img = document.createElement('img')
        img.src = `${firstPng.url}?id=${encodeURIComponent(id)}&name=${encodeURIComponent(firstPng.textureFile)}`
        img.style.cssText = 'position:fixed;right:8px;top:8px;width:320px;z-index:20;border:1px solid #f00;background:#0f0'
        img.alt = 'png check'
        document.body.appendChild(img)
      }
    }
    await renderer.preloadTextures()
    renderer.start()
    setTimeout(() => {
      const err = renderer.getError()
      const texInfo = Object.entries(renderer.getTextureDebugInfo())
        .map(([k, v]) => `${k.split('/').pop()}: ${v}`).join('\n')
      hud.textContent += '\n状态: 实时渲染中' + (err ? ('\n渲染错误: ' + err) : '')
        + (texInfo ? '\n-- 纹理 --\n' + texInfo : '')
    }, 1500)
    ;(window as unknown as { __weProbeReady: boolean }).__weProbeReady = true
    // 调试钩子：SHOT_EVAL 可直接探查渲染器内部（modelMeshes/puppetStates/已编译 pass 数等）
    ;(window as unknown as Record<string, unknown>).__weRenderer = renderer
  } catch (error) {
    hud.textContent = 'FAIL: ' + (error instanceof Error ? error.message : String(error))
    ;(window as unknown as { __weProbeReady: string }).__weProbeReady = 'fail'
  }
}

void boot()

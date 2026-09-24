/**
 * 游戏式着色器预热（shader warmup）：
 * 在启动后空闲期用临时 WebGL2 上下文提前编译一批 GLSL，把编译结果写入磁盘
 * GpuDiskCache（键为 GLSL 源码）。之后真实的可视化引擎（three.js / Pixi）首次
 * 链接相同源码的 shader 时直接命中磁盘缓存 —— 这是游戏启动时"预编译着色器"的思路。
 *
 * 语料分两层：
 *  1. 真实引擎 shader（优先级最高）：folia diorama 粒子的 vert/frag 与引擎 ShaderMaterial
 *     提交给 GL 的源码逐字一致（ShaderMaterial 无注入），因此缓存直接命中，等价于进播放页那一下
 *     的预编译。
 *  2. 代表性兜底语料（软点光粒子 / 高斯模糊 / fbm 溶解 / 噪声位移）：为未来新增引擎 shader
 *     热身翻译器与驱动管线，以及 pixi/twgl 等无法裸编译路径的通用热身。
 *
 * 注意（Pixi 侧）：pv 的 glitchFilter 等是 Pixi v8 约定格式，Pixi 编译时会注入版本头与系统
 * uniform，裸编译无法命中 —— 这类 shader 由引擎自身的 GlProgram 创建与首次渲染写入缓存，
 * 本模块不重复做。
 * 全程尽力而为，任何失败都静默吞掉，不影响主流程。
 */

import {
  DIORAMA_PARTICLE_VERTEX_SHADER,
  DIORAMA_PARTICLE_FRAGMENT_SHADER,
} from '../vendor/folia/components/visualizer/diorama/dioramaParticleShaders'

type ShaderPair = { vert: string; frag: string }

const FULLSCREEN_VERT = `#version 300 es
in vec2 aPosition;
out vec2 vUv;
void main() {
  vUv = aPosition * 0.5 + 0.5;
  gl_Position = vec4(aPosition, 0.0, 1.0);
}`

const CORPUS: ShaderPair[] = [
  {
    // 0. ⭐ 真实引擎 shader：folia diorama 粒子（three ShaderMaterial 提交给 GL 的源码与
    //    本字符串逐字一致 → GpuDiskCache 直接命中，等价于播放页那一下的预编译）。
    //    注意该系 shader 使用 GLSL1（attribute/varying、无 #version），与 WebGL2 上下文兼容
    //    无版本 shader 的语义一致，可安全裸编译。
    vert: DIORAMA_PARTICLE_VERTEX_SHADER,
    frag: DIORAMA_PARTICLE_FRAGMENT_SHADER,
  },
  {
    // A. 软点光粒子（≈ diorama 软点粒子：core 不透明盘 + glow 叠加光晕）
    vert: `#version 300 es
in vec2 aPosition;
uniform float uSize;
out vec2 vPoint;
void main() {
  gl_Position = vec4(aPosition, 0.0, 1.0);
  gl_PointSize = uSize;
  vPoint = aPosition;
}`,
    frag: `#version 300 es
precision highp float;
in vec2 vPoint;
uniform vec3 uColor;
uniform float uGlow;
out vec4 fragColor;
void main() {
  vec2 p = gl_PointCoord - vec2(0.5);
  float r = length(p) * 2.0;
  float core = 1.0 - smoothstep(0.2, 0.75, r);
  float halo = pow(clamp(1.0 - r * 0.9, 0.0, 1.0), 1.7);
  float a = max(core, halo * uGlow * 0.4);
  if (a < 0.004) discard;
  fragColor = vec4(uColor, a);
}`,
  },
  {
    // B. 9-tap 高斯模糊（≈ 后处理滤镜/sonnet blur）
    vert: FULLSCREEN_VERT,
    frag: `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uTexture;
uniform vec2 uDirection;
out vec4 fragColor;
void main() {
  vec4 c = texture(uTexture, vUv) * 0.227027;
  for (int i = 1; i <= 4; i++) {
    vec2 off = uDirection * float(i) / 128.0;
    c += texture(uTexture, vUv + off) * 0.1945946;
    c += texture(uTexture, vUv - off) * 0.1216216;
  }
  fragColor = c;
}`,
  },
  {
    // C. fbm 噪声溶解（≈ sora / paper 溶解过渡）
    vert: FULLSCREEN_VERT,
    frag: `#version 300 es
precision highp float;
in vec2 vUv;
uniform float uTime;
uniform float uDissolve;
uniform vec3 uColor;
out vec4 fragColor;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
             mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float fbm(vec2 p) {
  float v = 0.0; float a = 0.5;
  for (int i = 0; i < 4; i++) { v += a * noise(p); p *= 2.03; a *= 0.5; }
  return v;
}
void main() {
  float d = fbm(vUv * 3.0 + uTime * 0.2) + uDissolve - vUv.y * 0.1;
  float alpha = smoothstep(0.0, 0.08, d);
  fragColor = vec4(uColor, alpha);
}`,
  },
  {
    // D. 噪声频带位移（≈ glitch / tempera 扰动）
    vert: FULLSCREEN_VERT,
    frag: `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uTexture;
uniform float uIntensity;
uniform float uTime;
out vec4 fragColor;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
void main() {
  float bandHeight = 0.02 + uIntensity * 0.06;
  float band = floor(vUv.y / bandHeight);
  float noise = hash(vec2(band, floor(uTime * 6.0)));
  vec2 uv = vUv;
  if (noise > 1.0 - uIntensity * 0.4) {
    uv.x += (hash(vec2(band + 0.5, floor(uTime * 8.0))) - 0.5) * uIntensity * 0.12;
  }
  fragColor = texture(uTexture, uv);
}`,
  },
]

function compileProgram(gl: WebGL2RenderingContext, shaders: ShaderPair): WebGLProgram | null {
  const compile = (type: number, source: string): WebGLShader | null => {
    const shader = gl.createShader(type)
    if (!shader) return null
    gl.shaderSource(shader, source)
    gl.compileShader(shader)
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      gl.deleteShader(shader)
      return null
    }
    return shader
  }
  const vs = compile(gl.VERTEX_SHADER, shaders.vert)
  const fs = compile(gl.FRAGMENT_SHADER, shaders.frag)
  if (!vs || !fs) return null
  const program = gl.createProgram()
  if (!program) return null
  gl.attachShader(program, vs)
  gl.attachShader(program, fs)
  gl.linkProgram(program)
  gl.deleteShader(vs)
  gl.deleteShader(fs)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    gl.deleteProgram(program)
    return null
  }
  return program
}

/**
 * 合成器预热：Chromium 首次解析 backdrop-filter / filter / clip-path / 大 box-shadow 这类
 * 高级合成属性时有一次性的建合成层 + 采样管线开销（folia 播放页大量用到），冷启动首帧会
 * 卡。预埋一个隐藏元素触发一次合成提交后移除，把该成本提前到空闲期。
 */
function prewarmCssFx() {
  const el = document.createElement('div')
  el.style.cssText = [
    'position:fixed',
    'top:0',
    'left:-9999px',
    'width:8px',
    'height:8px',
    'opacity:0.001',
    'pointer-events:none',
    'backdrop-filter:blur(16px) saturate(160%)',
    '-webkit-backdrop-filter:blur(16px) saturate(160%)',
    'filter:blur(8px) contrast(1.1)',
    'clip-path:polygon(0 0,100% 0,100% 100%,0 100%)',
    'box-shadow:0 16px 64px rgba(255,0,0,0.5)',
    'transform:translate3d(0,0,0)',
    'will-change:transform,backdrop-filter',
    'contain:layout paint style',
  ].join(';')
  document.documentElement.appendChild(el)
  const doubleRaf = () => {
    el.getBoundingClientRect() // 强制走一遍 style/layout/paint/合成提交
    el.remove()
  }
  requestAnimationFrame(() => requestAnimationFrame(doubleRaf))
}

let warmed = false

/**
 * 启动后空闲预热。默认仅执行一次；渲染后端切换的预热流程传 force=true 强制重跑
 * （重启后模块状态重置，但启动预热 effect 可能已先占位守卫）。无 WebGL2 / 硬件加速
 * 关闭 / 非桌面时静默跳过。
 */
export function runShaderWarmup(force = false): void {
  if (warmed && !force) return
  warmed = true

  const doWarm = () => {
    const canvas = document.createElement('canvas')
    canvas.width = 8
    canvas.height = 8
    canvas.style.display = 'none'
    let gl: WebGL2RenderingContext | null = null
    try {
      gl = canvas.getContext('webgl2', {
        powerPreference: 'high-performance',
        antialias: false,
        depth: false,
        stencil: false,
        failIfMajorPerformanceCaveat: false,
      }) as WebGL2RenderingContext | null
      if (!gl) return
      const compiled: WebGLProgram[] = []
      for (const pair of CORPUS) {
        const program = compileProgram(gl, pair)
        if (program) {
          // 触发一次 draw 前完整状态绑定，确保 uniform 布局/UBO 缓存也走一遍
          gl.useProgram(program)
          const pos = gl.getAttribLocation(program, 'aPosition')
          if (pos >= 0) gl.enableVertexAttribArray(pos)
          compiled.push(program)
        }
      }
      gl.getError() // 冲刷错误状态，避免残留 FLUSH 影响后续上下文
      for (const program of compiled) gl.deleteProgram(program)
    } catch {
      /* 尽力而为 */
    } finally {
      try { gl?.getExtension('WEBGL_lose_context')?.loseContext() } catch { /* 忽略 */ }
      canvas.remove()
    }
  }

  const schedule = () => {
    if (document.visibilityState === 'visible') {
      // 首帧之后空闲执行，避免抢启动关键路径；GPU 编译 + 合成器预热一并触发
      const runAll = () => { doWarm(); try { prewarmCssFx() } catch { /* 尽力而为 */ } }
      if (typeof requestIdleCallback === 'function') {
        requestIdleCallback(() => window.setTimeout(runAll, 300), { timeout: 3000 })
      } else {
        window.setTimeout(runAll, 2000)
      }
    }
  }
  if (document.visibilityState === 'visible') {
    if (document.readyState === 'complete') schedule()
    else window.addEventListener('load', schedule, { once: true })
  }
}
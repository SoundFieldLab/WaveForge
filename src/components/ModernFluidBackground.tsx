import { memo, useEffect, useRef, useState } from 'react'
import { DEFAULT_FLUID_PALETTE, extractCoverPalette } from '../utils/coverPalette'

/**
 * 摩登流体背景（自研）：用封面取色驱动一个域扭曲噪声场，缓慢流动的色块。
 *
 * 说明：着色器与实现均为自写（value noise + FBM + domain warping 属公开通用技术），
 * 不复制 AMLL 的背景渲染代码；那套实现为 AGPL-3.0，引入会让整个项目受其约束。
 * 性能：渲染分辨率按容器的一半（上限 960×540）——背景本就柔和，低分辨率不可辨；
 * 播放暂停时停在当前帧，不空转 rAF。
 */

const VERTEX_SHADER = `
attribute vec2 a_pos;
void main() {
  gl_Position = vec4(a_pos, 0.0, 1.0);
}
`

const FRAGMENT_SHADER = `
precision mediump float;

uniform vec2 u_resolution;
uniform float u_time;
uniform vec3 u_p0;
uniform vec3 u_p1;
uniform vec3 u_p2;
uniform vec3 u_p3;
/** 1 = 深色主题（整体压暗，衬托歌词），0 = 浅色主题（整体提亮） */
uniform float u_dark;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash(i + vec2(0.0, 0.0)), hash(i + vec2(1.0, 0.0)), u.x),
    mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x),
    u.y
  );
}

float fbm(vec2 p) {
  float value = 0.0;
  float amplitude = 0.5;
  for (int i = 0; i < 4; i++) {
    value += amplitude * noise(p);
    p *= 2.03;
    amplitude *= 0.5;
  }
  return value;
}

void main() {
  // 按短边归一化，任意宽高比都不会拉伸变形
  vec2 p = (gl_FragCoord.xy - 0.5 * u_resolution) / min(u_resolution.x, u_resolution.y);
  float t = u_time * 0.035;

  // 两级域扭曲：先扭曲采样域，再用扭曲结果继续扭曲 → 有机的流体感
  vec2 q = vec2(
    fbm(p * 1.35 + vec2(0.0, t)),
    fbm(p * 1.35 + vec2(5.2, -t))
  );
  vec2 r = vec2(
    fbm(p * 1.1 + 2.4 * q + vec2(1.7, 9.2) + t * 0.55),
    fbm(p * 1.1 + 2.4 * q + vec2(8.3, 2.8) - t * 0.45)
  );
  float field = fbm(p + 2.1 * r);

  vec3 color = u_p0;
  color = mix(color, u_p1, smoothstep(0.12, 0.62, field));
  color = mix(color, u_p2, smoothstep(0.34, 0.86, length(r)));
  color = mix(color, u_p3, smoothstep(0.22, 0.92, q.x));

  // 中心轻微提亮 + 边缘暗角，让歌词所在的中间区域更通透
  float vignette = smoothstep(1.15, 0.2, length(p));
  color *= mix(0.74, 1.08, vignette);

  // 深色主题压暗（避免背景抢歌词），浅色主题轻微提亮
  color = mix(color * 1.06, color * 0.62, u_dark);

  gl_FragColor = vec4(clamp(color, 0.0, 1.0), 1.0);
}
`

const MAX_WIDTH = 960
const MAX_HEIGHT = 540
const QUALITY = 0.5

type RgbTriplet = [number, number, number]

const hexToRgb = (hex: string): RgbTriplet => {
  const match = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(hex.trim())
  if (!match) return [0.1, 0.12, 0.18]
  return [
    Number.parseInt(match[1], 16) / 255,
    Number.parseInt(match[2], 16) / 255,
    Number.parseInt(match[3], 16) / 255,
  ]
}

const normalizePalette = (palette: readonly string[]): RgbTriplet[] => {
  const colors = palette.length > 0 ? palette : [...DEFAULT_FLUID_PALETTE]
  return Array.from({ length: 4 }, (_, index) => hexToRgb(colors[index % colors.length]))
}

interface ModernFluidBackgroundProps {
  coverUrl: string
  isPlaying: boolean
  playerTheme?: 'light' | 'dark'
  /** 播放暂停时为省电降到的帧率上限 */
  idleFps?: number
}

export default memo(function ModernFluidBackground({
  coverUrl,
  isPlaying,
  playerTheme = 'dark',
  idleFps = 12,
}: ModernFluidBackgroundProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [palette, setPalette] = useState<readonly string[]>(() => [...DEFAULT_FLUID_PALETTE])
  const isPlayingRef = useRef(isPlaying)
  const paletteRef = useRef<RgbTriplet[]>(normalizePalette([...DEFAULT_FLUID_PALETTE]))
  const darkRef = useRef(playerTheme === 'dark' ? 1 : 0)

  isPlayingRef.current = isPlaying
  darkRef.current = playerTheme === 'dark' ? 1 : 0

  // 封面变化 → 重新取色（缓存命中时是同步的）
  useEffect(() => {
    let cancelled = false
    if (!coverUrl) return
    void extractCoverPalette(coverUrl).then(colors => {
      if (!cancelled) setPalette(colors)
    })
    return () => { cancelled = true }
  }, [coverUrl])

  paletteRef.current = normalizePalette(palette)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const gl = canvas.getContext('webgl', { antialias: false, depth: false, alpha: false, powerPreference: 'low-power' })
      || canvas.getContext('experimental-webgl' as 'webgl')
    // WebGL 不可用（软件渲染/被禁用）时保持空白，由下层背景兜底
    if (!gl) return

    const compile = (type: number, source: string) => {
      const shader = (gl as WebGLRenderingContext).createShader(type)
      if (!shader) return null
      ;(gl as WebGLRenderingContext).shaderSource(shader, source)
      ;(gl as WebGLRenderingContext).compileShader(shader)
      if (!(gl as WebGLRenderingContext).getShaderParameter(shader, (gl as WebGLRenderingContext).COMPILE_STATUS)) {
        ;(gl as WebGLRenderingContext).deleteShader(shader)
        return null
      }
      return shader
    }

    const context = gl as WebGLRenderingContext
    const vertexShader = compile(context.VERTEX_SHADER, VERTEX_SHADER)
    const fragmentShader = compile(context.FRAGMENT_SHADER, FRAGMENT_SHADER)
    const program = vertexShader && fragmentShader ? context.createProgram() : null
    if (!program || !vertexShader || !fragmentShader) {
      return () => {
        if (vertexShader) context.deleteShader(vertexShader)
        if (fragmentShader) context.deleteShader(fragmentShader)
      }
    }
    context.attachShader(program, vertexShader)
    context.attachShader(program, fragmentShader)
    context.linkProgram(program)
    if (!context.getProgramParameter(program, context.LINK_STATUS)) {
      context.deleteProgram(program)
      context.deleteShader(vertexShader)
      context.deleteShader(fragmentShader)
      return
    }
    context.useProgram(program)

    const buffer = context.createBuffer()
    context.bindBuffer(context.ARRAY_BUFFER, buffer)
    context.bufferData(
      context.ARRAY_BUFFER,
      new Float32Array([-1, -1, 3, -1, -1, 3]),
      context.STATIC_DRAW,
    )
    const positionLocation = context.getAttribLocation(program, 'a_pos')
    context.enableVertexAttribArray(positionLocation)
    context.vertexAttribPointer(positionLocation, 2, context.FLOAT, false, 0, 0)

    const uniforms = {
      resolution: context.getUniformLocation(program, 'u_resolution'),
      time: context.getUniformLocation(program, 'u_time'),
      dark: context.getUniformLocation(program, 'u_dark'),
      palette: [0, 1, 2, 3].map(index => context.getUniformLocation(program, `u_p${index}`)) as Array<WebGLUniformLocation | null>,
    }

    // 渲染分辨率：容器一半，封顶 960×540（背景柔和，低分辨率不可辨）
    const resize = () => {
      const parent = canvas.parentElement
      const width = Math.max(320, Math.min(MAX_WIDTH, Math.round((parent?.clientWidth || MAX_WIDTH) * QUALITY)))
      const height = Math.max(180, Math.min(MAX_HEIGHT, Math.round((parent?.clientHeight || MAX_HEIGHT) * QUALITY)))
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width
        canvas.height = height
        context.viewport(0, 0, width, height)
      }
    }
    resize()
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(resize) : null
    if (observer && canvas.parentElement) observer.observe(canvas.parentElement)

    // 调色板插值：切歌换色时平滑过渡，不闪变
    const current: RgbTriplet[] = paletteRef.current.map(color => [...color] as RgbTriplet)
    let elapsed = 0
    let lastFrame = 0
    let rafId: number | null = null
    let lastDark = -1
    const IDLE_FRAME_MS = 1000 / Math.max(1, idleFps)

    const render = (now: number) => {
      rafId = requestAnimationFrame(render)
      const playing = isPlayingRef.current
      const minFrameMs = playing ? 0 : IDLE_FRAME_MS
      const delta = lastFrame > 0 ? Math.min(100, now - lastFrame) : 16.7
      if (delta < minFrameMs) return
      lastFrame = now
      // 暂停时时间不推进：画面停在当前帧，不空转
      if (playing) elapsed += delta / 1000

      const target = paletteRef.current
      for (let i = 0; i < current.length; i += 1) {
        const to = target[i] || target[0]
        for (let channel = 0; channel < 3; channel += 1) {
          current[i][channel] += (to[channel] - current[i][channel]) * 0.05
        }
      }

      const dark = darkRef.current
      context.uniform2f(uniforms.resolution, canvas.width, canvas.height)
      context.uniform1f(uniforms.time, elapsed)
      if (dark !== lastDark) {
        context.uniform1f(uniforms.dark, dark)
        lastDark = dark
      }
      current.forEach((color, index) => {
        const location = uniforms.palette[index]
        if (location) context.uniform3f(location, color[0], color[1], color[2])
      })
      context.drawArrays(context.TRIANGLES, 0, 3)
    }

    rafId = requestAnimationFrame(render)

    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId)
      observer?.disconnect()
      context.deleteBuffer(buffer)
      context.deleteProgram(program)
      context.deleteShader(vertexShader)
      context.deleteShader(fragmentShader)
    }
  }, [idleFps])

  return (
    <div className="absolute inset-0 overflow-hidden" aria-hidden="true">
      <canvas
        ref={canvasRef}
        className="absolute inset-0 h-full w-full"
        // 轻微模糊把低分辨率渲染的硬边柔化，与整体背景观感一致
        style={{ filter: 'blur(6px)', transform: 'scale(1.04)' }}
      />
    </div>
  )
})

/**
 * WE 粒子系统 v2：CPU 模拟 + WebGL2 instanced billboard 渲染
 *
 * 覆盖范围（按本机工坊库实测算子频率取舍）：
 * - emitter: sphererandom（椭球壳随机位置）/ boxrandom（盒内随机位置）
 * - initializer: lifetimerandom / sizerandom / velocityrandom / colorrandom /
 *   alpharandom / rotationrandom / angularvelocityrandom / turbulentvelocityrandom（近似）
 * - operator: movement(gravity/drag) / alphafade / sizechange / alphachange / colorchange /
 *   oscillateposition / oscillatealpha / oscillatesize / angularmovement /
 *   turbulence（真实 curl noise：3D simplex 解析导数）/ vortex（近似切向）
 * - renderer: sprite（spritetrail/ropetrail 降级为 sprite）
 * - spritesheet: sequence（按 tex-json spritesheetsequences.duration 循环播帧，WE 引擎
 *   ComputeSpriteFrame 的 floor(frac(lifetime)*numFrames) 语义）/ randomframe（随机相位
 *   入场后续播）；帧数/时长来自 .tex-json（server 下发 sheetFrames/sheetDuration），
 *   缺失时回退整张贴图摊寿命。SPRITESHEETBLEND（相邻帧交叉淡化）官方资产零使用，不实现。
 * - children: 子系统从父粒子位置发射（每父粒子按子系统自身 rate 生成，WE 编辑器语义）
 *
 * 已知简化：boids/controlpointattract/remapvalue/mapsequence 不支持（粒子照常渲染）；
 * 子系统只一层（server children 深度 1）。
 * 命名对照 WE 引擎着色器（wallpaper_engine/assets/shaders/common_particles.h）：
 * billboard right/up = 旋转矩阵作用于屏幕朝向基。
 */

import type { SceneParticleDef, SceneTextureInfo } from './types'

export type { SceneTextureInfo }

const INSTANCE_FLOATS = 14 // pos(3) + size(1) + color(4) + rotSinCos(2) + uvRect(4)
const HARD_CAP = 4096

// ---------------------------------------------------------------------------
// 3D simplex noise（Stefan Gustavson 导数版移植）：turbulence 的 curl 流场基础
// 返回 [value, d/dx, d/dy, d/dz]，value ∈ [-1,1]
// ---------------------------------------------------------------------------

const GRAD3 = new Float32Array([
  1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1, 0,
  1, 0, 1, -1, 0, 1, 1, 0, -1, -1, 0, -1,
  0, 1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1,
])
const SIMPLEX_PERM = new Uint8Array(512)
const SIMPLEX_PERM_MOD12 = new Uint8Array(512)
{
  // 固定种子打乱 0..255（mulberry32），保证各会话一致
  let s = 0x9e3779b9
  const rand = () => {
    s |= 0; s = (s + 0x6d2b79f5) | 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const p = new Uint8Array(256)
  for (let i = 0; i < 256; i += 1) p[i] = i
  for (let i = 255; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1))
    const tmp = p[i]; p[i] = p[j]; p[j] = tmp
  }
  for (let i = 0; i < 512; i += 1) {
    SIMPLEX_PERM[i] = p[i & 255]
    SIMPLEX_PERM_MOD12[i] = SIMPLEX_PERM[i] % 12
  }
}

function simplexNoise3(xin: number, yin: number, zin: number, out: Float32Array): void {
  const F3 = 1 / 3
  const G3 = 1 / 6
  const s = (xin + yin + zin) * F3
  const i = Math.floor(xin + s)
  const j = Math.floor(yin + s)
  const k = Math.floor(zin + s)
  const t = (i + j + k) * G3
  const x0 = xin - (i - t)
  const y0 = yin - (j - t)
  const z0 = zin - (k - t)
  let i1: number, j1: number, k1: number, i2: number, j2: number, k2: number
  if (x0 >= y0) {
    if (y0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 1; k2 = 0 }
    else if (x0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 0; k2 = 1 }
    else { i1 = 0; j1 = 0; k1 = 1; i2 = 1; j2 = 0; k2 = 1 }
  } else {
    if (y0 < z0) { i1 = 0; j1 = 0; k1 = 1; i2 = 0; j2 = 1; k2 = 1 }
    else if (x0 < z0) { i1 = 0; j1 = 1; k1 = 0; i2 = 0; j2 = 1; k2 = 1 }
    else { i1 = 0; j1 = 1; k1 = 0; i2 = 1; j2 = 1; k2 = 0 }
  }
  const x1 = x0 - i1 + G3, y1 = y0 - j1 + G3, z1 = z0 - k1 + G3
  const x2 = x0 - i2 + 2 * G3, y2 = y0 - j2 + 2 * G3, z2 = z0 - k2 + 2 * G3
  const x3 = x0 - 1 + 3 * G3, y3 = y0 - 1 + 3 * G3, z3 = z0 - 1 + 3 * G3
  const ii = i & 255, jj = j & 255, kk = k & 255
  let n = 0
  let dx = 0, dy = 0, dz = 0
  let t0 = 0.6 - x0 * x0 - y0 * y0 - z0 * z0
  if (t0 > 0) {
    const gi0 = SIMPLEX_PERM_MOD12[ii + SIMPLEX_PERM[jj + SIMPLEX_PERM[kk]]] * 3
    t0 *= t0
    const dot = GRAD3[gi0] * x0 + GRAD3[gi0 + 1] * y0 + GRAD3[gi0 + 2] * z0
    const t4 = t0 * t0
    n += t4 * dot
    const common = -8 * t0 * t0 * dot
    dx += common * x0 + t4 * GRAD3[gi0]
    dy += common * y0 + t4 * GRAD3[gi0 + 1]
    dz += common * z0 + t4 * GRAD3[gi0 + 2]
  }
  let t1 = 0.6 - x1 * x1 - y1 * y1 - z1 * z1
  if (t1 > 0) {
    const gi1 = SIMPLEX_PERM_MOD12[ii + i1 + SIMPLEX_PERM[jj + j1 + SIMPLEX_PERM[kk + k1]]] * 3
    t1 *= t1
    const dot = GRAD3[gi1] * x1 + GRAD3[gi1 + 1] * y1 + GRAD3[gi1 + 2] * z1
    const t4 = t1 * t1
    n += t4 * dot
    const common = -8 * t1 * t1 * dot
    dx += common * x1 + t4 * GRAD3[gi1]
    dy += common * y1 + t4 * GRAD3[gi1 + 1]
    dz += common * z1 + t4 * GRAD3[gi1 + 2]
  }
  let t2 = 0.6 - x2 * x2 - y2 * y2 - z2 * z2
  if (t2 > 0) {
    const gi2 = SIMPLEX_PERM_MOD12[ii + i2 + SIMPLEX_PERM[jj + j2 + SIMPLEX_PERM[kk + k2]]] * 3
    t2 *= t2
    const dot = GRAD3[gi2] * x2 + GRAD3[gi2 + 1] * y2 + GRAD3[gi2 + 2] * z2
    const t4 = t2 * t2
    n += t4 * dot
    const common = -8 * t2 * t2 * dot
    dx += common * x2 + t4 * GRAD3[gi2]
    dy += common * y2 + t4 * GRAD3[gi2 + 1]
    dz += common * z2 + t4 * GRAD3[gi2 + 2]
  }
  let t3 = 0.6 - x3 * x3 - y3 * y3 - z3 * z3
  if (t3 > 0) {
    const gi3 = SIMPLEX_PERM_MOD12[ii + 1 + SIMPLEX_PERM[jj + 1 + SIMPLEX_PERM[kk + 1]]] * 3
    t3 *= t3
    const dot = GRAD3[gi3] * x3 + GRAD3[gi3 + 1] * y3 + GRAD3[gi3 + 2] * z3
    const t4 = t3 * t3
    n += t4 * dot
    const common = -8 * t3 * t3 * dot
    dx += common * x3 + t4 * GRAD3[gi3]
    dy += common * y3 + t4 * GRAD3[gi3 + 1]
    dz += common * z3 + t4 * GRAD3[gi3 + 2]
  }
  out[0] = 32 * n
  out[1] = 32 * dx
  out[2] = 32 * dy
  out[3] = 32 * dz
}

// ---------------------------------------------------------------------------
// JSON 值解析工具（WE 的 min/max 可能是数字或 "x y z" 字符串）
// ---------------------------------------------------------------------------

function num(value: unknown, fallback = 0): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

/** "x y z" 字符串 / 数字 / undefined → vec3（数字标量时三分量同值） */
function vec3(value: unknown, fallback: [number, number, number]): [number, number, number] {
  if (typeof value === 'number') return [value, value, value]
  if (typeof value === 'string') {
    const parts = value.trim().split(/\s+/).map(Number)
    if (parts.length >= 3 && parts.every(Number.isFinite)) return [parts[0], parts[1], parts[2]]
    if (parts.length === 1 && Number.isFinite(parts[0])) return [parts[0], parts[0], parts[0]]
  }
  return fallback
}

/** 粒子级确定性随机（同一粒子多个算子各自取不同的稳定随机量） */
function hashRand(seed: number, salt: number): number {
  const x = Math.sin(seed * 12.9898 + salt * 78.233) * 43758.5453
  return x - Math.floor(x)
}

function randRange(min: number, max: number, rand: number): number {
  return min + (max - min) * rand
}

/** op.starttime..op.endtime（寿命占比）→ 阶段进度 0..1（alphachange/sizechange/colorchange） */
function stageProgress(age: number, maxLife: number, op: Record<string, unknown>): number {
  const start = num(op.starttime, 0)
  const end = num(op.endtime, 1)
  const t = age / Math.max(0.001, maxLife)
  if (end <= start) return t >= end ? 1 : 0
  return Math.min(1, Math.max(0, (t - start) / (end - start)))
}

// ---------------------------------------------------------------------------

export interface ParticleTexture {
  texture: WebGLTexture
  width: number
  height: number
  sheetColumns: number
  sheetRows: number
  /** spritesheetsequences[0].frames；0=缺 tex-json（回退 cols*rows） */
  sheetFrames: number
  /** spritesheetsequences[0].duration（秒）；0=缺 tex-json（回退寿命摊帧） */
  sheetDuration: number
}

export class ParticleSystem {
  private readonly def: SceneParticleDef
  private readonly capacity: number
  private count = 0
  private spawnAccumulator = 0
  private time = 0

  // SoA 状态池（count 内有效；死亡 swap-with-last 紧凑化）
  private posX: Float32Array; private posY: Float32Array; private posZ: Float32Array
  private baseX: Float32Array; private baseY: Float32Array; private baseZ: Float32Array
  private velX: Float32Array; private velY: Float32Array; private velZ: Float32Array
  private age: Float32Array
  private maxLife: Float32Array
  private size: Float32Array
  private colorR: Float32Array; private colorG: Float32Array; private colorB: Float32Array
  private alpha0: Float32Array
  private rot: Float32Array        // 弧度
  private angVel: Float32Array     // 弧度/秒
  private framePhase: Float32Array // spritesheet 相位偏移（randomframe 随机入场相位；sequence 恒 0）
  private seed: Float32Array       // 每粒子随机种子（振荡器相位等）
  // 实例上传缓冲（每帧打包）
  private instanceData: Float32Array
  private instanceVbo: WebGLBuffer
  private quadVao: WebGLVertexArrayObject
  private simplexOut = new Float32Array(4)

  constructor(
    def: SceneParticleDef,
    private readonly gl: WebGL2RenderingContext,
    private readonly texture: ParticleTexture | null,
  ) {
    this.def = def
    const cap = Math.min(
      HARD_CAP,
      Math.max(1, Math.round(def.maxcount * (def.instanceoverride?.count ?? 1))),
    )
    this.capacity = cap
    const f = () => new Float32Array(cap)
    this.posX = f(); this.posY = f(); this.posZ = f()
    this.baseX = f(); this.baseY = f(); this.baseZ = f()
    this.velX = f(); this.velY = f(); this.velZ = f()
    this.age = f(); this.maxLife = f(); this.size = f()
    this.colorR = f(); this.colorG = f(); this.colorB = f()
    this.alpha0 = f(); this.rot = f(); this.angVel = f()
    this.framePhase = f()
    this.seed = f()
    this.instanceData = new Float32Array(cap * INSTANCE_FLOATS)
    this.instanceVbo = gl.createBuffer()!
    this.quadVao = this.buildVao()
  }

  private buildVao(): WebGLVertexArrayObject {
    const gl = this.gl
    const vao = gl.createVertexArray()!
    gl.bindVertexArray(vao)
    // 共享 quad：aCorner ∈ [-0.5, 0.5]（loc0），非实例化（divisor 0）
    const cornerVbo = gl.createBuffer()!
    gl.bindBuffer(gl.ARRAY_BUFFER, cornerVbo)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      -0.5, -0.5, 0.5, -0.5, -0.5, 0.5,
      -0.5, 0.5, 0.5, -0.5, 0.5, 0.5,
    ]), gl.STATIC_DRAW)
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 8, 0)
    // 实例数据（loc1..5，divisor 1）
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceVbo)
    gl.bufferData(gl.ARRAY_BUFFER, this.instanceData.byteLength, gl.DYNAMIC_DRAW)
    const stride = INSTANCE_FLOATS * 4
    const attrs: [number, number, number][] = [
      [1, 3, 0],    // iPos vec3
      [2, 1, 12],   // iSize float
      [3, 4, 16],   // iColor vec4
      [4, 2, 32],   // iRotSinCos vec2
      [5, 4, 40],   // iUvRect vec4
    ]
    for (const [loc, size, offset] of attrs) {
      gl.enableVertexAttribArray(loc)
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride, offset)
      gl.vertexAttribDivisor(loc, 1)
    }
    gl.bindVertexArray(null)
    return vao
  }

  /**
   * 预热：挂载后按固定步长先模拟若干秒——雨/雪/萤火类粒子要按寿命堆积，
   * 不预热会从零开始慢慢变满屏（WE 引擎本体也做 warm-up）。
   * 子系统传父系统：父粒子先热身完成，子粒子才有发射位。
   */
  warmup(parent?: ParticleSystem): void {
    const warmSeconds = Math.min(this.def.starttime + 6, 10)
    const step = 1 / 30
    const steps = Math.min(600, Math.ceil(warmSeconds / step))
    for (let index = 0; index < steps; index += 1) {
      this.update(step, parent)
    }
  }

  // ---------------------------------------------------------------------------
  // 发射 + 初始化
  // ---------------------------------------------------------------------------

  private spawn(baseX?: number, baseY?: number, baseZ?: number): void {
    if (this.count >= this.capacity) return
    const index = this.count
    const def = this.def
    // 默认：寿命 1s、无速度、白色、不透明、无旋转、原点（首个 emitter 的 origin）
    let px = 0, py = 0, pz = 0
    let life = 1
    let size = 32
    let r = 1, g = 1, b = 1
    let alpha = 1
    let rotDeg = 0
    let angVelDeg = 0

    for (const emitter of def.emitter) {
      if (!emitter) continue
      // 子系统发射：origin = 父粒子位置，形状采样围绕该点
      const origin: [number, number, number] = baseX !== undefined
        ? [baseX, baseY ?? 0, baseZ ?? 0]
        : vec3(emitter.origin, [0, 0, 0])
      const min = num(emitter.distancemin, 0)
      const max = num(emitter.distancemax, 0)
      const name = String(emitter.name || '')
      if (name === 'sphererandom') {
        // 随机方向 → 按 directions 压成椭球 → 半径在 [min,max] 壳内
        // （snowstorm directions '1 0.05 1' = 压扁的水平雪幕，实证）
        const dir = vec3(emitter.directions, [1, 1, 1])
        let dx = Math.random() * 2 - 1
        let dy = Math.random() * 2 - 1
        let dz = Math.random() * 2 - 1
        const len = Math.hypot(dx, dy, dz) || 1
        dx = (dx / len) * dir[0]
        dy = (dy / len) * dir[1]
        dz = (dz / len) * dir[2]
        const radius = randRange(min, max, Math.random())
        px = origin[0] + dx * radius
        py = origin[1] + dy * radius
        pz = origin[2] + dz * radius
      } else if (name === 'boxrandom') {
        // 盒内均匀随机（distancemin/distancemax = 各轴半径下/上限，标量时等值）
        const extMin = vec3(emitter.distancemin, [0, 0, 0])
        const extMax = vec3(emitter.distancemax, [0, 0, 0])
        px = origin[0] + randRange(-extMin[0], extMax[0], Math.random())
        py = origin[1] + randRange(-extMin[1], extMax[1], Math.random())
        pz = origin[2] + randRange(-extMin[2], extMax[2], Math.random())
      } else {
        px = origin[0]; py = origin[1]; pz = origin[2]
      }
    }

    for (const init of def.initializer) {
      if (!init) continue
      const name = String(init.name || '')
      const exponent = num(init.exponent, 1) || 1
      const initMin = init.min
      const initMax = init.max
      // 分布采样：v = lo + (hi-lo) * rand^exponent（WE 的 exponent 偏向低值）
      const sample = (lo: number, hi: number) => lo + (hi - lo) * Math.pow(Math.random(), exponent)
      if (name === 'lifetimerandom') {
        life = sample(num(initMin, 1), num(initMax, 1))
      } else if (name === 'sizerandom') {
        size = sample(num(initMin, 32), num(initMax, 32))
      } else if (name === 'velocityrandom') {
        // WE 允许 min>max（区间取反语义）：逐轴在两者之间取随机
        const vMin = vec3(initMin, [0, 0, 0])
        const vMax = vec3(initMax, [0, 0, 0])
        this.velX[index] = randRange(vMin[0], vMax[0], Math.random())
        this.velY[index] = randRange(vMin[1], vMax[1], Math.random())
        this.velZ[index] = randRange(vMin[2], vMax[2], Math.random())
      } else if (name === 'colorrandom') {
        const cMin = vec3(initMin, [255, 255, 255])
        const cMax = vec3(initMax, [255, 255, 255])
        // WE 编辑器色值 0..255（snowstorm 90..100 的灰雪实证）
        r = randRange(cMin[0], cMax[0], Math.random()) / 255
        g = randRange(cMin[1], cMax[1], Math.random()) / 255
        b = randRange(cMin[2], cMax[2], Math.random()) / 255
      } else if (name === 'alpharandom') {
        alpha = sample(num(initMin, 1), num(initMax, 1))
      } else if (name === 'rotationrandom') {
        const rMin = vec3(initMin, [0, 0, 0])
        const rMax = vec3(initMax, [0, 0, 0])
        rotDeg = randRange(rMin[2], rMax[2], Math.random())
      } else if (name === 'angularvelocityrandom') {
        const rMin = vec3(initMin, [0, 0, 0])
        const rMax = vec3(initMax, [0, 0, 0])
        angVelDeg = randRange(rMin[2], rMax[2], Math.random())
      } else if (name === 'turbulentvelocityrandom') {
        // 近似：随机方向 * [speedmin, speedmax] 初速（真实是流场噪声，漂移观感接近）
        const speed = randRange(num(init.speedmin, 0), num(init.speedmax, 0), Math.random())
        const theta = Math.random() * Math.PI * 2
        this.velX[index] += Math.cos(theta) * speed
        this.velY[index] += Math.sin(theta) * speed * 0.6
        this.velZ[index] += (Math.random() - 0.5) * speed
      }
    }

    // spritesheet 入场相位：randomframe 随机相位（后续按序列时钟续播）；sequence 恒 0
    this.framePhase[index] = def.animationmode === 'randomframe' && this.totalFrames() > 1
      ? Math.random()
      : 0

    this.posX[index] = px; this.posY[index] = py; this.posZ[index] = pz
    this.baseX[index] = px; this.baseY[index] = py; this.baseZ[index] = pz
    this.age[index] = 0
    this.maxLife[index] = Math.max(0.016, life)
    this.size[index] = size * (def.instanceoverride?.size ?? 1)
    this.colorR[index] = r; this.colorG[index] = g; this.colorB[index] = b
    this.alpha0[index] = alpha * (def.instanceoverride?.alpha ?? 1)
    this.rot[index] = rotDeg * (Math.PI / 180)
    this.angVel[index] = angVelDeg * (Math.PI / 180)
    this.seed[index] = Math.random() * 1000
    this.count += 1
  }

  private totalFrames(): number {
    const tex = this.texture
    if (!tex) return 1
    if (tex.sheetFrames > 0) return tex.sheetFrames
    return Math.max(1, tex.sheetColumns * tex.sheetRows)
  }

  // ---------------------------------------------------------------------------
  // 模拟
  // ---------------------------------------------------------------------------

  update(dt: number, parent?: ParticleSystem): void {
    if (dt <= 0) return
    this.time += dt

    // 发射（rate 累积器；instanceoverride.rate 缩放）。
    // 子系统：跳过自身 emitter，改为从父粒子位置发射——每个父粒子都是发射器，
    // 子系统 rate 语义 = 每父粒子每秒生成数（WE 编辑器 children 语义），均匀随机
    // 挑选存活父粒子落点（数学上等价于逐父累积）。
    const rate = this.def.emitter.reduce((acc, emitter) => acc + num(emitter?.rate, 0), 0)
      * (this.def.instanceoverride?.rate ?? 1)
    if (parent) {
      if (rate > 0 && parent.count > 0) {
        this.spawnAccumulator += parent.count * rate * dt
        while (this.spawnAccumulator >= 1 && this.count < this.capacity) {
          this.spawnAccumulator -= 1
          const pick = Math.floor(Math.random() * parent.count)
          this.spawn(parent.posX[pick], parent.posY[pick], parent.posZ[pick])
        }
      }
    } else if (rate > 0) {
      this.spawnAccumulator += rate * dt
      while (this.spawnAccumulator >= 1 && this.count < this.capacity) {
        this.spawnAccumulator -= 1
        this.spawn()
      }
    }
    if (this.spawnAccumulator > this.capacity) this.spawnAccumulator = 0

    // 逐粒子推进
    let index = 0
    while (index < this.count) {
      this.age[index] += dt
      if (this.age[index] >= this.maxLife[index]) {
        this.kill(index)
        continue
      }

      let vx = this.velX[index]
      let vy = this.velY[index]
      let vz = this.velZ[index]

      for (const op of this.def.operator) {
        if (!op) continue
        const name = String(op.name || '')
        if (name === 'movement') {
          const gravity = vec3(op.gravity, [0, 0, 0])
          const drag = num(op.drag, 0)
          vx += gravity[0] * dt
          vy += gravity[1] * dt
          vz += gravity[2] * dt
          if (drag > 0) {
            const damp = Math.max(0, 1 - drag * dt)
            vx *= damp; vy *= damp; vz *= damp
          }
        } else if (name === 'turbulence') {
          // 真实 curl noise：ψ=(n1,n2,n3) 三个偏移 simplex 场的旋度 → 无散度流场。
          // WE 字段（exampleturbolence.json 实测）：scale=坐标缩放（像素→噪声空间）、
          // speedmin/speedmax=速度幅（每粒子稳定随机）、timescale=时间维演化速度（可负）。
          const scale = num(op.scale, 0.005)
          const speed = randRange(num(op.speedmin, 0), num(op.speedmax, 0), hashRand(this.seed[index], 7))
          const tc = this.time * num(op.timescale, 1) * 0.01
          const cx = this.posX[index] * scale
          const cy = this.posY[index] * scale
          const cz = this.posZ[index] * scale
          simplexNoise3(cx, cy + tc, cz + 31.7, this.simplexOut)
          const d1x = this.simplexOut[1], d1y = this.simplexOut[2], d1z = this.simplexOut[3]
          simplexNoise3(cx + 17.3, cy + tc, cz, this.simplexOut)
          const d2x = this.simplexOut[1], d2y = this.simplexOut[2], d2z = this.simplexOut[3]
          simplexNoise3(cx, cy + tc, cz - 53.9, this.simplexOut)
          const d3x = this.simplexOut[1], d3y = this.simplexOut[2], d3z = this.simplexOut[3]
          vx += (d3y - d2z) * speed * dt
          vy += (d1z - d3x) * speed * dt
          vz += (d2x - d1y) * speed * dt
        } else if (name === 'vortex') {
          // 近似切向速度：绕 axis（过 emitter 原点）旋转
          const axis = vec3(op.axis, [0, 0, 1])
          const speed = randRange(num(op.speedinner, 0), num(op.speedouter, 0), hashRand(this.seed[index], 9))
          const dx = this.posX[index] - this.def.emitterOrigin[0]
          const dy = this.posY[index] - this.def.emitterOrigin[1]
          const dist = Math.sqrt(dx * dx + dy * dy) || 1
          vx += (-dy / dist) * axis[2] * speed * dt
          vy += (dx / dist) * axis[2] * speed * dt
        }
      }

      this.velX[index] = vx
      this.velY[index] = vy
      this.velZ[index] = vz
      this.posX[index] += vx * dt
      this.posY[index] += vy * dt
      this.posZ[index] += vz * dt
      this.rot[index] += this.angVel[index] * dt
      index += 1
    }
  }

  private kill(index: number): void {
    const last = this.count - 1
    if (index !== last) {
      this.posX[index] = this.posX[last]; this.posY[index] = this.posY[last]; this.posZ[index] = this.posZ[last]
      this.baseX[index] = this.baseX[last]; this.baseY[index] = this.baseY[last]; this.baseZ[index] = this.baseZ[last]
      this.velX[index] = this.velX[last]; this.velY[index] = this.velY[last]; this.velZ[index] = this.velZ[last]
      this.age[index] = this.age[last]
      this.maxLife[index] = this.maxLife[last]
      this.size[index] = this.size[last]
      this.colorR[index] = this.colorR[last]; this.colorG[index] = this.colorG[last]; this.colorB[index] = this.colorB[last]
      this.alpha0[index] = this.alpha0[last]
      this.rot[index] = this.rot[last]
      this.angVel[index] = this.angVel[last]
      this.framePhase[index] = this.framePhase[last]
      this.seed[index] = this.seed[last]
    }
    this.count -= 1
  }

  // ---------------------------------------------------------------------------
  // 绘制（打包实例数据 + drawArraysInstanced）
  // ---------------------------------------------------------------------------

  /**
   * 打包实例数据，返回实际粒子数（0 = 无粒子，调用方跳过绘制状态设置）。
   * alphaScale = 对象级 alpha（scene.json obj.alpha）。
   */
  packInstances(alphaScale: number): number {
    const tex = this.texture
    const data = this.instanceData
    const cols = Math.max(1, tex?.sheetColumns ?? 1)
    const rows = Math.max(1, tex?.sheetRows ?? 1)
    const totalFrames = cols * rows
    const seqMult = Math.max(0.01, this.def.sequencemultiplier || 1)
    let out = 0
    for (let index = 0; index < this.count; index += 1) {
      const age = this.age[index]
      const life = Math.max(0.001, this.maxLife[index])
      const lifeFrac = age / life
      let alphaMul = 1
      let sizeMul = 1
      let r = this.colorR[index]
      let g = this.colorG[index]
      let b = this.colorB[index]

      for (const op of this.def.operator) {
        if (!op) continue
        const name = String(op.name || '')
        if (name === 'alphafade') {
          // fadeintime/fadeouttime 为寿命占比 0..1（birds 30s 寿命配 0.9 缓出实证）
          const fadeIn = num(op.fadeintime, 0)
          const fadeOut = num(op.fadeouttime, 0)
          let mul = 1
          if (fadeIn > 0) mul = Math.min(mul, lifeFrac / fadeIn)
          if (fadeOut > 0) mul = Math.min(mul, (1 - lifeFrac) / fadeOut)
          alphaMul *= Math.min(1, Math.max(0, mul))
        } else if (name === 'alphachange') {
          const startV = num(op.startvalue, 1)
          const endV = num(op.endvalue, 1)
          alphaMul *= startV + (endV - startV) * stageProgress(age, life, op)
        } else if (name === 'sizechange') {
          const startV = num(op.startvalue, 1)
          const endV = num(op.endvalue, 1)
          sizeMul *= startV + (endV - startV) * stageProgress(age, life, op)
        } else if (name === 'oscillatealpha') {
          const freq = randRange(num(op.frequencymin, 0), num(op.frequencymax, 1), hashRand(this.seed[index], 1))
          const phase = randRange(num(op.phasemin, 0), num(op.phasemax, 1), hashRand(this.seed[index], 2)) * Math.PI * 2
          const scale = randRange(num(op.scalemin, 0), num(op.scalemax, 0), hashRand(this.seed[index], 3))
          alphaMul *= Math.max(0, 1 + Math.sin(age * freq * Math.PI * 2 + phase) * scale)
        } else if (name === 'oscillatesize') {
          const freq = randRange(num(op.frequencymin, 0), num(op.frequencymax, 1), hashRand(this.seed[index], 4))
          const scale = randRange(num(op.scalemin, 0), num(op.scalemax, 0), hashRand(this.seed[index], 5))
          sizeMul *= Math.max(0.001, 1 + Math.sin(age * freq * Math.PI * 2) * scale)
        } else if (name === 'colorchange') {
          const endC = vec3(op.endvalue, [r * 255, g * 255, b * 255])
          const p = stageProgress(age, life, op)
          r = r + (endC[0] / 255 - r) * p
          g = g + (endC[1] / 255 - g) * p
          b = b + (endC[2] / 255 - b) * p
        }
      }

      // oscillateposition：绕出生基点的正弦偏移（按 mask 轴）
      let ox = this.posX[index]
      let oy = this.posY[index]
      let oz = this.posZ[index]
      for (const op of this.def.operator) {
        if (!op || String(op.name || '') !== 'oscillateposition') continue
        const mask = vec3(op.mask, [1, 0, 0])
        const freq = randRange(num(op.frequencymin, 0), num(op.frequencymax, 1), hashRand(this.seed[index], 6))
        const phase = randRange(num(op.phasemin, 0), num(op.phasemax, 1), hashRand(this.seed[index], 2)) * Math.PI * 2
        const scale = randRange(num(op.scalemin, 0), num(op.scalemax, 0), hashRand(this.seed[index], 3))
        const wobble = Math.sin(age * freq * Math.PI * 2 + phase) * scale
        ox = this.baseX[index] + mask[0] * wobble
        oy = this.baseY[index] + mask[1] * wobble
        oz = this.baseZ[index] + mask[2] * wobble
      }

      // spritesheet 帧：WE ComputeSpriteFrame = floor(frac(lifetime)*numFrames)，
      // lifetime 循环滚动（每 duration 秒走完一张序列，与粒子寿命无关）。
      // sequence: 相位 = age*sequencemultiplier / duration；randomframe: 加随机入场相位。
      // 缺 tex-json（duration=0）回退整张贴图摊寿命（v1 行为）。
      const totalFrames = this.totalFrames()
      let frameIndex = 0
      if (totalFrames > 1 && tex) {
        const phase = tex.sheetDuration > 0
          ? (age * seqMult) / tex.sheetDuration
          : lifeFrac * seqMult
        frameIndex = Math.floor(((phase + this.framePhase[index]) % 1 + 1) % 1 * totalFrames) % totalFrames
      }
      const fx = frameIndex % cols
      const fy = Math.floor(frameIndex / cols) % rows
      const u0 = fx / cols
      const v0 = fy / rows
      const u1 = (fx + 1) / cols
      const v1 = (fy + 1) / rows

      const base = out * INSTANCE_FLOATS
      data[base] = ox
      data[base + 1] = oy
      data[base + 2] = oz
      data[base + 3] = this.size[index] * sizeMul
      data[base + 4] = r
      data[base + 5] = g
      data[base + 6] = b
      data[base + 7] = Math.min(1, this.alpha0[index] * alphaMul * alphaScale)
      data[base + 8] = Math.sin(this.rot[index])
      data[base + 9] = Math.cos(this.rot[index])
      data[base + 10] = u0
      data[base + 11] = v0
      data[base + 12] = u1
      data[base + 13] = v1
      out += 1
    }
    return out
  }

  /** 上传并绘制 count 个实例（着色器/纹理/混合状态由 renderer 设置） */
  drawInstances(count: number, worldMatrix: Float32Array, viewProjection: Float32Array): void {
    if (count <= 0 || !this.texture) return
    const gl = this.gl
    gl.bindVertexArray(this.quadVao)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceVbo)
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.instanceData.subarray(0, count * INSTANCE_FLOATS))
    // 着色器由 renderer 的 useParticleProgram 配好；这里补两块矩阵 uniform
    const program = gl.getParameter(gl.CURRENT_PROGRAM) as WebGLProgram | null
    if (program) {
      const worldLoc = gl.getUniformLocation(program, 'u_World')
      if (worldLoc) gl.uniformMatrix4fv(worldLoc, false, worldMatrix)
      const vpLoc = gl.getUniformLocation(program, 'u_ViewProj')
      if (vpLoc) gl.uniformMatrix4fv(vpLoc, false, viewProjection)
    }
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, count)
    gl.bindVertexArray(null)
  }

  dispose(): void {
    const gl = this.gl
    gl.deleteBuffer(this.instanceVbo)
    gl.deleteVertexArray(this.quadVao)
  }
}

/**
 * v3 引擎 AudioWorklet 处理器打包脚本
 *
 * AudioWorklet 全局作用域不支持裸 import/export：引擎与全部 DSP 依赖必须内联进
 * 单个处理器文件（见 src/services/waveforge-engine-v3/src/worklet/AudioEffectsProcessor.ts
 * 头注释与 docs/FUSION_GUIDE.md 步骤 3）。
 *
 * 产物：public/v3-worklet.js（dev 由 Vite 静态服务；build 由 Vite 拷入 dist/，
 * electron-builder 的 dist 通配打包规则已覆盖）。
 * esbuild 为 vite 的直接依赖，无需单独安装。
 */
import { build } from 'esbuild'
import { mkdirSync, existsSync, statSync, readdirSync, readFileSync, writeFileSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const entry = path.join(root, 'src/services/waveforge-engine-v3/src/worklet/AudioEffectsProcessor.ts')
const outfile = path.join(root, 'public/v3-worklet.js')

// 产物新鲜度检查：worklet 源码树无任何文件比产物新时跳过重打包。
// 此前 predev/prebuild 每次都无条件全量 esbuild（dev 启动/构建白付 1-2s）。
function newestMtimeMs(dir) {
  let newest = 0
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, name.name)
    const m = name.isDirectory() ? newestMtimeMs(p) : statSync(p).mtimeMs
    if (m > newest) newest = m
  }
  return newest
}

if (existsSync(outfile)) {
  try {
    const srcTree = path.join(root, 'src/services/waveforge-engine-v3/src')
    if (statSync(outfile).mtimeMs >= newestMtimeMs(srcTree)) {
      console.log(`[build-v3-worklet] ${path.relative(root, outfile)} 已是最新，跳过重打包`)
      process.exit(0)
    }
  } catch {
    // 检查失败（权限/竞态）则照常重打包，保持旧语义
  }
}

mkdirSync(path.dirname(outfile), { recursive: true })

// 写前读旧内容：内容一致则跳过写盘——esbuild 输出含随机 hash 键名/顺序差异时
// 每次都会产生假的未提交 diff（报告 P3：“工作区常驻未提交 diff”的根因之一）。
const previous = existsSync(outfile) ? readFileSync(outfile, 'utf8') : null
const output = await build({
  entryPoints: [entry],
  bundle: true,
  format: 'iife',
  minify: true,
  write: false,
  banner: {
    js: '// WaveForge v3 AudioWorklet processor (waveforge-v3-effects) — 自动生成，勿手改；重新生成：npm run build:v3-worklet',
  },
  logLevel: 'info',
})

const generated = output.outputFiles[0].text
if (previous !== null && previous === generated) {
  console.log(`[build-v3-worklet] ${path.relative(root, outfile)} 内容未变化，跳过写盘（避免常驻未提交 diff）`)
} else {
  writeFileSync(outfile, generated)
  console.log(`[build-v3-worklet] ${path.relative(root, outfile)} 已生成`)
}

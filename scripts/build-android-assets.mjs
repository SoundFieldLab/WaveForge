/**
 * 组装安卓应用资产：
 *  1) vite 以 android 配置构建前端（单入口）→ android/app/src/main/assets/nodejs-project/dist/
 *  2) esbuild 把 android-server.mjs + local-server.mjs + 依赖打成单文件 → .../nodejs-project/main.cjs
 *  3) 递增 MainActivity.kt 的 ASSETS_VERSION，触发设备端重新解压资产
 * 用法：node scripts/build-android-assets.mjs
 */
import { build as viteBuild } from 'vite'
import { build as esbuildBuild } from 'esbuild'
import { execSync } from 'child_process'
import { copyFileSync, existsSync, readFileSync, writeFileSync, readdirSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const ASSETS_DIR = join(ROOT, 'android', 'app', 'src', 'main', 'assets', 'nodejs-project')
const MAIN_CJS = join(ASSETS_DIR, 'main.cjs')
const MAIN_ACTIVITY = join(ROOT, 'android', 'app', 'src', 'main', 'java', 'com', 'waveforge', 'android', 'MainActivity.kt')
// @neteasecloudmusicapienhanced/api 在 require 时会扫描自身 module/ 目录做运行时插件加载，
// 无法被 esbuild 静态打包，因此标记为 external，由设备端 node_modules 提供完整依赖树。
const NETEASE_API_EXTERNAL = '@neteasecloudmusicapienhanced/api'
const NETEASE_API_VERSION = '4.39.0'

/**
 * CJS 输出下 import.meta 不可用（esbuild 置空），而 local-server.mjs 顶层有一句
 * `const __filename = fileURLToPath(import.meta.url)`（该变量实际未被使用）。
 * 打包时把它替换成安全表达式，避免 fileURLToPath('') 在启动时抛错。
 */
const fixImportMetaPlugin = {
  name: 'fix-local-server-import-meta',
  setup(build) {
    build.onLoad({ filter: /local-server\.mjs$/ }, async (args) => {
      const contents = (await readFileSync(args.path, 'utf8')).replace(
        /fileURLToPath\(import\.meta\.url\)/g,
        'process.cwd()'
      )
      return { contents, loader: 'js' }
    })
  },
}

async function buildFrontend() {
  console.log('[1/3] vite build（android 单入口）...')
  await viteBuild({ configFile: join(ROOT, 'vite.android.config.ts') })
}

async function buildServerBundle() {
  console.log('[2/3] esbuild 打包后端单文件 → main.cjs ...')
  const result = await esbuildBuild({
    entryPoints: [join(ROOT, 'android-server.mjs')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    outfile: MAIN_CJS,
    logLevel: 'info',
    plugins: [fixImportMetaPlugin],
    // qq-music-api 内部有运行时动态 require（jade 模板等）也已验证可打包；
    // 仅 netease 增强 API 必须保持 external（见文件顶部注释）。
    external: [NETEASE_API_EXTERNAL],
    // nodejs-mobile 精简构建缺全局 File：undici（fetch 实现）webidl 断言引用 File，
    // 加载即 ReferenceError 崩溃（模拟器/真机启动闪退）。banner 在最顶部执行，
    // 先于 bundle 内任何模块注入 File 全局。
    // 同时注册 node 崩溃捕获：uncaughtException/unhandledRejection 堆栈写入
    // filesDir/tv-crash.log，供局域网调试端口（:3002/crash）读取，无需 adb 定位崩溃。
    banner: {
      js:
        "if (typeof globalThis.File === 'undefined') { try { const { File: __wfFile } = require('buffer'); if (__wfFile) globalThis.File = __wfFile; } catch (__e) {} }" +
        "try { const __wfPath = require('path'); const __wfFs = require('fs');" +
        "const __wfCrashFile = __wfPath.join(__wfPath.dirname(process.argv[1] || process.cwd()), '..', 'tv-crash.log');" +
        "const __wfCrash = (__e) => { try { __wfFs.appendFileSync(__wfCrashFile, '[' + new Date().toISOString() + '] ' + ((__e && __e.stack) || String(__e)) + '\\n'); } catch (__x) {} }; " +
        "process.on('uncaughtException', __wfCrash); " +
        "process.on('unhandledRejection', (__r) => __wfCrash(__r instanceof Error ? __r : new Error(String(__r)))); } catch (__e) {}",
    },
  })
  console.log(`  bundle 完成${result.metafile ? '（' + Object.keys(result.metafile.inputs).length + ' 个输入文件）' : ''}`)
}

/** 设备端 node_modules：安装 netease 增强 API 的生产依赖树（external 包运行所需）。 */
function ensureDeviceNodeModules() {
  const apiDir = join(ASSETS_DIR, 'node_modules', '@neteasecloudmusicapienhanced', 'api')
  if (existsSync(join(apiDir, 'main.js'))) {
    console.log('  设备端 node_modules 已存在，跳过 npm install')
    return
  }
  console.log(`  安装 ${NETEASE_API_EXTERNAL}@${NETEASE_API_VERSION} 到设备端 node_modules ...`)
  execSync(
    `npm install --omit=dev --no-audit --no-fund --prefix "${ASSETS_DIR}" "${NETEASE_API_EXTERNAL}@${NETEASE_API_VERSION}"`,
    { stdio: 'inherit', cwd: ROOT }
  )
}

/**
 * nodejs-mobile 内核（V8 过旧）不支持 \p{ID_Start}/\p{ID_Continue} Unicode 属性，
 * Express 5 依赖的 path-to-regexp v8 加载即 SyntaxError（网易云增强 API 不可用）。
 * 构建后把这三处正则替换为 ASCII + 常见 Unicode 范围的近似等价（路由参数名足够）。
 * 幂等：每次构建都执行。
 */
function patchPathToRegexp() {
  const file = join(ASSETS_DIR, 'node_modules', 'path-to-regexp', 'dist', 'index.js')
  if (!existsSync(file)) {
    console.log('  path-to-regexp 不存在，跳过 patch')
    return
  }
  const src = readFileSync(file, 'utf8')
  const next = src
    .replace(/\\p\{ID_Start\}/g, 'A-Za-z\\u00AA-\\uFFFF')
    .replace(/\\p\{ID_Continue\}/g, 'A-Za-z0-9_\\u00AA-\\uFFFF')
  if (next !== src) {
    writeFileSync(file, next)
    console.log('  已 patch path-to-regexp（移除 \\p{ID_Start} 等 Unicode 属性，兼容 nodejs-mobile）')
  } else {
    console.log('  path-to-regexp 已兼容，无需 patch')
  }
}

/**
 * nodejs-mobile 上 os.tmpdir()/process.cwd() 都指向只读根目录，netease api 把匿名
 * token 写到那里会 EROFS 加载失败。patch 成 main.cjs 所在目录（filesDir 层，可写）。
 * 幂等：每次构建都执行。
 */
function patchNeteaseApi() {
  const files = [
    join(ASSETS_DIR, 'node_modules', '@neteasecloudmusicapienhanced', 'api', 'main.js'),
    join(ASSETS_DIR, 'node_modules', '@neteasecloudmusicapienhanced', 'api', 'app.js'),
    join(ASSETS_DIR, 'node_modules', '@neteasecloudmusicapienhanced', 'api', 'util', 'request.js'),
  ]
  // nodejs-mobile 的 os.tmpdir() 指向只读 /tmp：匿名 token 是缓存，统一容错处理。
  // main.js/app.js：写 token 静默失败；util/request.js：tmpPath 改可写目录 + 读取容错。
  const mainPatch = [
    {
      from: "const tmpPath = require('os').tmpdir()",
      to: "const tmpPath = require('path').join(__dirname, '..', '..', '..')",
    },
    {
      from: "const tmpPath = require('process').cwd()",
      to: "const tmpPath = require('path').join(__dirname, '..', '..', '..')",
    },
    {
      from: "const tmpPath = require('path').dirname(process.argv[1] || process.cwd())",
      to: "const tmpPath = require('path').join(__dirname, '..', '..', '..')",
    },
    // 写失败静默（ESM 下 __dirname 不可用 / 路径不可写都不阻塞加载）
    {
      from: "if (!fs.existsSync(anonymousTokenPath)) {\n  fs.writeFileSync(anonymousTokenPath, '', 'utf-8')\n}",
      to: "if (!fs.existsSync(anonymousTokenPath)) { try { fs.writeFileSync(anonymousTokenPath, '', 'utf-8') } catch (__e) {} }",
    },
    {
      from: "if (!fs.existsSync(path.resolve(tmpPath, 'anonymous_token'))) {\n    fs.writeFileSync(path.resolve(tmpPath, 'anonymous_token'), '', 'utf-8')\n  }",
      to: "if (!fs.existsSync(path.resolve(tmpPath, 'anonymous_token'))) { try { fs.writeFileSync(path.resolve(tmpPath, 'anonymous_token'), '', 'utf-8') } catch (__e) {} }",
    },
  ]
  // util/request.js：util 目录上四级才到 nodejs-project；顶层读 token 也要容错
  const requestPatch = [
    {
      from: "const tmpPath = require('os').tmpdir()",
      to: "const tmpPath = require('path').join(__dirname, '..', '..', '..', '..')",
    },
    {
      from: "const anonymous_token = fs.readFileSync(\n  path.resolve(tmpPath, './anonymous_token'),\n  'utf-8',\n)",
      to: "let anonymous_token = ''\ntry { anonymous_token = fs.readFileSync(path.resolve(tmpPath, './anonymous_token'), 'utf-8') } catch (__e) {}",
    },
  ]
  for (const file of files) {
    if (!existsSync(file)) continue
    let src = readFileSync(file, 'utf8')
    let changed = false
    const rules = file.endsWith('request.js') ? requestPatch : mainPatch
    for (const p of rules) {
      const next = src.replace(p.from, p.to)
      if (next !== src) {
        src = next
        changed = true
      }
    }
    if (changed) {
      writeFileSync(file, src)
      console.log(`  已 patch ${file.split('/').pop()} 匿名 token（容错 + 可写路径）`)
    }
  }
}

/** 手机遥控器页面：remote-server.cjs 运行时按 __dirname/remote-ui.html 读取，需随包携带。 */
function copyRemoteUi() {
  const src = join(ROOT, 'desktop', 'remote-ui.html')
  const dest = join(ASSETS_DIR, 'remote-ui.html')
  copyFileSync(src, dest)
  console.log('  已复制 desktop/remote-ui.html → 设备资产')
}

/**
 * 旧 WebView（Chromium <111）不支持 color-mix。Tailwind v4 的 /opacity 修饰符
 * 输出 color-mix，110 上全部失效 → 半透明颜色变黑/丢失。
 * 构建后把两类 color-mix 基础声明替换成旧式 rgb(/alpha)：
 *  1) color-mix(in srgb, rgb(R G B/<alpha-value>) P%, transparent) → rgb(R G B / P%)
 *  2) color-mix(in oklab, var(--color-X) P%, transparent)
 *     → 提取 --color-X: oklch(...) 定义并转成 rgb，替换为 rgb(R G B / P%)
 * @supports 块里的 oklab color-mix 在 110 被忽略，不影响。
 */
function oklchToRgb(l, c, h) {
  // oklch → oklab → LMS → linear sRGB → sRGB
  const hr = (h * Math.PI) / 180
  const a = c * Math.cos(hr)
  const b = c * Math.sin(hr)
  const l_ = l + 0.3963377774 * a + 0.2158037573 * b
  const m_ = l - 0.1055613458 * a - 0.0638541728 * b
  const s_ = l - 0.0894841775 * a - 1.291485548 * b
  const l3 = l_ ** 3
  const m3 = m_ ** 3
  const s3 = s_ ** 3
  let r = 4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3
  let g = -1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3
  let bl = -0.0041960863 * l3 - 0.7034186147 * m3 + 1.707614701 * s3
  const gamma = (u) => (u <= 0.0031308 ? 12.92 * u : 1.055 * Math.pow(u, 1 / 2.4) - 0.055)
  return [r, g, bl].map((v) => Math.round(Math.max(0, Math.min(1, gamma(v))) * 255)).join(' ')
}

function patchCssColorMix() {
  const cssDir = join(ASSETS_DIR, 'dist', 'assets')
  if (!existsSync(cssDir)) return
  let patched = 0
  for (const name of readdirSync(cssDir)) {
    if (!name.endsWith('.css')) continue
    const file = join(cssDir, name)
    let src = readFileSync(file, 'utf8')
    let changed = false

    // 1) 提取 --color-* 定义 → rgb，替换定义本身（var() 引用仍有效）。oklch 和 hex 都处理
    const colorMap = {}
    src = src.replace(
      /(--color-[a-z0-9-]+):\s*oklch\(([\d.]+%?)\s+([\d.]+%?)\s+([\d.]+)\)/g,
      (whole, name, l, c, h) => {
        const parse = (v) => (String(v).endsWith('%') ? parseFloat(v) / 100 : parseFloat(v))
        const rgb = oklchToRgb(parse(l), parse(c), parse(h))
        colorMap[name] = rgb
        changed = true
        return `${name}: rgb(${rgb})`
      }
    )
    src = src.replace(
      /(--color-[a-z0-9-]+):\s*#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})/g,
      (whole, name, hex) => {
        const full = hex.length === 3 ? hex.split('').map((ch) => ch + ch).join('') : hex
        const r = parseInt(full.slice(0, 2), 16)
        const g = parseInt(full.slice(2, 4), 16)
        const b = parseInt(full.slice(4, 6), 16)
        colorMap[name] = `${r} ${g} ${b}`
        changed = true
        return `${name}: rgb(${r} ${g} ${b})`
      }
    )

    // 2) color-mix(in srgb, rgb(.../<alpha-value>) P%, transparent) → rgb(/alpha)
    src = src.replace(
      /color-mix\(in srgb,\s*rgb\(([^)]*?)\s*\/\s*<alpha-value>\)\s*([\d.]+%),\s*transparent\)/g,
      (whole, channels, pct) => {
        changed = true
        return `rgb(${channels} / ${pct})`
      }
    )

    // 3) color-mix(in oklab, var(--color-X) P%, transparent) → rgb(转换值 / P%)
    src = src.replace(
      /color-mix\(in oklab,\s*var\((--color-[a-z0-9-]+)\)\s*([\d.]+%),\s*transparent\)/g,
      (whole, name, pct) => {
        if (!colorMap[name]) return whole // 未转换的定义保留原样（@supports 内不影响 110）
        changed = true
        return `rgb(${colorMap[name]} / ${pct})`
      }
    )

    // 4) Tailwind v4 渐变用 `to right in oklab`（oklab 插值，Chromium 111+）：
    //    去掉 ` in oklab`，用默认 srgb 插值，Chromium 110 的 linear-gradient 恢复生效
    src = src.replace(/(--tw-gradient-position:[^;]*?)\s+in oklab/g, (whole, pos) => {
      changed = true
      return pos
    })

    if (changed) {
      writeFileSync(file, src)
      patched++
    }
  }
  console.log(`  已 patch ${patched} 个 CSS：color-mix → rgb(/alpha)（兼容 Chromium <111）`)
}

/**
 * TV 端布局基准：dist/index.html 的 viewport 静态设为 width=2133（= 1920/0.9，
 * 软件 UI 整体缩小 10%）。桌面构建（vite.config.ts）不受影响。
 * JS 动态改 meta 无效（reload 会重置），必须在静态 HTML 里设置。
 */
function patchTvViewport() {
  const indexPath = join(ASSETS_DIR, 'dist', 'index.html')
  if (!existsSync(indexPath)) {
    console.log('  dist/index.html 不存在，跳过 viewport patch')
    return
  }
  const src = readFileSync(indexPath, 'utf8')
  const next = src.replace(
    /<meta name="viewport"[^>]*>/,
    // width=2133（1920/0.9，UI 缩小 10%）。不能带 initial-scale=1：
    // 它会强制初始缩放 1，布局以原始大小显示 → 只能看左上角 + 滚动。
    // 无 initial-scale 时 WebView overview 自动把布局适配到屏幕宽度。
    '<meta name="viewport" content="width=2133" />'
  )
  if (next !== src) {
    writeFileSync(indexPath, next)
    console.log('  已 patch dist/index.html viewport → width=2133（TV 布局基准，UI 缩小 10%）')
  } else {
    console.log('  dist/index.html viewport 已是 2133，无需 patch')
  }
}

function bumpAssetsVersion() {
  console.log('[3/3] 递增 MainActivity.kt ASSETS_VERSION ...')
  if (!existsSync(MAIN_ACTIVITY)) throw new Error(`找不到 ${MAIN_ACTIVITY}`)
  const src = readFileSync(MAIN_ACTIVITY, 'utf8')
  const matched = src.match(/private const val ASSETS_VERSION = (\d+)/)
  if (!matched) throw new Error('MainActivity.kt 中找不到 ASSETS_VERSION 常量')
  const next = parseInt(matched[1], 10) + 1
  writeFileSync(MAIN_ACTIVITY, src.replace(`private const val ASSETS_VERSION = ${matched[1]}`, `private const val ASSETS_VERSION = ${next}`))
  console.log(`  ASSETS_VERSION ${matched[1]} → ${next}`)
}

async function main() {
  await buildFrontend()
  await buildServerBundle()
  ensureDeviceNodeModules()
  patchPathToRegexp()
  patchNeteaseApi()
  copyRemoteUi()
  patchTvViewport()
  patchCssColorMix()
  bumpAssetsVersion()
  console.log('\n完成。资产目录：', ASSETS_DIR)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})

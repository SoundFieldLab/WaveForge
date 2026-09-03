/**
 * 编译 WaveForge 安装器 UI 预览（不打包 App）。
 * 用 electron-builder 缓存的 makensis 编译 scripts/setup-preview/preview.nsi，
 * 输出 release/setup-preview.exe —— 直接运行即可看到真实向导界面。
 * 改 build/installerSidebar.bmp、installerHeader.bmp 或 installer.nsh 后重跑本脚本即可快速迭代。
 *
 * 用法：npm run preview:setup
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const NSI = join(ROOT, 'scripts', 'setup-preview', 'preview.nsi')
const UNINSTALL_NSI = join(ROOT, 'scripts', 'setup-preview', 'uninstall-preview.nsi')
const OUT = join(ROOT, 'release', 'setup-preview.exe')
const UNINSTALL_OUT = join(ROOT, 'release', 'uninstall-preview.exe')
const UNINSTALL_BUILDER = join(ROOT, 'release', 'uninstall-preview-builder.exe')
const APP_VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version || '0.1.4'

function directorySize(path) {
  if (!existsSync(path)) return 0
  return readdirSync(path, { withFileTypes: true }).reduce((total, entry) => {
    const item = join(path, entry.name)
    return total + (entry.isDirectory() ? directorySize(item) : statSync(item).size)
  }, 0)
}

const estimatedSizeKb = Math.ceil(directorySize(join(ROOT, 'release', 'win-unpacked')) / 1024)

// 生成 UI 位图（背景/按钮/卡片）
execFileSync(process.execPath, [join(__dirname, 'generate-installer-ui.mjs')], { stdio: 'inherit', cwd: ROOT })

/** 查找 makensis：环境变量 → electron-builder 缓存 → 常见安装路径 */
function findMakensis() {
  if (process.env.MAKENSIS && existsSync(process.env.MAKENSIS)) return process.env.MAKENSIS
  const candidates = []
  const localAppData = process.env.LOCALAPPDATA || join(process.env.USERPROFILE || '', 'AppData', 'Local')
  candidates.push(join(localAppData, 'electron-builder', 'Cache', 'nsis-3.0.4.1', 'nsis-3.0.4.1-1mx3n', 'makensis.exe'))
  candidates.push('C:/Program Files (x86)/NSIS/makensis.exe')
  candidates.push('C:/Program Files/NSIS/makensis.exe')
  for (const c of candidates) if (existsSync(c)) return c
  return null
}

const makensis = findMakensis()
if (!makensis) {
  console.error('❌ 未找到 makensis。请先运行一次 `npx electron-builder --win nsis` 生成缓存，或设置环境变量 MAKENSIS。')
  process.exit(1)
}

execFileSync(makensis, ['/V2', `/DSRC=${ROOT.replace(/\\/g, '/')}`, `/DAPP_VERSION=${APP_VERSION}`, `/DESTIMATED_SIZE=${estimatedSizeKb}`, NSI], { stdio: 'inherit', cwd: ROOT })
execFileSync(makensis, ['/V2', `/DSRC=${ROOT.replace(/\\/g, '/')}`, UNINSTALL_NSI], { stdio: 'inherit', cwd: ROOT })
execFileSync(UNINSTALL_BUILDER, [], { stdio: 'inherit', cwd: ROOT })
unlinkSync(UNINSTALL_BUILDER)
console.log(`\n安装预览：${OUT}\n卸载预览：${UNINSTALL_OUT}\n两个预览都不会写入或删除应用文件。`)

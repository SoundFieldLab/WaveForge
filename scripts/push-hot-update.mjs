/**
 * TV/平板/手机端无线热更新推送（开发共识的一部分，见 DEVELOPMENT-CONSENSUS.md）。
 *
 * 用法：node scripts/push-hot-update.mjs <设备IP> [--token=<调试令牌>] [--rebuild]
 *       node scripts/push-hot-update.mjs --adb [--serial=<序列号>] [--rebuild]   ← USB 直推（推荐）
 *   <设备IP>    目标设备局域网 IP（如投影仪 192.168.88.125）
 *   --adb       经 USB adb forward 直推（127.0.0.1:13008）：免 IP 免令牌（后端对回环
 *               来源豁免配对令牌），只要求设备开发者模式已开启
 *   --serial    多设备时指定 adb 序列号
 *   --token     设备调试服务的配对令牌（局域网推送时必填；:3008 的 /update 需令牌鉴权；
 *               令牌在设备后端日志里，或直接用调试台 URL 里的 ?token= 值）
 *   --rebuild   先构建 android 前端（vite build）再推送（推荐在改完代码后使用）
 *
 * 原理：读取 android/app/src/main/assets/nodejs-project/dist/ 下所有文件，
 * 打包 base64 POST 到设备调试服务 :3008/update?token=... → 设备替换文件 → 广播 reload → 前端自动刷新。
 * 无需重装 APK。要求设备开发者模式已开启（设置里打开，默认关）。
 */
import { readdirSync, readFileSync, statSync, existsSync } from 'fs'
import { join, relative, dirname } from 'path'
import { fileURLToPath } from 'url'
import { execSync } from 'child_process'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const DIST = join(ROOT, 'android', 'app', 'src', 'main', 'assets', 'nodejs-project', 'dist')

const tokenArg = process.argv.find(arg => arg.startsWith('--token='))
const debugToken = tokenArg ? tokenArg.slice('--token='.length).trim() : ''
const serialArg = process.argv.find(arg => arg.startsWith('--serial='))
const adbSerial = serialArg ? serialArg.slice('--serial='.length).trim() : ''
const useAdb = process.argv.includes('--adb')

let host = process.argv[2]
let targetPort = 3008
if (useAdb) {
  host = '127.0.0.1'
  targetPort = 13008
} else if (!host || host.startsWith('--')) {
  console.error('用法: node scripts/push-hot-update.mjs <设备IP[:端口]|--adb> [--token=<调试令牌>] [--rebuild]')
  process.exit(1)
} else {
  // 支持 "IP:端口"（模拟器 adb forward 场景：node scripts/push-hot-update.mjs 127.0.0.1:13008）
  const [h, p] = host.split(':')
  host = h
  targetPort = p || 3008
}

if (process.argv.includes('--rebuild')) {
  console.log('▶ 构建 android 前端...')
  execSync('npx vite build --config vite.android.config.ts', { stdio: 'inherit', cwd: ROOT })
}

// --adb：自动找 adb.exe（SDK 常见位置 / PATH）并 forward tcp:13008 → 设备 3008
if (useAdb) {
  const candidates = [
    process.env.ANDROID_ADB,
    process.env.WAVEFORGE_ADB,
    'adb',
    join(process.env.LOCALAPPDATA || '', 'Android', 'Sdk', 'platform-tools', 'adb.exe'),
  ].filter(Boolean)
  let adb = candidates.find(c => existsSync(c) || !c.includes('\\') /* PATH 上的命令 */)
  if (!adb) {
    console.error('❌ 找不到 adb：请设置 ANDROID_ADB 环境变量或在 PATH 里提供 adb')
    process.exit(1)
  }
  if (adb.includes('adb.exe') && !existsSync(adb) && adb !== 'adb') {
    adb = 'adb'
  }
  const serialOpt = adbSerial ? `-s ${adbSerial}` : ''
  console.log(`▶ ${adb} ${serialOpt} forward tcp:13008 tcp:3008 ...`)
  try {
    execSync(`${adb} ${serialOpt} forward tcp:13008 tcp:3008`, { stdio: 'inherit' })
  } catch (err) {
    console.error('❌ adb forward 失败：请确认设备已 USB 连接且调试授权')
    console.error(`   ${err.message}`)
    process.exit(1)
  }
}

/** 递归收集 dist 下所有文件（相对路径 + base64）。 */
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    const st = statSync(full)
    if (st.isDirectory()) {
      walk(full, out)
    } else {
      out.push({
        path: relative(DIST, full).replace(/\\/g, '/'),
        data: readFileSync(full).toString('base64'),
      })
    }
  }
  return out
}

const files = walk(DIST)
if (!debugToken && !useAdb) {
  console.error('⚠️ 未提供 --token：设备调试服务要求配对令牌（:3008 面板与 /update 均需鉴权）。')
  console.error('   令牌可在设备设置里开启开发者模式后，从调试台 URL（后端日志打印）中获得。')
  console.error('   或改用 USB 直推：node scripts/push-hot-update.mjs --adb（免令牌）。')
}
console.log(`▶ 推送 ${files.length} 个文件到 ${host}:${targetPort}/update ...`)
try {
  const res = await fetch(`http://${host}:${targetPort}/update?token=${encodeURIComponent(debugToken)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-WaveForge-Debug-Token': debugToken },
    body: JSON.stringify({ files }),
  })
  const data = await res.json().catch(() => ({}))
  if (res.status === 401) {
    console.error('❌ 推送被拒绝（401）：缺少或错误的调试令牌。用 --token=<令牌> 传入设备后端日志中的配对令牌。')
    process.exit(1)
  }
  if (data.ok) {
    console.log(`✅ 已推送 ${data.count} 个文件，设备页面即将自动刷新`)
  } else {
    console.error(`❌ 推送失败: ${data.error || '未知错误'}`)
    process.exit(1)
  }
} catch (err) {
  console.error(`❌ 无法连接 ${host}:${targetPort} —— 请确认设备已在设置中开启开发者模式（调试服务默认关）且与电脑同一局域网`)
  console.error(`   ${err.message}`)
  process.exit(1)
}

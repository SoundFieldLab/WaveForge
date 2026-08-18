/**
 * TV/平板/手机端无线热更新推送（开发共识的一部分，见 DEVELOPMENT-CONSENSUS.md）。
 *
 * 用法：node scripts/push-hot-update.mjs <设备IP> [--rebuild]
 *   <设备IP>    目标设备局域网 IP（如投影仪 192.168.88.125）
 *   --rebuild   先构建 android 前端（vite build）再推送（推荐在改完代码后使用）
 *
 * 原理：读取 android/app/src/main/assets/nodejs-project/dist/ 下所有文件，
 * 打包 base64 POST 到设备调试服务 :3002/update → 设备替换文件 → 广播 reload → 前端自动刷新。
 * 无需重装 APK、无需 adb。要求设备开发者模式开启（当前默认开启）。
 */
import { readdirSync, readFileSync, statSync } from 'fs'
import { join, relative, dirname } from 'path'
import { fileURLToPath } from 'url'
import { execSync } from 'child_process'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const DIST = join(ROOT, 'android', 'app', 'src', 'main', 'assets', 'nodejs-project', 'dist')

const ipArg = process.argv[2]
if (!ipArg) {
  console.error('用法: node scripts/push-hot-update.mjs <设备IP[:端口]> [--rebuild]')
  process.exit(1)
}
// 支持 "IP:端口"（模拟器 adb forward 场景：node scripts/push-hot-update.mjs 127.0.0.1:13002）
const [host, port] = ipArg.split(':')
const targetPort = port || 3002

if (process.argv.includes('--rebuild')) {
  console.log('▶ 构建 android 前端...')
  execSync('npx vite build --config vite.android.config.ts', { stdio: 'inherit', cwd: ROOT })
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
console.log(`▶ 推送 ${files.length} 个文件到 ${host}:${targetPort}/update ...`)
try {
  const res = await fetch(`http://${host}:${targetPort}/update`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ files }),
  })
  const data = await res.json()
  if (data.ok) {
    console.log(`✅ 已推送 ${data.count} 个文件，设备页面即将自动刷新`)
  } else {
    console.error(`❌ 推送失败: ${data.error || '未知错误'}`)
    process.exit(1)
  }
} catch (err) {
  console.error(`❌ 无法连接 ${host}:${targetPort} —— 请确认设备开发者模式已开启且与电脑同一局域网`)
  console.error(`   ${err.message}`)
  process.exit(1)
}

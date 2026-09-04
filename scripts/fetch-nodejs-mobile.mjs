/**
 * 拉取 nodejs-mobile v18 安卓发布包并解压到 android/app/libnode/（git 忽略，不入库）。
 * 用法：node scripts/fetch-nodejs-mobile.mjs
 */
import { createWriteStream, existsSync, mkdirSync, rmSync, statSync, cpSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { execSync } from 'child_process'

const VERSION = 'v18.20.4'
const ASSET = `nodejs-mobile-${VERSION}-android.zip`
const DOWNLOAD_URL = `https://github.com/nodejs-mobile/nodejs-mobile/releases/download/${VERSION}/${ASSET}`

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const LIB_NODE = join(ROOT, 'android', 'app', 'libnode')
const ZIP_TMP = join(ROOT, 'node_modules', '.cache', ASSET)
const EXTRACT_TMP = join(LIB_NODE, '.extract-tmp')

async function download(url, dest, expectedBytes) {
  const response = await fetch(url, { redirect: 'follow' })
  if (!response.ok || !response.body) throw new Error(`下载失败 HTTP ${response.status}`)
  const total = Number(response.headers.get('content-length')) || expectedBytes
  let received = 0
  const reader = response.body.getReader()
  const ws = createWriteStream(dest)
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    received += value.byteLength
    process.stdout.write(`\r  ${(received / 1024 / 1024).toFixed(1)} / ${(total / 1024 / 1024).toFixed(1)} MB`)
    if (!ws.write(Buffer.from(value))) {
      await new Promise((resolve) => ws.once('drain', resolve))
    }
  }
  await new Promise((resolve, reject) => ws.end((err) => (err ? reject(err) : resolve())))
  process.stdout.write('\n')
}

async function ensureDownloaded() {
  mkdirSync(dirname(ZIP_TMP), { recursive: true })
  if (existsSync(ZIP_TMP) && statSync(ZIP_TMP).size > 10 * 1024 * 1024) {
    console.log(`已存在缓存: ${ZIP_TMP}`)
    return
  }
  console.log(`下载 ${DOWNLOAD_URL} ...`)
  await download(DOWNLOAD_URL, ZIP_TMP)
}

function extractLibnode() {
  console.log('解压 libnode.so 与头文件 → android/app/libnode/ ...')
  rmSync(LIB_NODE, { recursive: true, force: true })
  mkdirSync(LIB_NODE, { recursive: true })
  // adm-zip 无法解析 nodejs-mobile 官方 zip（Invalid filename），改用系统解压工具：
  // Windows 用 PowerShell Expand-Archive，Linux/macOS（含 GitHub Actions ubuntu）用 unzip
  if (process.platform === 'win32') {
    execSync(`powershell -NoProfile -Command "Expand-Archive -Force -Path '${ZIP_TMP}' -DestinationPath '${EXTRACT_TMP}'"`, { stdio: 'inherit' })
  } else {
    execSync(`unzip -o "${ZIP_TMP}" -d "${EXTRACT_TMP}"`, { stdio: 'inherit' })
  }
  // 只要 bin/<abi>/libnode.so 与 include/node 头文件
  cpSync(join(EXTRACT_TMP, 'bin'), join(LIB_NODE, 'bin'), { recursive: true })
  cpSync(join(EXTRACT_TMP, 'include'), join(LIB_NODE, 'include'), { recursive: true })
  rmSync(EXTRACT_TMP, { recursive: true, force: true })
  console.log('完成。libnode 已就位：')
  for (const abi of ['arm64-v8a', 'armeabi-v7a', 'x86_64']) {
    const p = join(LIB_NODE, 'bin', abi, 'libnode.so')
    console.log(`  - ${p}${existsSync(p) ? '' : '（缺失!）'}`)
  }
}

await ensureDownloaded()
extractLibnode()

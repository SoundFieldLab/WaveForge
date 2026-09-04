/**
 * 生成 Windows 热更新包：把 win-unpacked 里 resources 下的 app.asar 与 app.asar.unpacked
 * 打包为 waveforge-hot-<version>.zip（客户端下载后替换这两个文件即可完成代码热更新，
 * 无需重装）。app.asar 涵盖全部代码（前端 dist / desktop / server）；app.asar.unpacked
 * 涵盖 worker 与服务的 .py 解包文件。
 *
 * 用法：node scripts/build-hot-update.mjs [--unpacked <win-unpacked 目录>] [--out <输出目录>]
 *   默认 unpacked = release/win-unpacked，输出 = release/。
 *   构建产物前需先执行 npm run build:electron:dir。
 *
 * 发布：node scripts/publish-release.mjs --exe release/WaveForge-<v>-Setup.exe \
 *       --hot release/waveforge-hot-<v>.zip --notes "更新内容"
 */
import AdmZip from 'adm-zip'
import { existsSync, mkdirSync, readFileSync, statSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const args = process.argv.slice(2)
const argOf = (flag) => args[args.indexOf(flag) + 1]
const unpackedDir = argOf('--unpacked') || join(ROOT, 'release', 'win-unpacked')
const outDir = argOf('--out') || join(ROOT, 'release')

const asarPath = join(unpackedDir, 'resources', 'app.asar')
const unpackedPath = join(unpackedDir, 'resources', 'app.asar.unpacked')
if (!existsSync(asarPath)) {
  console.error(`未找到 ${asarPath}\n请先构建：npm run build:electron:dir（或指定 --unpacked）`)
  process.exit(1)
}

const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version || '0.0.0'
const out = join(outDir, `waveforge-hot-${version}.zip`)
mkdirSync(outDir, { recursive: true })

const zip = new AdmZip()
zip.addLocalFile(asarPath, '', 'app.asar')
if (existsSync(unpackedPath)) zip.addLocalFolder(unpackedPath, 'app.asar.unpacked')
zip.writeZip(out)

console.log(`✅ 热更新包已生成：${out}（${(statSync(out).size / 1024 / 1024).toFixed(1)} MB）`)
console.log(`   发布时加 --hot ${out}`)

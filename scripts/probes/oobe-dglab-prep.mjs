/**
 * DG-LAB OOBE 素材准备探针（一次性，可重复运行）
 *
 * 作用：
 *   1. 从手机截图量出每个「动画框出」目标在图片内的像素矩形（用于 OOBE 的 SVG 高亮层）
 *   2. 把 7 张原图转成 WebP 落到 src/assets/oobe-dglab/
 *   3. 输出一张带框的拼版图（.tmp-m/verify.png）用于人工核对框位置
 *
 * 用法：
 *   OOBE_SRC="C:/Users/Yoshino/Desktop/oobe图片" node scripts/probes/oobe-dglab-prep.mjs
 *
 * 说明：所有截图统一为 1206×2622，因此像素坐标可直接写进组件。
 */
import sharp from 'sharp'
import fs from 'node:fs'
import path from 'node:path'

const SRC = process.env.OOBE_SRC || 'C:/Users/Yoshino/Desktop/oobe图片'
const OUT_DIR = path.resolve('src/assets/oobe-dglab')
const TMP_DIR = 'D:/opencode/.tmp-m'
const W = 1206
const H = 2622

/** 高亮目标：窗口用于限定搜索范围（避免相邻元素污染包围盒），thresh 为灰度阈值 */
const TARGETS = [
  { key: 'socketBtn', img: '1.PNG', win: { x: 895, y: 2230, w: 311, h: 340 }, thresh: 14, note: 'SOCKET 控制 底部入口卡片' },
  { key: 'connDialog', img: '2.PNG', win: { x: 90, y: 950, w: 1030, h: 640 }, thresh: 150, note: '蓝牙连接中 弹窗' },
  { key: 'gear', img: '3.PNG', win: { x: 980, y: 150, w: 226, h: 210 }, thresh: 80, note: '右上角齿轮设置' },
  { key: 'outputSettings', img: '附加.PNG', win: { x: 770, y: 955, w: 436, h: 390 }, thresh: 150, note: '设置网格里的「输出设置」卡片' },
  { key: 'connectServerBtn', img: '4.PNG', win: { x: 150, y: 885, w: 925, h: 170 }, thresh: 120, note: '「连接服务器」按钮' },
  { key: 'cameraIcon', img: '5.PNG', win: { x: 470, y: 1410, w: 260, h: 220 }, thresh: 120, note: '远程控制弹窗里的相机（扫码）图标' },
  { key: 'successToast', img: '6.PNG', win: { x: 380, y: 2190, w: 440, h: 200 }, thresh: 200, note: '「服务器连接成功」提示条' },
]

/** 落库素材：语义化命名，避免 1.PNG/附加.PNG 这种顺序耦合的名字 */
const ASSETS = [
  { from: '1.PNG', to: 'app-home.webp' },
  { from: '2.PNG', to: 'app-connecting.webp' },
  { from: '3.PNG', to: 'app-socket-page.webp' },
  { from: '4.PNG', to: 'app-socket-config.webp' },
  { from: '5.PNG', to: 'app-remote-scan.webp' },
  { from: '6.PNG', to: 'app-connected.webp' },
  { from: '附加.PNG', to: 'app-settings-grid.webp' },
]

async function gray(file) {
  const { data } = await sharp(path.join(SRC, file)).grayscale().raw().toBuffer({ resolveWithObject: true })
  return data
}

function bbox(g, win, thresh) {
  let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1
  for (let y = win.y; y < win.y + win.h; y++) {
    for (let x = win.x; x < win.x + win.w; x++) {
      if (g[y * W + x] > thresh) {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }
  if (maxX < 0) return null
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 }
}

function svgOverlay(rects) {
  const body = rects.map(r =>
    `<rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" fill="none" stroke="#ff2d55" stroke-width="10"/>`
  ).join('')
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${body}</svg>`)
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true })
  fs.mkdirSync(TMP_DIR, { recursive: true })

  /* ---- 1. 量框 ---- */
  const cache = new Map()
  const measured = {}
  for (const t of TARGETS) {
    if (!cache.has(t.img)) cache.set(t.img, await gray(t.img))
    const r = bbox(cache.get(t.img), t.win, t.thresh)
    measured[t.key] = r
    console.log(r
      ? `${t.key.padEnd(18)} ${String(r.x).padStart(4)},${String(r.y).padStart(4)}  ${r.w}x${r.h}   (${t.note})`
      : `${t.key.padEnd(18)} 未命中（阈值/窗口需调整）  (${t.note})`)
  }
  // 归一化（组件里用 viewBox=图片像素，故像素值即可；归一化值供别处复用）
  const normalized = {}
  for (const [k, r] of Object.entries(measured)) {
    if (!r) continue
    normalized[k] = {
      x: +(r.x / W).toFixed(4), y: +(r.y / H).toFixed(4),
      w: +(r.w / W).toFixed(4), h: +(r.h / H).toFixed(4),
    }
  }
  fs.writeFileSync(path.join(TMP_DIR, 'rects.json'), JSON.stringify({ px: measured, norm: normalized }, null, 2))
  console.log('\n像素矩形:\n' + JSON.stringify(measured, null, 2))

  /* ---- 2. 出 WebP ---- */
  console.log('\n素材:')
  for (const a of ASSETS) {
    const dst = path.join(OUT_DIR, a.to)
    await sharp(path.join(SRC, a.from)).webp({ quality: 84, effort: 5 }).toFile(dst)
    const kb = (fs.statSync(dst).size / 1024).toFixed(1)
    console.log(`  ${a.from.padEnd(12)} -> ${a.to.padEnd(26)} ${kb} KB`)
  }

  /* ---- 3. 核对拼版 ---- */
  const byImg = {}
  for (const t of TARGETS) {
    if (!measured[t.key]) continue
    ;(byImg[t.img] ||= []).push(measured[t.key])
  }
  const order = ['1.PNG', '2.PNG', '3.PNG', '4.PNG', '附加.PNG', '5.PNG', '6.PNG']
  const tw = 300
  const th = 652
  const k = tw / W
  const overlay = (rects) => Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${tw}" height="${th}">` +
    rects.map(r => `<rect x="${r.x * k}" y="${r.y * k}" width="${r.w * k}" height="${r.h * k}" fill="none" stroke="#ff2d55" stroke-width="3"/>`).join('') +
    `</svg>`,
  )
  const tiles = []
  for (const img of order) {
    const rects = byImg[img] || []
    let pipe = sharp(path.join(SRC, img)).resize({ width: tw, height: th, fit: 'fill' })
    if (rects.length) pipe = pipe.composite([{ input: overlay(rects), top: 0, left: 0 }])
    tiles.push(await pipe.png().toBuffer())
  }
  const cols = 4
  const rows = Math.ceil(tiles.length / cols)
  await sharp({
    create: { width: tw * cols, height: th * rows, channels: 3, background: '#101014' },
  }).composite(tiles.map((input, i) => ({
    input, left: (i % cols) * tw, top: Math.floor(i / cols) * th,
  }))).png().toFile(path.join(TMP_DIR, 'verify.png'))
  console.log('\n核对拼版: ' + path.join(TMP_DIR, 'verify.png'))
}

main().catch((e) => { console.error(e); process.exit(1) })

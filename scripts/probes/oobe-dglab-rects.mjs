/**
 * DG-LAB OOBE 高亮框：一次量全 + 出一张带框的核对图。
 * 用法：node scripts/probes/oobe-dglab-rects.mjs
 */
import sharp from 'sharp'
import fs from 'node:fs'
import path from 'node:path'

const SRC = process.env.OOBE_SRC || 'C:/Users/Yoshino/Desktop/oobe图片'
const TMP = 'D:/opencode/.tmp-m'
const W = 1206
const H = 2622

/** 最终矩形（像素，基于 1206×2622）。pad 为在量到的包围盒外扩的像素。 */
const TARGETS = [
  { key: 'socketEntry', img: '1.PNG', win: [900, 2240, 290, 300], thresh: 24, pad: 0, note: 'SOCKET 控制 入口卡片（底部四宫格最右）' },
  { key: 'connectingDialog', img: '2.PNG', win: [100, 1010, 1010, 600], thresh: 170, pad: 0, note: '蓝牙连接中 弹窗' },
  { key: 'settingsEntry', img: '3.PNG', win: [1040, 160, 140, 150], thresh: 60, pad: 14, note: 'SOCKET 控制页 右上角功能菜单（四宫格）' },
  { key: 'outputSettings', img: '附加.PNG', win: [770, 955, 436, 390], thresh: 150, pad: 0, note: '功能菜单里的「输出设置」卡片' },
  { key: 'capSliders', img: '4.PNG', win: [100, 1130, 1010, 830], thresh: 150, pad: 0, note: 'A/B 通道强度上限 + 增加速率 区块' },
  { key: 'connectServerBtn', img: '4.PNG', win: [150, 885, 925, 170], thresh: 120, pad: 0, note: '「连接服务器」按钮' },
  { key: 'scanCamera', img: '5.PNG', win: [500, 1330, 220, 200], thresh: 150, pad: 14, note: '远程控制弹窗里的相机（扫码）图标' },
  { key: 'successToast', img: '6.PNG', win: [380, 2190, 440, 200], thresh: 200, pad: 0, note: '「服务器连接成功」提示条' },
]

const grays = new Map()
async function gray(img) {
  if (!grays.has(img)) {
    const { data } = await sharp(path.join(SRC, img)).grayscale().raw().toBuffer({ resolveWithObject: true })
    grays.set(img, data)
  }
  return grays.get(img)
}

async function bbox(t) {
  const g = await gray(t.img)
  const [wx, wy, ww, wh] = t.win
  let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1
  for (let y = wy; y < wy + wh; y++) {
    for (let x = wx; x < wx + ww; x++) {
      if (g[y * W + x] > t.thresh) {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }
  if (maxX < 0) return null
  const p = t.pad || 0
  return {
    x: Math.max(0, minX - p), y: Math.max(0, minY - p),
    w: Math.min(W, maxX + p) - Math.max(0, minX - p) + 1,
    h: Math.min(H, maxY + p) - Math.max(0, minY - p) + 1,
  }
}

const out = {}
for (const t of TARGETS) {
  out[t.key] = await bbox(t)
  const r = out[t.key]
  console.log(`${t.key.padEnd(18)} ${r ? `${String(r.x).padStart(4)},${String(r.y).padStart(4)} ${String(r.w).padStart(4)}x${String(r.h).padStart(4)}` : 'MISS'}   ${t.note}`)
}
fs.mkdirSync(TMP, { recursive: true })
fs.writeFileSync(path.join(TMP, 'rects.json'), JSON.stringify(out, null, 2))

/* 核对图：每张源图上叠它自己的框 */
const tw = 420, th = Math.round(H * tw / W), k = tw / W
const order = ['1.PNG', '2.PNG', '3.PNG', '附加.PNG', '4.PNG', '5.PNG', '6.PNG']
const tiles = []
for (const img of order) {
  const rects = TARGETS.filter(t => t.img === img && out[t.key]).map(t => ({ ...out[t.key], c: t.key === 'connectServerBtn' ? '#22d3ee' : t.key === 'capSliders' ? '#fb923c' : '#ff2d55' }))
  const svg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${tw}" height="${th}">` +
    rects.map(r => `<rect x="${r.x * k}" y="${r.y * k}" width="${r.w * k}" height="${r.h * k}" rx="6" fill="none" stroke="${r.c}" stroke-width="4"/>`).join('') +
    `</svg>`,
  )
  let pipe = sharp(path.join(SRC, img)).resize({ width: tw, height: th, fit: 'fill' })
  if (rects.length) pipe = pipe.composite([{ input: svg, top: 0, left: 0 }])
  tiles.push(await pipe.png().toBuffer())
}
await sharp({ create: { width: tw * 4, height: th * 2, channels: 3, background: '#0b0b0e' } })
  .composite(tiles.map((input, i) => ({ input, left: (i % 4) * tw, top: Math.floor(i / 4) * th })))
  .png().toFile(path.join(TMP, 'rects-verify.png'))
console.log('\n核对图: ' + path.join(TMP, 'rects-verify.png'))

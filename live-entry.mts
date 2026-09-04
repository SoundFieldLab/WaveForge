import fs from 'fs'
const T = 'C:/Users/Yoshino/AppData/Roaming/Electron/cache/temp/'
const raw = JSON.parse(fs.readFileSync(T + 'miya_mv_decode.json', 'utf8'))
const ob = Buffer.from(raw.onsetB64, 'base64'), rb = Buffer.from(raw.rmsB64, 'base64')
const onset = Array.from(new Float32Array(ob.buffer, ob.byteOffset, raw.onsetLen))
const rms = Array.from(new Float32Array(rb.buffer, rb.byteOffset, raw.onsetLen))
const fr = raw.frameRate
// onset 密度：每秒窗口内 onset 值超阈值(中位数×3)的帧数
const thr = [...onset].sort((a, b) => a - b)[Math.floor(onset.length * 0.5)] * 3
console.log('onset 阈值:', thr.toFixed(4))
for (const [a, b] of [[0, 10], [10, 20], [20, 22], [22, 24], [24, 26], [26, 30], [30, 35], [35, 40], [40, 50], [50, 60]]) {
  const s = Math.round(a * fr), e = Math.min(onset.length, Math.round(b * fr))
  let count = 0
  for (let i = s; i < e; i++) if (onset[i] > thr) count++
  const secs = b - a
  console.log(`  [${a}-${b}s] onset 密度: ${(count / secs).toFixed(1)}/s  RMS均值: ${(rms.slice(s, e).reduce((x, y) => x + y, 0) / (e - s)).toFixed(3)}`)
}

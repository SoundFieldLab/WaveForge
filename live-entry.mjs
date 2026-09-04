// live-entry.mts
import fs from "fs";
var T = "C:/Users/Yoshino/AppData/Roaming/Electron/cache/temp/";
var raw = JSON.parse(fs.readFileSync(T + "miya_mv_decode.json", "utf8"));
var ob = Buffer.from(raw.onsetB64, "base64");
var rb = Buffer.from(raw.rmsB64, "base64");
var onset = Array.from(new Float32Array(ob.buffer, ob.byteOffset, raw.onsetLen));
var rms = Array.from(new Float32Array(rb.buffer, rb.byteOffset, raw.onsetLen));
var fr = raw.frameRate;
var thr = [...onset].sort((a, b) => a - b)[Math.floor(onset.length * 0.5)] * 3;
console.log("onset \u9608\u503C:", thr.toFixed(4));
for (const [a, b] of [[0, 10], [10, 20], [20, 22], [22, 24], [24, 26], [26, 30], [30, 35], [35, 40], [40, 50], [50, 60]]) {
  const s = Math.round(a * fr), e = Math.min(onset.length, Math.round(b * fr));
  let count = 0;
  for (let i = s; i < e; i++) if (onset[i] > thr) count++;
  const secs = b - a;
  console.log(`  [${a}-${b}s] onset \u5BC6\u5EA6: ${(count / secs).toFixed(1)}/s  RMS\u5747\u503C: ${(rms.slice(s, e).reduce((x, y) => x + y, 0) / (e - s)).toFixed(3)}`);
}

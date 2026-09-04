// 给 @lox-audioserver/node-airplay-sender 打补丁：
// 1) chacha：Electron 的 OpenSSL 构建缺少 chacha20-poly1305（createCipheriv 报
//    "Unknown cipher"），导致 AirPlay 2 配对加密崩溃（卡在连接中）。注入
//    @noble/ciphers 纯 JS fallback。
// 2) latency：AirPlay 2 SETUP 里设备侧延迟上界 latencyMax 默认 88200 帧（2s），
//    音箱会据此缓冲 2s+；下调到 22050（0.5s）/下限 11025→4410（0.1s），
//    配合 auto 优先 airplay2 把投送延迟从 3-4s 压到约 1s。
// 幂等：各补丁独立标记，已打过则跳过。用法：node scripts/patch-airplay-chacha.cjs
'use strict'
const fs = require('fs')
const path = require('path')

const pkgDir = path.join(__dirname, '..', 'node_modules', '@lox-audioserver', 'node-airplay-sender')

// ---------- 补丁 1：chacha20-poly1305 fallback ----------

function patchChacha() {
  const target = path.join(pkgDir, 'dist', 'homekit', 'encryption.js')
  const MARK = 'PATCHED_BY_WAVEFORGE'
  if (!fs.existsSync(target)) {
    console.log('[patch-airplay] 未找到 encryption.js，chacha 补丁跳过（依赖未安装？）')
    return
  }
  let src = fs.readFileSync(target, 'utf8')
  if (src.includes(MARK)) {
    console.log('[patch-airplay] chacha 补丁已打过，跳过')
    return
  }
  const injectRequire = `const crypto_1 = __importDefault(require("crypto"));
// PATCHED_BY_WAVEFORGE: Electron OpenSSL 缺少 chacha20-poly1305，纯 JS fallback
let noble_chacha20poly1305 = null;
try { noble_chacha20poly1305 = require('@noble/ciphers/chacha').chacha20poly1305; } catch (e) { /* 未安装则保持 null */ }
`
  if (!src.includes('const crypto_1 = __importDefault(require("crypto"));')) {
    console.error('[patch-airplay] 找不到 crypto import 锚点，chacha 补丁中止')
    process.exitCode = 1
    return
  }
  src = src.replace('const crypto_1 = __importDefault(require("crypto"));', injectRequire)

  const oldVerify = src.match(/function verifyAndDecrypt[\s\S]*?\n}/)
  if (!oldVerify) {
    console.error('[patch-airplay] 找不到 verifyAndDecrypt，chacha 补丁中止')
    process.exitCode = 1
    return
  }
  const newVerify = `function verifyAndDecrypt(cipherText, mac, AAD, nonce, key) {
    let nonceBuf = nonce;
    if (nonceBuf.byteLength === 8) {
        nonceBuf = Buffer.concat([Buffer.from([0x00, 0x00, 0x00, 0x00]), nonceBuf]);
    }
    try {
        const decipher = crypto_1.default.createDecipheriv('chacha20-poly1305', key, nonceBuf, { authTagLength: 16 });
        if (AAD != null) {
            decipher.setAAD(AAD); // must be called before data
        }
        decipher.setAuthTag(mac);
        const decrypted = Buffer.concat([decipher.update(cipherText), decipher.final()]);
        return decrypted;
    }
    catch (error) {
        // PATCHED_BY_WAVEFORGE: Electron 无 chacha20-poly1305 → 纯 JS fallback
        try {
            if (!noble_chacha20poly1305) return null;
            const aead = noble_chacha20poly1305(
                new Uint8Array(key),
                new Uint8Array(nonceBuf),
                AAD != null ? new Uint8Array(AAD) : undefined,
            );
            const sealed = Buffer.concat([cipherText, mac]);
            return Buffer.from(aead.decrypt(new Uint8Array(sealed)));
        } catch { return null; }
    }
}`
  src = src.replace(oldVerify[0], newVerify)

  const oldSeal = src.match(/function encryptAndSeal[\s\S]*?\n}/)
  if (!oldSeal) {
    console.error('[patch-airplay] 找不到 encryptAndSeal，chacha 补丁中止')
    process.exitCode = 1
    return
  }
  const newSeal = `function encryptAndSeal(plainText, AAD, nonce, key) {
    let nonceBuf = nonce;
    if (nonceBuf.byteLength === 8) {
        nonceBuf = Buffer.concat([Buffer.from([0x00, 0x00, 0x00, 0x00]), nonceBuf]);
    }
    // PATCHED_BY_WAVEFORGE: Electron OpenSSL 无 chacha20-poly1305，失败时用 @noble/ciphers 纯 JS fallback
    try {
        const cipher = crypto_1.default.createCipheriv('chacha20-poly1305', key, nonceBuf, { authTagLength: 16 });
        if (AAD != null) {
            cipher.setAAD(AAD); // must be called before data
        }
        const cipherText = Buffer.concat([cipher.update(plainText), cipher.final()]);
        const hmac = cipher.getAuthTag();
        return [cipherText, hmac];
    } catch (error) {
        if (!noble_chacha20poly1305) throw error;
        const aead = noble_chacha20poly1305(
            new Uint8Array(key),
            new Uint8Array(nonceBuf),
            AAD != null ? new Uint8Array(AAD) : undefined,
        );
        const sealed = aead.encrypt(new Uint8Array(plainText));
        return [Buffer.from(sealed.slice(0, sealed.length - 16)), Buffer.from(sealed.slice(sealed.length - 16))];
    }
}`
  src = src.replace(oldSeal[0], newSeal)

  fs.writeFileSync(target, src, 'utf8')
  console.log('[patch-airplay] chacha 补丁已应用（chacha20-poly1305 纯 JS fallback）')
}

// ---------- 补丁 2：AirPlay 2 SETUP 延迟上界下调 ----------

function patchLatency() {
  const MARK = 'PATCHED_BY_WAVEFORGE_LATENCY'
  // 主进程用的是 CJS（dist/core/rtsp.js），ESM 一并打上保持一致
  const targets = [
    path.join(pkgDir, 'dist', 'core', 'rtsp.js'),
    path.join(pkgDir, 'dist', 'esm', 'core', 'rtsp.js'),
  ]
  let patchedAny = false
  for (const target of targets) {
    if (!fs.existsSync(target)) continue
    let src = fs.readFileSync(target, 'utf8')
    if (src.includes(MARK)) {
      console.log(`[patch-airplay] latency 补丁已打过（${path.basename(path.dirname(target))}），跳过`)
      continue
    }
    // 设备侧缓冲上界：88200 帧（2s）→ 22050（0.5s）；下界 11025（0.25s）→ 4410（0.1s）
    const before = src
    src = src.replace(/latencyMax:\s*88200,/g, `latencyMax: 22050, // PATCHED_BY_WAVEFORGE_LATENCY: 2s→0.5s`)
    src = src.replace(/latencyMin:\s*11025,/g, `latencyMin: 4410,`)
    // 注：SETUP_AP2_2 的 audioLatency fallback 保持原值 50（≈1ms）——曾改为 88200 做 2s
    // 预缓冲补偿，但实测 Xiaomi Sound 为「积累播放」型设备（忽略 RTP 时间戳），补偿无效
    // 且带来连接/切歌先送 2s 静音的副作用，故回退。设备不响应 Audio-Latency 时延迟由
    // 设备自身缓冲决定，发送端无法消除。
    if (src === before) {
      console.warn(`[patch-airplay] ${target} 未找到 latencyMax/latencyMin 锚点`)
      continue
    }
    fs.writeFileSync(target, src, 'utf8')
    patchedAny = true
    console.log(`[patch-airplay] latency 补丁已应用（${path.basename(path.dirname(target))}，设备缓冲 2s→0.5s）`)
  }
  if (!patchedAny) {
    const anyTargetExists = targets.some((t) => fs.existsSync(t))
    if (!anyTargetExists) console.log('[patch-airplay] 未找到 rtsp.js，latency 补丁跳过（依赖未安装？）')
  }
}

patchChacha()
patchLatency()
if (process.exitCode) {
  console.error('[patch-airplay] 存在未应用的补丁项，请检查上方日志')
} else {
  console.log('[patch-airplay] 全部补丁处理完成')
}

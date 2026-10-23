// desktop/spotifyAudio.cjs
// Spotify 直接播放通道（folia 同款架构，librespot N-API 绑定）。
//
// 链路：渲染层 <audio> 请求 waveforge-spotify://audio/<trackId>?k=<key>&bitrate=<n>
// → protocol.handle 读 Range → 用会话 resolveAudioFileAsync 拿 CDN 地址 + AES-128-CTR 密钥
// → 按 Range 从 CDN 取加密字节 → 在线解密流给播放器；解密后的字节不落盘。
//
// 设计约束：
// - 密钥只在内存（按 key 发放、按 key 校验），页面内容无法用任意 id 让应用取流；
// - 会话懒建：第一次播放才连 Spotify；账号登出/凭据失效时整体作废（generation 守卫）；
// - librespot 缺 prebuilt 的平台加载失败 → available=false，上层降级载体匹配（不影响其余功能）；
// - Premium 才有 CDN 音频：resolveAudioFileAsync 报 unavailable/not-playable 时按 folia
//   的错误语义透传（渲染层据此提示或降级）。

const crypto = require('node:crypto');

// Spotify 每个音频文件都用这个 IV 做 AES-128-CTR（行业公开事实，librespot 实现）。
const AUDIO_IV = Buffer.from('72e067fbddcbcf77ebe8bc643f630d93', 'hex');
// Spotify 在 Ogg 流前面放一页自己的数据（0xa7 字节），播放器不读它。
const OGG_LEAD_BYTES = 0xa7;
const TRACK_ID_RE = /^[0-9A-Za-z]{22}$/;
const MAX_ISSUED_KEYS = 512;
const MAX_TRACK_BYTES = 256 * 1024 * 1024;
// CDN 地址是限时签名：超时或被拒就重新 resolve。
const FILE_TTL_MS = 10 * 60 * 1000;
const QUIET_LIMIT_MS = 30 * 1000;
const REFUSED_STATUSES = new Set([401, 403, 404, 410]);
const BITRATE_BY_QUALITY = { standard: 96, high: 160, 'very-high': 320, lossless: 320, 'hi-res': 320 };

// offset 所在 16 字节块的 CTR counter（AES-CTR 可以从任意块起点解）。
function counterAt(offset) {
  const counter = Buffer.from(AUDIO_IV);
  let carry = Math.floor(offset / 16);
  for (let index = 15; index >= 0 && carry > 0; index -= 1) {
    const sum = counter[index] + (carry % 256);
    counter[index] = sum % 256;
    carry = Math.floor(carry / 256) + Math.floor(sum / 256);
  }
  return counter;
}

function decipherAt(key, offset) {
  const decipher = crypto.createDecipheriv('aes-128-ctr', key, counterAt(offset));
  decipher.update(Buffer.alloc(offset % 16));
  return decipher;
}

const shapeOf = (format) => (/^OGG_VORBIS/.test(format)
  ? { mimeType: 'audio/ogg', skip: OGG_LEAD_BYTES }
  : /^MP3/.test(format)
    ? { mimeType: 'audio/mpeg', skip: 0 }
    : null);

function loadLibrespot() {
  try {
    // electron-builder 会把 optionalDependencies 打进包；加载失败（无 prebuilt）返回 null
    return require('@lox-audioserver/node-librespot');
  } catch {
    return null;
  }
}

/**
 * 创建 Spotify 音频通道。
 * getAccessToken(): Promise<string> —— OAuth access token（主进程 spotify 登录态提供）；
 * log/warn: 主进程日志；now/fetchLib 可注入测试。
 */
function createSpotifyAudio({ getAccessToken, deviceName = 'WaveForge', log = console.log, warn = console.warn, now = Date.now, fetchLib = globalThis.fetch } = {}) {
  const librespot = loadLibrespot();
  if (!librespot) {
    warn('[SpotifyAudio] node-librespot 不可用（本平台无预编译二进制），Spotify 直播降级为载体匹配');
  }

  let held = null; // { session, closed }
  let opening = null;
  let generation = 0; // 登出/凭据失效 +1：旧会话与旧 key 全部作废
  // key -> { trackId, bitrate, mimeType, total, skip, file }
  const keys = new Map();
  // `${trackId}:${bitrate}` -> { cdnUrl, key, format, mimeType, skip, total, length, locatedAt }
  const files = new Map();
  const pending = new Map();

  const within = (promise, what) => {
    let limit;
    return Promise.race([
      promise,
      new Promise((_resolve, reject) => {
        limit = setTimeout(() => reject(new Error(`Spotify did not answer: ${what} exceeded ${QUIET_LIMIT_MS}ms`)), QUIET_LIMIT_MS);
      }),
    ]).finally(() => clearTimeout(limit));
  };

  const closeQuietly = (session) => {
    try { Promise.resolve(session?.close?.()).catch(() => {}); } catch { /* 已关 */ }
  };

  const connect = async () => {
    if (!librespot) throw new Error('Spotify 播放组件在当前系统不可用');
    if (held) return held.session;
    if (!opening) {
      const startedGeneration = generation;
      opening = (async () => {
        const accessToken = await getAccessToken();
        if (!accessToken) throw new Error('Spotify 未登录或凭据已失效');
        const session = await within(
          librespot.createSession({ accessToken, deviceName }),
          'connecting',
        );
        if (startedGeneration !== generation) {
          closeQuietly(session);
          throw new Error('Spotify 会话已变更');
        }
        log('[SpotifyAudio] 会话已连接');
        return session;
      })().finally(() => { opening = null; })
        .then((session) => { held = { session, closed: false }; return session; });
    }
    return opening;
  };

  // 会话上的 resolve 失败一次后换新连接重试（Spotify 可能已静默关掉旧连接）。
  const locate = async (trackId, bitrate) => {
    for (;;) {
      const kept = held;
      const session = await connect();
      try {
        return await within(
          session.resolveAudioFileAsync({ uri: `spotify:track:${trackId}`, bitrate }),
          'locating the file',
        );
      } catch (error) {
        const said = String(error?.message ?? error);
        if (/unavailable|no audio files|track is unavailable/i.test(said)) {
          throw new Error(`SPOTIFY_TRACK_UNPLAYABLE: ${said.slice(0, 160)}`);
        }
        if (kept && held === kept && held?.session === session) {
          // 旧连接上的偶发失败：关掉重连一次
          warn(`[SpotifyAudio] 旧连接定位失败，重连重试: ${said.slice(0, 120)}`);
          if (held) { held.closed = true; closeQuietly(held.session); held = null; }
          continue;
        }
        throw error;
      }
    }
  };

  const prepare = async (trackId, bitrate, anew = false) => {
    const name = `${trackId}:${bitrate}`;
    const kept = files.get(name);
    if (kept && !anew && now() - kept.locatedAt < FILE_TTL_MS) return kept;
    let job = pending.get(name);
    if (!job) {
      const startedGeneration = generation;
      job = (async () => {
        const located = await locate(trackId, bitrate);
        const shape = shapeOf(String(located?.format ?? ''));
        if (!shape || !/^[0-9a-f]{32}$/i.test(String(located?.keyHex ?? '')) || typeof located.cdnUrl !== 'string') {
          throw new Error(`SPOTIFY_TRACK_UNPLAYABLE: unusable format ${located?.format ?? 'unknown'}`);
        }
        const key = Buffer.from(located.keyHex, 'hex');
        // 用前 4 字节验证密钥能否解出 OggS（免费号/失效凭据拿到的 key 解不开，早失败早降级）
        const head = await requestBytes(located.cdnUrl, 0, shape.skip + 3, key);
        if (startedGeneration !== generation) throw new Error('Spotify 会话已变更');
        const length = Number(/\/(\d+)$/.exec(head.contentRange ?? '')?.[1]);
        if (!Number.isSafeInteger(length) || length <= shape.skip || length > MAX_TRACK_BYTES) {
          throw new Error(`SPOTIFY_TRACK_UNPLAYABLE: bad length ${length}`);
        }
        const magic = decipherAt(key, shape.skip).update(head.bytes.subarray(0, 4)).toString('latin1');
        if (magic !== 'OggS') {
          throw new Error('SPOTIFY_TRACK_UNPLAYABLE: key does not open this file (free account?)');
        }
        const file = {
          cdnUrl: located.cdnUrl,
          key,
          format: located.format,
          mimeType: shape.mimeType,
          skip: shape.skip,
          total: length - shape.skip,
          length,
          locatedAt: now(),
        };
        files.delete(name);
        files.set(name, file);
        while (files.size > 32) files.delete(files.keys().next().value);
        log(`[SpotifyAudio] ${trackId} 已定位：${file.format}，${file.total} 字节（${Math.round(now() - job.startedAt)}ms）`);
        return file;
      })();
      job.startedAt = now();
      pending.set(name, job);
      job.finally(() => { if (pending.get(name) === job) pending.delete(name); }).catch(() => {});
    }
    return job;
  };

  // CDN Range 请求 → { bytes, contentRange }。密钥错误时上层用 magic 校验兜底。
  async function requestBytes(cdnUrl, from, to, _key) {
    const control = new AbortController();
    const limit = setTimeout(() => control.abort(), QUIET_LIMIT_MS);
    try {
      const response = await fetchLib(cdnUrl, {
        headers: { Range: `bytes=${from}-${to}` },
        signal: control.signal,
      });
      if (response.status !== 206) {
        control.abort();
        throw new Error(REFUSED_STATUSES.has(response.status)
          ? `SPOTIFY_CDN_REFUSED: HTTP ${response.status}`
          : `SPOTIFY_CDN_ERROR: HTTP ${response.status}`);
      }
      const contentRange = response.headers.get('content-range') ?? '';
      const bytes = Buffer.from(await response.arrayBuffer());
      return { bytes, contentRange };
    } finally {
      clearTimeout(limit);
    }
  }

  return {
    /** librespot 是否可用（决定平台能力位的降级方向） */
    available: () => Boolean(librespot),
    /** 用 OAuth token 建/换会话（登录成功后调用；登出时调 invalidate） */
    async prime() {
      if (!librespot) return false;
      try { await connect(); return true; } catch (error) {
        warn(`[SpotifyAudio] 预热失败: ${String(error?.message ?? error).slice(0, 160)}`);
        return false;
      }
    },
    /** 登出/凭据失效：会话、缓存、已发 key 全部作废 */
    invalidate() {
      generation += 1;
      keys.clear();
      files.clear();
      if (held) { held.closed = true; closeQuietly(held.session); held = null; }
    },
    /** 渲染层请求一个播放 URL 用的 key（校验 trackId，防任意取流） */
    async issue(trackId, quality = 'high') {
      if (!librespot) throw new Error('SPOTIFY_UNAVAILABLE');
      if (!TRACK_ID_RE.test(trackId)) throw new Error('SPOTIFY_BAD_TRACK_ID');
      const bitrate = BITRATE_BY_QUALITY[quality] ?? 160;
      const file = await prepare(trackId, bitrate).catch((error) => {
        // CDN 地址过期：重新 resolve 一次
        if (/SPOTIFY_CDN_REFUSED/.test(String(error?.message ?? ''))) {
          return prepare(trackId, bitrate, true);
        }
        throw error;
      });
      const key = crypto.randomBytes(16).toString('hex');
      keys.set(key, { trackId, bitrate, mimeType: file.mimeType, total: file.total, skip: file.skip });
      while (keys.size > MAX_ISSUED_KEYS) keys.delete(keys.keys().next().value);
      return { key, mimeType: file.mimeType, total: file.total };
    },
    /** 协议 handler：key 是否由本通道发出 */
    holds(key) { return keys.has(String(key ?? '')); },
    /** key 的元信息（mimeType/总长/前置 skip） */
    metaOf(key) {
      const entry = keys.get(String(key ?? ''));
      if (!entry) return null;
      return { trackId: entry.trackId, bitrate: entry.bitrate, mimeType: entry.mimeType, total: entry.total, skip: entry.skip };
    },
    /**
     * 打开 [from, to] 的解密字节流（Range；渲染层 <audio> 的标准取法）。
     * 返回 { stream, status, headers }；失败抛 Error（message 带 SPOTIFY_* 前缀）。
     */
    async openRange(key, from, to) {
      const entry = keys.get(String(key ?? ''));
      if (!entry) throw new Error('SPOTIFY_BAD_KEY');
      const file = await prepare(entry.trackId, entry.bitrate)
        .catch(() => prepare(entry.trackId, entry.bitrate, true));
      if (!file) throw new Error('SPOTIFY_LOCATE_FAILED');
      const safeFrom = Math.max(0, Math.floor(from) + entry.skip);
      const safeTo = Math.min(file.length - 1, to === null || to === undefined ? file.length - 1 : Math.floor(to));
      if (safeFrom > safeTo) {
        return {
          stream: null,
          status: 416,
          headers: { 'Content-Range': `bytes */${file.total}` },
        };
      }
      const control = new AbortController();
      const limit = setTimeout(() => control.abort(), QUIET_LIMIT_MS * 3);
      let response;
      try {
        response = await fetchLib(file.cdnUrl, {
          headers: { Range: `bytes=${safeFrom}-${safeTo}` },
          signal: control.signal,
        });
      } catch (error) {
        clearTimeout(limit);
        throw new Error(`SPOTIFY_CDN_ERROR: ${String(error?.message ?? error).slice(0, 160)}`);
      }
      if (response.status !== 206) {
        clearTimeout(limit);
        control.abort();
        throw new Error(REFUSED_STATUSES.has(response.status)
          ? `SPOTIFY_CDN_REFUSED: HTTP ${response.status}`
          : `SPOTIFY_CDN_ERROR: HTTP ${response.status}`);
      }
      const begins = Number(/^bytes (\d+)-/.exec(response.headers.get('content-range') ?? '')?.[1]);
      if (begins !== safeFrom) {
        clearTimeout(limit);
        control.abort();
        throw new Error('SPOTIFY_CDN_MISALIGNED');
      }
      const decipher = decipherAt(file.key, safeFrom);
      // 把 CDN 的加密流按块解密成 web stream（无需整曲入内存）
      const reader = response.body?.getReader?.();
      if (!reader) {
        clearTimeout(limit);
        throw new Error('SPOTIFY_CDN_NO_BODY');
      }
      const stream = new ReadableStream({
        async pull(controller) {
          try {
            const { done, value } = await reader.read();
            if (done) {
              clearTimeout(limit);
              controller.close();
              return;
            }
            controller.enqueue(Buffer.from(decipher.update(Buffer.from(value))));
          } catch (error) {
            clearTimeout(limit);
            controller.error(error);
          }
        },
        cancel() {
          clearTimeout(limit);
          control.abort();
          try { reader.releaseLock(); } catch { /* 已释放 */ }
        },
      });
      return {
        stream,
        status: 206,
        headers: {
          'Content-Type': entry.mimeType,
          'Content-Length': String(safeTo - safeFrom + 1),
          'Content-Range': `bytes ${safeFrom - entry.skip}-${safeTo - entry.skip}/${file.total}`,
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'no-store',
        },
      };
    },
  };
}

module.exports = { createSpotifyAudio, counterAt, decipherAt, shapeOf, BITRATE_BY_QUALITY };

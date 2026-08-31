import express from 'express'
import { fileURLToPath } from 'url'
import { dirname, join, extname, resolve, sep } from 'path'
import { readdir, stat, readFile } from 'fs/promises'
import { existsSync, createReadStream, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { Readable } from 'stream'
import dns from 'node:dns'
import os from 'node:os'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { Agent as HttpAgent } from 'http'
import { Agent as HttpsAgent } from 'https'
import compression from 'compression'
import qqMusicApi from 'qq-music-api'
import {
  resolveKugouSongUrl,
  fetchKugouUserPlaylists,
  fetchKugouPlaylistTracks,
  kugouLikeCheckHashes,
  kugouAddSongToList,
  fetchKugouLyric,
} from './server/kugou-gateway.mjs'
import { decodeAG1Response, encodeAG1Request, zzcSign } from '@jixun/qmweb-sign'
import axios from 'axios'
import { decryptQrc } from './server/qrc-decoder.mjs'
import { getCommentMutationMessage, isCommentMutationSuccessful } from './server/comment-api-utils.mjs'
import { registerHazardRoutes } from './server/hazard-api.mjs'
import { registerLocationRoutes } from './server/location-api.mjs'
import { registerBilibiliRoutes } from './server/bilibili-api.mjs'
// 汽水音乐（/api/soda/*）：登录态由前端每次请求的 cookie 参数传入，后端绝不持久化
import { registerSodaRoutes } from './server/qishui-api.mjs'
// 汽水加密音频解密代理（/api/soda/audio）：CENC 流服务端解密为可播 FLAC/m4a
import { registerSodaAudioProxy } from './server/qishui-audio-decryptor.mjs'
import { registerAppleArtworkRoutes } from './server/apple-artwork-api.mjs'
import { ByteLruCache, readResponseWithLimit } from './server/byte-lru-cache.mjs'
import { isAuthorizedLocalRequest } from './server/local-service-auth.mjs'
import dglabRelayModule from './server/dglab-relay.cjs'
const { createDGLabRelay } = dglabRelayModule

const execFileAsync = promisify(execFile)

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// 进程级兜底：未处理的 Promise rejection 与未捕获异常只记录日志，不崩溃进程。
// uncaughtException 状态下不尝试继续执行业务逻辑，仅记录后交由系统决定。
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason instanceof Error ? reason.stack || reason.message : reason)
})
process.on('uncaughtException', (error) => {
  console.error('[uncaughtException]', error?.stack || error)
})

// qq-music-api 库内部 axios 不设 timeout（默认 0，网络挂起会无限等待）。在库方法
// 入口统一封装 15s 超时：只在真实挂起时拒绝（同评论接口超时语义），正常结果与
// 库内吞错 {result:400} 的 reject 行为保持不变；Promise.race 会订阅两个输入，
// 竞速失败一侧的 rejection 不会变成 unhandledRejection。
{
  const qqApiOriginal = qqMusicApi.api.bind(qqMusicApi)
  qqMusicApi.api = (path, query) =>
    withTimeout(qqApiOriginal(path, query), 15000, `QQ 音乐 API ${path} 请求超时`)
}

// 上游 HTTP 客户端 keep-alive：本地服务高频转发播放 URL / 封面 / 评论等请求，
// 复用 TCP 连接能省掉每次握手。qq-music-api 与下方直接 axios 调用都走 axios 默认
// 实例，统一设默认 agent 即可覆盖；网易云增强 API 自建 per-request agent，不受影响。
axios.defaults.httpAgent = new HttpAgent({ keepAlive: true, maxSockets: 64 })
axios.defaults.httpsAgent = new HttpsAgent({ keepAlive: true, maxSockets: 64 })

const app = express()
const PORT = Number(process.env.PORT) || 3001
const LOCAL_SERVICE_TOKEN = String(process.env.WAVEFORGE_LOCAL_TOKEN || '')
const ALLOWED_RENDERER_ORIGINS = new Set([
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  // TV 真机：WebView 页面源与 API 同源（localhost:3001），fetch POST 会带 Origin，必须放行
  'http://localhost:3001',
  'http://127.0.0.1:3001',
  'file://',
  'null',
])

// QQ 音乐登录态只保留一份原始 Cookie，同时同步给 qq-music-api。
// 过去 /api/qq/cookie 和 /api/qq/user/setCookie 各写一份状态，导致评论点赞、
// MV 与歌单接口看到的登录态不一致。
let qqMusicCookie = ''
let lastQQPlaylistMutationDiagnostic = null
let lastQQPlaylistResolutionDiagnostic = null
let lastQQFavoriteStateDiagnostic = null

function setQQMusicCookie(cookie) {
  const normalizedCookie = typeof cookie === 'string' ? cookie.trim() : ''
  if (!normalizedCookie) return false

  const parsedCookie = parseQQCookie(normalizedCookie)
  if (Number(parsedCookie.login_type) === 2 && parsedCookie.wxuin) {
    parsedCookie.uin = parsedCookie.wxuin
  }
  if (parsedCookie.uin) {
    parsedCookie.uin = String(parsedCookie.uin).replace(/\D/g, '')
  }

  qqMusicCookie = normalizedCookie
  // 库本身只按 "; " 拆字符串，手动粘贴的 ";" 分隔 Cookie 会丢字段；
  // 传入已解析对象也能保留值中可能出现的等号。
  qqMusicApi.setCookie(parsedCookie)
  return true
}

// QQ Cookie 落盘：登录后持久化，服务重启（冷启动）后恢复全局登录态。
// 不恢复的话，每次启动 local-server 全局 cookie 都是空的：user/songlist 这类
// 公开接口仍能返回自建歌单，但「我喜欢」的兜底（user/detail → mymusic）需要登录，
// 会静默失败，导致启动时歌单列表缺「我喜欢」，手动刷新后才出现。
const QQ_COOKIE_PERSIST_FILENAME = 'qq-cookie.txt'

function getQQCookiePersistPath() {
  const baseDir = process.env.WAVEFORGE_USERDATA || join(os.homedir(), '.waveforge')
  return join(baseDir, QQ_COOKIE_PERSIST_FILENAME)
}

function persistQQMusicCookie(cookie) {
  try {
    const target = getQQCookiePersistPath()
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, String(cookie || '').trim(), 'utf8')
  } catch (error) {
    console.warn('[QQCookie] 持久化失败（不影响本次登录）:', error?.message || error)
  }
}

function restoreQQMusicCookie() {
  try {
    const target = getQQCookiePersistPath()
    if (!existsSync(target)) return
    const saved = readFileSync(target, 'utf8').trim()
    if (!saved) return
    if (setQQMusicCookie(saved)) {
      console.log(`[QQCookie] 已从本地恢复登录态（${saved.length} 字符）`)
    }
  } catch (error) {
    console.warn('[QQCookie] 启动恢复失败:', error?.message || error)
  }
}

// 解析“本次请求有效 Cookie”：请求自带 cookie 时仅本次使用，绝不回写全局。
// 全局 qqMusicCookie 是登录态的单一事实来源，只由显式登录/设置接口
// （/api/qq/cookie、/api/qq/user/setCookie）通过 setQQMusicCookie 更新。
function resolveRequestCookie(cookie) {
  if (typeof cookie === 'string' && cookie.trim()) return cookie.trim()
  return qqMusicCookie
}

function useQQMusicCookie(cookie) {
  // 历史接口名保留：仅解析本次请求有效 cookie，不再覆盖全局登录态。
  // 修复前播放/读取路由会把请求自带的 cookie 无条件写回全局，并发请求时
  // 后写者会冲掉先写者的登录态，导致“我喜欢”等写操作用错账号的 cookie。
  return resolveRequestCookie(cookie)
}

function parseQQCookie(cookie = qqMusicCookie) {
  return String(cookie || '')
    .split(/;\s*/)
    .reduce((result, part) => {
      const separatorIndex = part.indexOf('=')
      if (separatorIndex <= 0) return result
      result[part.slice(0, separatorIndex).trim()] = part.slice(separatorIndex + 1).trim()
      return result
    }, {})
}

function normalizeQQImageUrl(value) {
  const url = String(value || '').trim()
  if (!url) return ''
  if (url.startsWith('//')) return `https:${url}`
  if (url.startsWith('http://')) return `https://${url.slice(7)}`
  if (url.startsWith('https://')) return url
  return `https://y.gtimg.cn/music/photo_new/T015R640x360M000${url}.jpg`
}

function requireQQLogin(res, cookie) {
  const activeCookie = useQQMusicCookie(cookie)
  if (!activeCookie) {
    res.status(401).json({ result: 301, error: '需要登录 QQ 音乐账号' })
    return null
  }
  return activeCookie
}

async function mutateQQSonglist({ dirid, mid, id, operation }, cookie = '') {
  // 写操作只按本次请求使用请求自带的 cookie（解析 uin/签名、发送 Cookie 头），
  // 绝不回写全局 qqMusicCookie，避免并发请求互相冲掉登录态。
  const activeCookie = cookie || qqMusicCookie
  const parsedCookie = parseQQCookie(activeCookie)
  const uin = String(
    parsedCookie.uin || parsedCookie.qqmusic_uin || parsedCookie.musicid || parsedCookie.wxuin || ''
  ).replace(/\D/g, '')
  if (!uin) throw new Error('QQ 音乐登录信息中缺少 UIN')

  const tokenSource = parsedCookie.skey || parsedCookie.p_skey || parsedCookie.qm_keyst || parsedCookie.qqmusic_key || ''
  const gTk = tokenSource ? qqHash33(tokenSource) : 5381

  const endpoint = operation === 'add'
    ? 'https://c.y.qq.com/splcloud/fcgi-bin/fcg_music_add2songdir.fcg'
    : 'https://c.y.qq.com/qzone/fcg-bin/fcg_music_delbatchsong.fcg'
  const values = operation === 'add'
    ? {
        loginUin: uin, hostUin: 0, uin, dirid: String(dirid),
        midlist: String(mid),
        typelist: new Array(String(mid).split(',').length).fill(13).join(','),
        addtype: '', formsender: 4, r2: 0, r3: 1, utf8: 1,
        platform: 'yqq', format: 'json', inCharset: 'utf8',
        outCharset: 'utf-8', notice: 0, needNewCode: 0, g_tk: gTk
      }
    : {
        loginUin: uin, hostUin: 0, uin, dirid: String(dirid),
        ids: String(id),
        source: 103,
        types: new Array(String(id).split(',').length).fill(3).join(','),
        formsender: 4, flag: 2, utf8: 1, platform: 'yqq.post',
        format: 'json', inCharset: 'utf8', outCharset: 'utf-8',
        notice: 0, needNewCode: 0, g_tk: gTk, from: 3
      }

  // 保留用户登录时提交的原始 Cookie。重新 URL 编码 musickey/skey 会改变签名值，
  // 进而让 QQ 的旧版“我喜欢”接口误判为未登录或 invalid request。
  const cookieHeader = activeCookie || Object.entries(parsedCookie)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join('; ')
  const response = await axios.get(endpoint, {
    params: values,
    headers: {
      ...QQ_HEADERS,
      Cookie: cookieHeader,
      Referer: 'https://y.qq.com/n/yqq/playlist'
    },
    timeout: 15000,
    validateStatus: () => true
  })
  const result = typeof response.data === 'string'
    ? JSON.parse(response.data.replace(/(^.+\()|(\).+$)/g, ''))
    : response.data

  if (lastQQPlaylistMutationDiagnostic) {
    lastQQPlaylistMutationDiagnostic.legacyFallback = {
      operation,
      request: {
        dirId: Number(dirid),
        mid: operation === 'add' ? String(mid || '') : undefined,
        songId: operation === 'remove' ? Number(id) : undefined
      },
      response: {
        httpStatus: response.status,
        code: result?.code,
        message: result?.msg || result?.message || ''
      }
    }
  }

  if (Number(result?.code) !== 0) {
    const error = new Error(result?.msg || `QQ 音乐${operation === 'add' ? '添加' : '删除'}歌曲失败`)
    error.qqCode = Number(result?.code)
    throw error
  }
  return result
}

function qqHash33(value, seed = 5381) {
  let hash = seed
  for (const char of String(value || '')) {
    hash = ((hash << 5) + hash + char.charCodeAt(0)) & 0x7fffffff
  }
  return hash
}

function getQQCommentAuth(cookie) {
  const activeCookie = useQQMusicCookie(cookie)
  const parsedCookie = parseQQCookie(activeCookie)
  const uin = String(
    parsedCookie.uin || parsedCookie.qqmusic_uin || parsedCookie.musicid || parsedCookie.wxuin || ''
  ).replace(/\D/g, '')
  const tokenSource = parsedCookie.skey || parsedCookie.p_skey || parsedCookie.qm_keyst || parsedCookie.qqmusic_key || ''

  if (!uin || !tokenSource) {
    throw new Error('QQ 音乐登录凭证已失效或缺少 uin/token，请重新登录后再试')
  }

  return {
    cookie: activeCookie,
    uin,
    gTk: qqHash33(tokenSource)
  }
}

async function requestQQCommentMutation({ cookie, endpoint = 'comment', data }) {
  const auth = getQQCommentAuth(cookie)
  const url = endpoint === 'praise'
    ? 'https://c.y.qq.com/base/fcgi-bin/fcg_global_comment_praise_h5.fcg'
    : 'https://c.y.qq.com/base/fcgi-bin/fcg_global_comment_h5.fcg'
  const response = await axios.get(url, {
    params: {
      g_tk: auth.gTk,
      g_tk_new_20200303: auth.gTk,
      loginUin: auth.uin,
      hostUin: 0,
      format: 'json',
      inCharset: 'utf8',
      outCharset: 'utf-8',
      notice: 0,
      platform: 'yqq.json',
      needNewCode: 0,
      reqtype: 2,
      ...data
    },
    headers: {
      ...QQ_HEADERS,
      Cookie: auth.cookie
    },
    timeout: 15000,
    validateStatus: () => true
  })

  if (response.status < 200 || response.status >= 300) {
    throw new Error(`QQ 音乐评论接口 HTTP ${response.status}`)
  }

  const result = response.data || {}
  const resultMessage = getCommentMutationMessage(result)
  const reportsSuccess = isCommentMutationSuccessful(result)
  if (Number(result.code || 0) !== 0 && !reportsSuccess) {
    if (Number(result.code) === 1000 || /token|登录|login/i.test(resultMessage)) {
      throw new Error('QQ 音乐登录凭证已过期，请重新登录后再试')
    }
    throw new Error(resultMessage || 'QQ 音乐评论操作失败')
  }
  return reportsSuccess ? { ...result, code: 0, message: resultMessage } : result
}

async function mutateQQSonglistModern({ dirid, songId, songType = 0, operation }, cookie = '') {
  // 写操作只按本次请求使用请求自带的 cookie，绝不回写全局登录态。
  const activeCookie = cookie || qqMusicCookie
  const parsedCookie = parseQQCookie(activeCookie)
  const musicId = String(parsedCookie.uin || parsedCookie.qqmusic_uin || '').replace(/\D/g, '')
  const musicKey = parsedCookie.qm_keyst || parsedCookie.qqmusic_key || ''
  if (!musicId || !musicKey) {
    throw new Error('QQ 音乐登录凭证缺少 musicid 或 musickey')
  }
  if (!/^\d+$/.test(String(songId))) {
    throw new Error('QQ 音乐操作需要数字歌曲 ID')
  }

  const payload = {
    comm: {
      ct: 24,
      cv: 4747474,
      platform: 'yqq.json',
      uin: musicId,
      qq: musicId,
      authst: musicKey,
      tmeLoginType: Number(parsedCookie.login_type) || undefined,
      g_tk: qqHash33(musicKey),
      g_tk_new_20200303: qqHash33(musicKey),
      format: 'json',
      inCharset: 'utf-8',
      outCharset: 'utf-8',
      notice: 0,
      need_new_code: 1
    },
    req_0: {
      module: 'music.musicasset.PlaylistDetailWrite',
      method: operation === 'add' ? 'AddSonglist' : 'DelSonglist',
      param: {
        dirId: Number(dirid),
        v_songInfo: [{
          songId: Number(songId),
          songType: Number(songType) || 0
        }]
      }
    }
  }

  const cookieHeader = activeCookie || Object.entries(parsedCookie)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join('; ')
  // QQ 网页端对写请求启用 needSign：将 musicu.fcg 切换为 musics.fcg，
  // 对原始 JSON 生成 zzc sign，并用 ag-1 加密请求体。仅签名但发送明文仍会返回 80105。
  const requestBody = JSON.stringify(payload)
  const encryptedBody = await encodeAG1Request(requestBody)
  const sign = zzcSign(requestBody)
  const signedUrl = `https://u6.y.qq.com/cgi-bin/musics.fcg?_=${Date.now()}&encoding=ag-1&sign=${encodeURIComponent(sign)}`
  const response = await axios.post(signedUrl, encryptedBody, {
    headers: {
      ...QQ_HEADERS,
      Cookie: cookieHeader,
      'Content-Type': 'text/plain'
    },
    responseType: 'arraybuffer',
    transformResponse: data => data,
    timeout: 15000,
    validateStatus: () => true
  })
  let responseData
  try {
    responseData = JSON.parse(decodeAG1Response(new Uint8Array(response.data)))
  } catch (decodeError) {
    throw new Error(`QQ 音乐写入响应解密失败：${decodeError?.message || decodeError}`)
  }
  const requestResult = responseData?.req_0 || responseData
  const resultCode = Number(requestResult?.code ?? requestResult?.data?.retCode ?? responseData?.code)
  lastQQPlaylistMutationDiagnostic = {
    timestamp: new Date().toISOString(),
    operation,
    request: {
      dirId: Number(dirid),
      songId: Number(songId),
      songType: Number(songType) || 0,
      signed: true,
      encrypted: 'ag-1',
      endpoint: 'u6.y.qq.com/musics.fcg'
    },
    response: {
      httpStatus: response.status,
      topCode: responseData?.code,
      reqCode: requestResult?.code,
      reqMessage: requestResult?.msg || requestResult?.errMsg || requestResult?.data?.msg || '',
      data: requestResult?.data || null
    }
  }
  if (resultCode !== 0) {
    const error = new Error(
      requestResult?.msg || requestResult?.errMsg || requestResult?.data?.msg ||
      `QQ 音乐${operation === 'add' ? '添加' : '删除'}歌曲失败${Number.isFinite(resultCode) ? `（代码 ${resultCode}）` : ''}`
    )
    error.qqCode = resultCode
    throw error
  }
  return requestResult?.data || requestResult
}

// 收藏/取消收藏歌单（关注歌单）。与「我喜欢」写入一致，走签名 MusicU 接口：
// g_tk 从 qqmusic_key/qm_keyst 计算，ag-1 加密 + zzc 签名，POST 到 musics.fcg。
async function mutateQQPlaylistConcern({ dissid, concern }, cookie = '') {
  // 写操作只按本次请求使用请求自带的 cookie，绝不回写全局登录态。
  const activeCookie = cookie || qqMusicCookie
  const parsedCookie = parseQQCookie(activeCookie)
  const musicId = String(parsedCookie.uin || parsedCookie.qqmusic_uin || parsedCookie.wxuin || '').replace(/\D/g, '')
  const musicKey = parsedCookie.qm_keyst || parsedCookie.qqmusic_key || ''
  if (!musicId || !musicKey) {
    throw new Error('QQ 音乐登录凭证缺少 musicid 或 musickey，请重新登录后再试')
  }

  const attempts = [
    { module: 'music.concern.ConcernMusicDiss', method: 'concern', param: { disstid: String(dissid), source: 1 } },
    { module: 'music.concern.ConcernMusicDiss', method: 'concern', param: { disstid: String(dissid), source: 2 } },
    { module: 'music.concern.ConcernMusicDiss', method: 'concern', param: { disstid: String(dissid), concern: '1' } },
    { module: 'music.concern.ConcernMusicDiss', method: 'concern', param: { dissid: String(dissid), concern: '1' } },
    { module: 'music.concern.ConcernMusicDiss', method: 'concern', param: { dissid: Number(dissid), concern: 1 } },
  ]

  const cookieHeader = activeCookie || Object.entries(parsedCookie)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join('; ')

  let lastError = null
  for (const attempt of attempts) {
    const payload = {
      comm: {
        ct: 24,
        cv: 4747474,
        platform: 'yqq.json',
        uin: musicId,
        qq: musicId,
        authst: musicKey,
        tmeLoginType: Number(parsedCookie.tmeLoginType) || Number(parsedCookie.login_type) || undefined,
        g_tk: qqHash33(musicKey),
        g_tk_new_20200303: qqHash33(musicKey),
        format: 'json',
        inCharset: 'utf-8',
        outCharset: 'utf-8',
        notice: 0,
        need_new_code: 1
      },
      req_0: attempt
    }
    try {
      const requestBody = JSON.stringify(payload)
      const encryptedBody = await encodeAG1Request(requestBody)
      const sign = zzcSign(requestBody)
      const signedUrl = `https://u6.y.qq.com/cgi-bin/musics.fcg?_=${Date.now()}&encoding=ag-1&sign=${encodeURIComponent(sign)}`
      const response = await axios.post(signedUrl, encryptedBody, {
        headers: {
          ...QQ_HEADERS,
          Cookie: cookieHeader,
          'Content-Type': 'text/plain'
        },
        responseType: 'arraybuffer',
        transformResponse: data => data,
        timeout: 15000,
        validateStatus: () => true
      })
      let responseData
      try {
        responseData = JSON.parse(decodeAG1Response(new Uint8Array(response.data)))
      } catch (decodeError) {
        throw new Error(`QQ 音乐收藏歌单响应解密失败：${decodeError?.message || decodeError}`)
      }
      const requestResult = responseData?.req_0 || responseData
      const resultCode = Number(requestResult?.code ?? requestResult?.data?.retCode ?? responseData?.code)
      console.log(`[QQ音乐收藏歌单] 尝试 ${attempt.module} / ${attempt.method} / ${JSON.stringify(attempt.param)} → code ${resultCode}`)
      if (resultCode === 0) {
        return requestResult?.data || requestResult
      }
      lastError = new Error(
        requestResult?.msg || requestResult?.errMsg || requestResult?.data?.msg ||
        `QQ 音乐${concern ? '收藏' : '取消收藏'}歌单失败（代码 ${resultCode}）`
      )
      lastError.qqCode = resultCode
    } catch (requestError) {
      console.error('[QQ音乐收藏歌单] 请求异常:', requestError?.message || requestError)
      lastError = requestError
    }
  }

  // 兜底：旧版 fcg_qm_order_diss 接口（收藏/取消收藏歌单）。现代微信登录没有
  // skey/p_skey，这里分别尝试用 qqmusic_key / qm_keyst 计算 g_tk。
  // 该接口必须走 POST + x-www-form-urlencoded 表单体（GET 会返回 -100002 invalid request）。
  for (const keyName of ['qqmusic_key', 'qm_keyst']) {
    const token = parsedCookie[keyName]
    if (!token) continue
    try {
      const gTk = qqHash33(token)
      const formBody = new URLSearchParams({
        loginUin: musicId,
        hostUin: '0',
        format: 'json',
        inCharset: 'GB2312',
        outCharset: 'utf8',
        notice: '0',
        platform: 'yqq',
        needNewCode: '0',
        g_tk: String(gTk),
        uin: musicId,
        dissid: String(dissid),
        from: '1',
        optype: concern ? '1' : '2',
        utf8: '1',
        qzreferrer: `https://y.qq.com/n/yqq/playlist/${dissid}.html`,
      }).toString()
      const legacyResponse = await axios.post(
        'https://c.y.qq.com/folder/fcgi-bin/fcg_qm_order_diss.fcg',
        formBody,
        {
          headers: {
            ...QQ_HEADERS,
            Cookie: cookieHeader,
            Referer: `https://y.qq.com/n/yqq/playlist/${dissid}.html`,
            Origin: 'https://imgcache.qq.com',
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          timeout: 15000,
          validateStatus: () => true,
        }
      )
      let legacyResult = legacyResponse.data
      if (typeof legacyResult === 'string') {
        try { legacyResult = JSON.parse(legacyResult.replace(/(^.+\()|(\).+$)/g, '')) } catch { legacyResult = null }
      }
      const legacyCode = legacyResult?.code ?? legacyResult?.ret ?? null
      console.log(`[QQ音乐收藏歌单] 旧接口(POST) ${keyName} → code ${legacyCode}`, legacyResult?.msg ? `(${legacyResult.msg})` : '')
      if (legacyCode != null && Number(legacyCode) === 0) {
        return legacyResult
      }
      if (legacyResult) lastError = new Error(legacyResult?.msg || `QQ 音乐收藏歌单失败（旧接口 code ${legacyCode}）`)
    } catch (legacyError) {
      console.error('[QQ音乐收藏歌单] 旧接口异常:', legacyError?.message || legacyError)
      lastError = legacyError
    }
  }

  throw lastError || new Error('QQ 音乐收藏歌单失败')
}

async function resolveQQFavoritePlaylistId(cookie = '') {
  // 读取“我喜欢”歌单目录同样按本次请求使用请求自带的 cookie，不回写全局。
  const activeCookie = cookie || qqMusicCookie
  const parsedCookie = parseQQCookie(activeCookie)
  const uin = String(
    parsedCookie.uin || parsedCookie.qqmusic_uin || parsedCookie.musicid || parsedCookie.wxuin || ''
  ).replace(/\D/g, '')
  if (!uin) throw new Error('QQ 音乐登录信息中缺少 UIN')

  // PlaylistDetailWrite 与 PlaylistBaseRead 属于同一套 MusicU 接口，写入时必须
  // 使用 BaseRead 返回的 dirId。旧 user/songlist 的 tid 是歌单内容 ID，不能混用。
  try {
    const musicKey = parsedCookie.qm_keyst || parsedCookie.qqmusic_key || ''
    const payload = {
      comm: {
        ct: 24,
        cv: 4747474,
        platform: 'yqq.json',
        uin,
        qq: uin,
        authst: musicKey,
        tmeLoginType: Number(parsedCookie.login_type) || undefined,
        g_tk: qqHash33(musicKey),
        g_tk_new_20200303: qqHash33(musicKey),
        format: 'json'
      },
      req_0: {
        module: 'music.musicasset.PlaylistBaseRead',
        method: 'GetPlaylistByUin',
        param: { uin, bWithoutStatus: false }
      }
    }
    const response = await axios.post(QQ_MUSICU_URL, payload, {
      headers: {
        ...QQ_HEADERS,
        Cookie: activeCookie,
        'Content-Type': 'application/json'
      },
      timeout: 15000,
      validateStatus: () => true
    })
    const requestResult = response.data?.req_0
    const playlists = Array.isArray(requestResult?.data?.v_playlist)
      ? requestResult.data.v_playlist
      : []
    const favorite = playlists.find(item => {
      const name = String(
        item?.dirName || item?.dir_name || item?.diss_name || item?.title || item?.name || ''
      ).trim()
      return String(item?.dirId ?? item?.dirid ?? '') === '201' ||
        name === '我喜欢' || name === '我喜欢的音乐' || name.endsWith('喜欢的音乐')
    })
    const favoriteDirId = favorite?.dirId ?? favorite?.dirid
    lastQQPlaylistResolutionDiagnostic = {
      timestamp: new Date().toISOString(),
      source: 'PlaylistBaseRead.GetPlaylistByUin',
      httpStatus: response.status,
      code: requestResult?.code,
      selected: favorite ? {
        dirId: favoriteDirId,
        tid: favorite?.tid,
        name: favorite?.dirName || favorite?.dir_name || favorite?.diss_name || favorite?.title || favorite?.name || ''
      } : null,
      candidates: playlists.slice(0, 20).map(item => ({
        dirId: item?.dirId ?? item?.dirid,
        tid: item?.tid,
        name: item?.dirName || item?.dir_name || item?.diss_name || item?.title || item?.name || ''
      }))
    }
    if (Number(requestResult?.code) === 0 && /^\d+$/.test(String(favoriteDirId ?? ''))) {
      return String(favoriteDirId)
    }
  } catch (error) {
    lastQQPlaylistResolutionDiagnostic = {
      timestamp: new Date().toISOString(),
      source: 'PlaylistBaseRead.GetPlaylistByUin',
      error: error?.message || String(error)
    }
    console.warn('[QQ音乐我喜欢] 新版歌单目录解析失败，尝试旧接口兜底:', error?.message || error)
  }

  const playlistData = await qqMusicApi.api('user/songlist', { id: uin })
  const playlists = Array.isArray(playlistData?.list)
    ? playlistData.list
    : Array.isArray(playlistData?.data?.list)
      ? playlistData.data.list
      : []
  const favorite = playlists.find(item => {
    const name = String(item?.diss_name || item?.title || item?.dissname || '').trim()
    return String(item?.dirid ?? item?.dirId ?? '') === '201' ||
      name === '我喜欢' || name === '我喜欢的音乐' || name.endsWith('喜欢的音乐')
  })

  // 仅在新版读接口不可用时兜底。旧接口没有可用目录 ID 时，201 比 tid 更接近
  // PlaylistDetailWrite 所需的语义；tid 仅用于读取歌单内容。
  const favoriteId = favorite?.dirid ?? favorite?.dirId ?? 201
  lastQQPlaylistResolutionDiagnostic = {
    timestamp: new Date().toISOString(),
    source: 'legacy-user-songlist-fallback',
    selected: favorite ? {
      dirId: favorite?.dirid ?? favorite?.dirId,
      tid: favorite?.tid || favorite?.dissid || favorite?.disstid,
      name: favorite?.diss_name || favorite?.title || favorite?.dissname || ''
    } : null,
    resolvedDirId: favoriteId
  }
  if (!/^\d+$/.test(String(favoriteId || ''))) {
    throw new Error('无法解析 QQ 音乐“我喜欢”歌单 ID，请重新登录后再试')
  }
  return String(favoriteId)
}

async function getQQSongFavoriteState(songMid, cookie = '') {
  if (!songMid) return null
  const activeCookie = cookie || qqMusicCookie
  const parsedCookie = parseQQCookie(activeCookie)
  const musicId = String(parsedCookie.uin || parsedCookie.qqmusic_uin || '').replace(/\D/g, '')
  const musicKey = parsedCookie.qm_keyst || parsedCookie.qqmusic_key || ''
  if (!musicId || !musicKey) return null

  const payload = {
    comm: {
      ct: 24,
      cv: 4747474,
      platform: 'yqq.json',
      uin: musicId,
      qq: musicId,
      authst: musicKey,
      tmeLoginType: Number(parsedCookie.login_type) || undefined,
      g_tk: qqHash33(musicKey),
      g_tk_new_20200303: qqHash33(musicKey),
      format: 'json'
    },
    req_0: {
      module: 'music.musicasset.SongFavRead',
      method: 'IsSongFanByMid',
      param: { v_songMid: [String(songMid)] }
    }
  }
  const response = await axios.post(QQ_MUSICU_URL, payload, {
    headers: {
      ...QQ_HEADERS,
      Cookie: activeCookie,
      'Content-Type': 'application/json'
    },
    timeout: 15000,
    validateStatus: () => true
  })
  const requestResult = response.data?.req_0
  if (Number(requestResult?.code) !== 0) {
    lastQQFavoriteStateDiagnostic = {
      timestamp: new Date().toISOString(),
      mid: String(songId),
      code: requestResult?.code,
      message: requestResult?.msg || requestResult?.errMsg || ''
    }
    return null
  }
  const favoriteValue = requestResult?.data?.m_fan?.[String(songMid)]
  const stateValue = favoriteValue && typeof favoriteValue === 'object'
    ? favoriteValue.isFan ?? favoriteValue.is_fan ?? favoriteValue.fan ??
      favoriteValue.status ?? favoriteValue.value
    : favoriteValue
  const resolvedState = stateValue === true || stateValue === 1 || stateValue === '1'
  lastQQFavoriteStateDiagnostic = {
    timestamp: new Date().toISOString(),
    mid: String(songId),
    code: requestResult?.code,
    rawValue: favoriteValue ?? null,
    resolvedState
  }
  return resolvedState
}

// QQ音乐API配置
const QQ_SMARTBOX_URL = 'https://c.y.qq.com/splcloud/fcgi-bin/smartbox_new.fcg'
const QQ_MUSICU_URL = 'https://u.y.qq.com/cgi-bin/musicu.fcg'
const QQ_HEADERS = {
  Referer: 'https://y.qq.com/',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36'
}

const QQ_PLAYLIST_DETAIL_CACHE_TTL = 5 * 60 * 1000
const QQ_PLAYLIST_DETAIL_CACHE_MAX = 50
const qqPlaylistDetailCache = new Map()

async function fetchQQPlaylistDetail(id, songNum = 10000) {
  // 缓存键包含 songNum（它影响返回曲目数）；命中时按 LRU 刷新顺序并检查 TTL
  const cacheKey = `${String(id)}:${String(songNum)}`
  const cachedDetail = qqPlaylistDetailCache.get(cacheKey)
  if (cachedDetail) {
    if (cachedDetail.expiresAt > Date.now()) {
      qqPlaylistDetailCache.delete(cacheKey)
      qqPlaylistDetailCache.set(cacheKey, cachedDetail)
      return cachedDetail.value
    }
    qqPlaylistDetailCache.delete(cacheKey)
  }

  let legacyDetail = {}
  try {
    legacyDetail = await qqMusicApi.api('songlist', { id })
  } catch (error) {
    console.warn(`[QQ音乐歌单详情] 旧接口获取歌单 ${id} 失败，切换新版接口`, error.message)
  }

  const legacyData = legacyDetail?.data || legacyDetail
  if (
    legacyData?.songlist?.length &&
    (!legacyData.songnum || legacyData.songlist.length >= Number(legacyData.songnum))
  ) {
    return legacyData
  }

  const fetchPage = async (songBegin, pageSize) => {
    const payload = {
      req_0: {
        module: 'music.srfDissInfo.aiDissInfo',
        method: 'uniform_get_Dissinfo',
        param: {
          disstid: Number(id),
          enc_host_uin: '',
          tag: 1,
          userinfo: 1,
          song_begin: songBegin,
          song_num: pageSize
        }
      }
    }

    const response = await axios.get(QQ_MUSICU_URL, {
      params: { format: 'json', data: JSON.stringify(payload) },
      headers: {
        ...QQ_HEADERS,
        ...(qqMusicCookie ? { Cookie: qqMusicCookie } : {})
      },
      timeout: 15000
    })
    return response.data?.req_0?.data
  }

  const firstPage = await fetchPage(0, Math.min(Number(songNum) || 10000, 100))
  if (firstPage?.code !== 0 || !firstPage?.dirinfo) {
    return legacyData || {}
  }

  const totalSongCount = Math.min(
    Number(firstPage.total_song_num || firstPage.dirinfo.songnum || firstPage.songlist?.length || 0),
    Number(songNum) || 10000
  )
  const songs = [...(firstPage.songlist || [])]

  // uniform_get_Dissinfo 实际每页最多约 30 首；旧实现只请求一次，因此大型
  // QQ 歌单看起来没有完整详情。以首屏返回量为页长，分批补齐剩余歌曲。
  const actualPageSize = Math.max(songs.length, 30)
  const offsets = []
  for (let offset = songs.length; offset < totalSongCount; offset += actualPageSize) {
    offsets.push(offset)
  }
  for (let index = 0; index < offsets.length; index += 4) {
    const batch = offsets.slice(index, index + 4)
    const pageResults = await Promise.allSettled(batch.map(offset => fetchPage(offset, actualPageSize)))
    for (let pageIndex = 0; pageIndex < pageResults.length; pageIndex += 1) {
      const pageResult = pageResults[pageIndex]
      if (pageResult.status === 'fulfilled') {
        songs.push(...(pageResult.value?.songlist || []))
        continue
      }
      // 单页瞬时失败时再串行重试一次，避免一个分页拖垮整个歌单详情。
      try {
        const retriedPage = await fetchPage(batch[pageIndex], actualPageSize)
        songs.push(...(retriedPage?.songlist || []))
      } catch (error) {
        console.warn(`[QQ音乐歌单详情] 第 ${batch[pageIndex]} 首起的分页加载失败:`, error?.message || error)
      }
    }
  }

  const uniqueSongs = Array.from(new Map(songs.map(song => [
    String(song?.mid || song?.songmid || song?.id || song?.songid),
    song
  ])).values())

  const result = {
    ...firstPage.dirinfo,
    songlist: uniqueSongs,
    songnum: totalSongCount || uniqueSongs.length,
    total_song_num: totalSongCount || uniqueSongs.length
  }
  if (qqPlaylistDetailCache.size >= QQ_PLAYLIST_DETAIL_CACHE_MAX) {
    const oldestKey = qqPlaylistDetailCache.keys().next().value
    if (oldestKey !== undefined) qqPlaylistDetailCache.delete(oldestKey)
  }
  qqPlaylistDetailCache.set(cacheKey, {
    value: result,
    expiresAt: Date.now() + QQ_PLAYLIST_DETAIL_CACHE_TTL
  })
  return result
}

async function fetchQQPlaylistFirstSong(id) {
  if (!id) return null
  const payload = {
    req_0: {
      module: 'music.srfDissInfo.aiDissInfo',
      method: 'uniform_get_Dissinfo',
      param: {
        disstid: Number(id),
        enc_host_uin: '',
        tag: 0,
        userinfo: 0,
        song_begin: 0,
        song_num: 1
      }
    }
  }
  const response = await axios.get(QQ_MUSICU_URL, {
    params: { format: 'json', data: JSON.stringify(payload) },
    headers: {
      ...QQ_HEADERS,
      ...(qqMusicCookie ? { Cookie: qqMusicCookie } : {})
    },
    timeout: 15000
  })
  const item = response.data?.req_0?.data?.songlist?.[0]
  if (!item) return null
  const track = item?.songInfo || item?.song || item
  return qqNormalizeSongFromTrack(track, track?.mid || track?.songmid, track)
}

function normalizePlaylistDescription(value) {
  return String(value || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/&nbsp;|&#0*160;?|&#x0*a0;?/gi, ' ')
    .replace(/&#(\d+);?/g, (_match, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);?/gi, (_match, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;|&#39;/gi, "'")
    .replace(/<[^>]+>/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function normalizeQQPlaylistDetail(detail, fallbackId) {
  const creator = detail?.creator || {}
  const rawTags = detail?.vec_tagname || detail?.tags || detail?.tag || []
  const tags = Array.isArray(rawTags)
    ? rawTags.map(tag => typeof tag === 'string' ? tag : tag?.name).filter(Boolean)
    : []
  const createdAt = Number(detail?.ctime || detail?.createtime || 0)

  return {
    id: detail?.id || detail?.dissid || detail?.disstid || fallbackId,
    name: detail?.title || detail?.dissname || detail?.name || 'QQ音乐歌单',
    coverImgUrl: normalizeQQImageUrl(
      detail?.picurl || detail?.picurl2 || detail?.logo || detail?.cover || detail?.coverImgUrl
    ),
    trackCount: Number(detail?.total_song_num || detail?.songnum || detail?.songlist?.length || 0),
    description: normalizePlaylistDescription(detail?.desc || detail?.introduction || ''),
    playCount: Number(detail?.listennum || detail?.visitnum || 0),
    creator: {
      userId: detail?.host_uin || creator?.uin || creator?.musicid || creator?.encrypt_uin || detail?.encrypt_uin,
      nickname: creator?.nick || creator?.name || detail?.host_nick || detail?.nickname || '',
      avatarUrl: normalizeQQImageUrl(creator?.headurl || creator?.avatarUrl || detail?.headurl || '')
    },
    tags,
    createTime: createdAt > 0 ? (createdAt < 1000000000000 ? createdAt * 1000 : createdAt) : undefined,
    commentCount: Number(detail?.commentCount || detail?.comment_num || 0),
    platform: 'qq'
  }
}

// gzip 压缩（放在所有路由与 body 解析之前）：/api/explore/* 等聚合响应可达数百 KB，
// 本地回环下压缩能显著减小序列化/传输开销。图片/视频/音频等媒体流一律跳过——
// 它们已接近不可压缩且需要保留 Content-Length / Range 语义，压缩缓冲会破坏流式播放。
// 过滤逻辑：按响应 Content-Type 排除媒体类型；SSE（QQ AI 解读/听歌报告等
// text/event-stream）也跳过——gzip 会缓冲小 chunk 不 flush，导致前端一直"连接中"
// 直到超时才收到整段（或断开），必须原样透传。
app.use(compression({
  threshold: 1024,
  filter: (req, res) => {
    // SSE 流式接口（AI 解读/听歌报告）：逐字输出的增量必须即时到达，禁用压缩
    if (req.path.startsWith('/api/explore/qq/skills/')) return false
    const contentType = res.getHeader('Content-Type')
    const type = Array.isArray(contentType) ? contentType[0] : contentType
    if (typeof type === 'string') {
      // 排除媒体流与未知二进制类型，避免 gzip 缓冲大文件或破坏 Range 请求
      if (/^(image|video|audio)\//.test(type) || type === 'application/octet-stream') return false
    }
    return true
  }
}))

// CORS 支持
app.use((req, res, next) => {
  // TV 遥控桥等 WebSocket 客户端误连本服务的 /ws：明确告知本服务不承载 WebSocket，
  // 代替 404 噪音（WebSocket 由桌面端 remote-server 在 25566/25567 提供）
  if (req.headers.upgrade?.toLowerCase?.() === 'websocket') {
    return res.status(426).json({ error: 'WebSocket 不在此服务，请连接遥控器服务的 /ws' })
  }
  const origin = req.headers.origin
  if (origin && !ALLOWED_RENDERER_ORIGINS.has(origin)) {
    return res.status(403).json({ error: 'Origin not allowed' })
  }
  if (origin) {
    res.header('Access-Control-Allow-Origin', origin)
    res.header('Vary', 'Origin')
  }
  // QQ Music Skills 的用户密钥只通过本机请求头传递，避免出现在 URL、历史记录和日志中。
  // Apple license 代理：兼容规范 Media-User-Token 与历史 X-Apple-Music-User-Token。
  res.header('Access-Control-Allow-Headers', 'Content-Type, X-WaveForge-Local-Token, X-QQMusic-Skill-Key, Authorization, Media-User-Token, X-Apple-Music-User-Token, X-Apple-Renewal')
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
  if (req.method === 'OPTIONS') return res.sendStatus(204)
  if (!isAuthorizedLocalRequest({
    configuredToken: LOCAL_SERVICE_TOKEN,
    suppliedToken: req.headers['x-waveforge-local-token'],
    path: req.path,
  })) {
    return res.status(403).json({ error: 'Unauthorized local service request' })
  }
  next()
})

app.use(express.json({ limit: '12mb' }))
app.use(express.urlencoded({ extended: true, limit: '12mb' }))
registerHazardRoutes(app)
registerLocationRoutes(app)
registerBilibiliRoutes(app)
registerSodaRoutes(app)
registerSodaAudioProxy(app)
registerAppleArtworkRoutes(app)

// DG_LAB 郊狼插件中继：仅注册控制路由；插件显式启用后才启动 30082 监听。
const dglabRelay = createDGLabRelay()
dglabRelay.registerHttp(app)

const fetchLocationProvider = async (url, normalize) => {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 6000)

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        'User-Agent': QQ_HEADERS['User-Agent'],
      },
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const normalized = normalize(await response.json())
    if (!normalized || !Number.isFinite(normalized.latitude) || !Number.isFinite(normalized.longitude)) {
      throw new Error('定位服务没有返回有效坐标')
    }
    return normalized
  } finally {
    clearTimeout(timeout)
  }
}

const IP_LOCATION_CACHE_TTL = 60 * 60 * 1000
let cachedIpLocation = null
let cachedIpLocationAt = 0

// 将公网 IP 定位放在本地服务端执行，避免渲染层受到 CORS 和浏览器隐私策略影响。
// 多服务顺序降级，避免一次定位同时消耗每个服务的限流额度。
app.get('/api/location/ip', async (_req, res) => {
  try {
    const providers = [
      () => fetchLocationProvider('https://ipinfo.io/json', data => {
        const [latitude, longitude] = String(data?.loc || '').split(',').map(Number)
        return {
          name: data.city || data.region || data.country || '当前位置',
          region: data.region || '',
          country: data.country || '',
          latitude,
          longitude,
          provider: 'ipinfo.io',
        }
      }),
      () => fetchLocationProvider('https://ipwho.is/?lang=zh-CN', data => {
        if (data?.success === false) return null
        return {
          name: data.city || data.region || data.country || '当前位置',
          region: data.region || '',
          country: data.country || '',
          latitude: Number(data.latitude),
          longitude: Number(data.longitude),
          provider: 'ipwho.is',
        }
      }),
      () => fetchLocationProvider('https://ipapi.co/json/', data => {
        if (data?.error) return null
        return {
          name: data.city || data.region || data.country_name || '当前位置',
          region: data.region || '',
          country: data.country_name || data.country || '',
          latitude: Number(data.latitude),
          longitude: Number(data.longitude),
          provider: 'ipapi.co',
        }
      }),
      () => fetchLocationProvider('https://api.ip.sb/geoip', data => ({
        name: data.city || data.region || data.country || '当前位置',
        region: data.region || '',
        country: data.country || '',
        latitude: Number(data.latitude),
        longitude: Number(data.longitude),
        provider: 'ip.sb',
      })),
    ]

    if (cachedIpLocation && Date.now() - cachedIpLocationAt < IP_LOCATION_CACHE_TTL) {
      res.setHeader('Cache-Control', 'private, max-age=3600')
      return res.json({ success: true, ...cachedIpLocation, cached: true })
    }

    let lastError = null
    for (const provider of providers) {
      try {
        const location = await provider()
        cachedIpLocation = location
        cachedIpLocationAt = Date.now()
        res.setHeader('Cache-Control', 'private, max-age=3600')
        return res.json({ success: true, ...location })
      } catch (error) {
        lastError = error
      }
    }

    // 公网服务短暂限流时沿用最近一次成功定位，不把 HTTP 状态暴露给界面。
    if (cachedIpLocation) {
      res.setHeader('Cache-Control', 'private, max-age=300')
      return res.json({ success: true, ...cachedIpLocation, cached: true, stale: true })
    }

    console.warn('[天气定位] 所有 IP 定位服务均不可用:', lastError?.message || lastError)
    return res.status(503).json({ success: false, error: '自动定位服务暂时繁忙，请稍后重试或选择手动定位' })
  } catch (error) {
    console.error('[天气定位] 定位处理异常:', error?.stack || error)
    return res.status(500).json({ success: false, error: '自动定位服务异常，请稍后重试或选择手动定位' })
  }
})

// 设置QQ音乐Cookie的接口
app.post('/api/qq/cookie', (req, res) => {
  try {
    const { cookie } = req.body
    if (!cookie) {
      return res.status(400).json({ error: 'Cookie不能为空' })
    }
    setQQMusicCookie(cookie)
    persistQQMusicCookie(cookie)
    res.json({ success: true, message: 'Cookie已设置' })
  } catch (error) {
    console.error('[QQ音乐Cookie] 错误:', error)
    res.status(500).json({ error: error.message })
  }
})

// 获取当前QQ音乐Cookie状态
app.get('/api/qq/cookie/status', (req, res) => {
  res.json({ 
    hasCookie: !!qqMusicCookie,
    cookieLength: qqMusicCookie.length 
  })
})

// ========== TTML解析器 ==========
/**
 * 简单的TTML解析器（不依赖DOM）
 * 解析AMLL TTML DB格式并转换为LRC格式
 */
function parseTTMLSimple(ttmlText) {
  const result = {
    lyric: '',
    translation: '',
    roman: ''
  }
  
  try {
    const lyricLines = []
    const translationLines = []
    const romanLines = []
    
    // 使用正则提取所有<p>标签
    const pRegex = /<p[^>]*begin="([^"]*)"[^>]*end="([^"]*)"[^>]*>([\s\S]*?)<\/p>/gi
    let match
    
    while ((match = pRegex.exec(ttmlText)) !== null) {
      const beginTime = match[1]
      const endTime = match[2]
      const content = match[3]
      
      // 解析时间为毫秒
      const startMs = parseTimeToMs(beginTime)
      const minutes = Math.floor(startMs / 60000)
      const seconds = Math.floor((startMs % 60000) / 1000)
      const milliseconds = Math.floor((startMs % 1000) / 10)
      const timestamp = `[${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(milliseconds).padStart(2, '0')}]`
      
      // 提取原文（不包含translation和roman的span）
      let lyricText = ''
      const spanRegex = /<span[^>]*>([\s\S]*?)<\/span>/gi
      let spanMatch
      const spans = []
      
      while ((spanMatch = spanRegex.exec(content)) !== null) {
        const spanFull = spanMatch[0]
        const spanText = spanMatch[1]
        
        if (spanFull.includes('ttm:role="x-translation"')) {
          // 翻译
          const cleanText = spanText.replace(/<[^>]*>/g, '').trim()
          if (cleanText) {
            translationLines.push(`${timestamp}${cleanText}`)
          }
        } else if (spanFull.includes('ttm:role="x-roman"')) {
          const cleanText = spanText.replace(/<[^>]*>/g, '').trim()
          if (cleanText) {
            romanLines.push(`${timestamp}${cleanText}`)
          }
        } else if (!spanFull.includes('ttm:role="x-roman"')) {
          // 普通歌词（排除罗马音）
          const cleanText = spanText.replace(/<[^>]*>/g, '')
          lyricText += cleanText
        }
      }
      
      // 如果没有span，直接使用p的文本内容
      if (!lyricText) {
        lyricText = content.replace(/<[^>]*>/g, '').trim()
      }
      
      if (lyricText) {
        lyricLines.push(`${timestamp}${lyricText}`)
      }
    }
    
    result.lyric = lyricLines.join('\n')
    result.translation = translationLines.join('\n')
    result.roman = romanLines.join('\n')
    
  } catch (e) {
    console.error('[TTML解析] 解析失败:', e.message)
  }
  
  return result
}

/**
 * 解析时间字符串为毫秒
 * 支持格式: HH:MM:SS.mmm, MM:SS.mmm, SS.mmm
 */
function parseTimeToMs(timeStr) {
  const parts = timeStr.split(':')
  let seconds = 0
  
  if (parts.length === 3) {
    // HH:MM:SS.mmm
    seconds = parseInt(parts[0]) * 3600 + parseInt(parts[1]) * 60 + parseFloat(parts[2])
  } else if (parts.length === 2) {
    // MM:SS.mmm
    seconds = parseInt(parts[0]) * 60 + parseFloat(parts[1])
  } else {
    // SS.mmm
    seconds = parseFloat(timeStr)
  }
  
  return seconds * 1000
}
// ========== TTML解析器结束 ==========


// 图片代理常量与 SSRF 防护（/api/cover 与 /api/proxy-image 共用）
const FETCH_TIMEOUT_MS = 8000
const MAX_IMAGE_BYTES = 20 * 1024 * 1024

// 流式转发图片代理响应：保留 Content-Length 预检（超限时在发送任何字节前返回干净的 502），
// 转发过程中再统计实际字节数兜底（无 Content-Length 的上游）。不再整读进内存，
// 降低大图/多请求并发时的内存峰值；客户端中途断连或超限时销毁对端流，避免句柄泄漏。
function streamProxyImage(response, res, label, tooLargeMessage) {
  const contentLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(contentLength) && contentLength > MAX_IMAGE_BYTES) {
    console.error(`${label} content-length too large:`, contentLength)
    res.status(502).set('Access-Control-Allow-Origin', '*').send(tooLargeMessage)
    return false
  }
  const contentType = response.headers.get('content-type') || 'image/jpeg'
  res.set({
    'Content-Type': contentType,
    'Access-Control-Allow-Origin': '*',
    'Cross-Origin-Resource-Policy': 'cross-origin',
    'Cache-Control': 'public, max-age=86400',
  })
  let streamedBytes = 0
  const body = Readable.fromWeb(response.body)
  body.on('data', (chunk) => {
    streamedBytes += chunk.length
    if (streamedBytes > MAX_IMAGE_BYTES) {
      body.destroy()
      res.destroy()
    }
  })
  body.on('error', () => res.destroy())
  res.on('close', () => body.destroy())
  body.pipe(res)
  return true
}

// 判断地址是否属于内网/本机/链路本地等不允许代理访问的网段
function isPrivateNetworkAddress(address) {
  if (address.includes(':')) {
    const lower = address.toLowerCase()
    // ::、::1 及全零形式的本机/未指定地址
    if (lower === '::' || lower === '::1' || lower === '0:0:0:0:0:0:0:0' || lower === '0:0:0:0:0:0:0:1') return true
    // fc00::/7 唯一本地地址、fe80::/10 链路本地地址
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true
    if (lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) return true
    return false
  }
  const parts = address.split('.').map(Number)
  if (parts.length !== 4) return false
  const [a, b] = parts
  return a === 0 || a === 127 || a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254)
}

// SSRF 防护：返回 true 表示该 URL 指向内网/本机地址或无法安全解析，应拒绝
async function isBlockedFetchUrl(rawUrl) {
  let parsed
  try {
    parsed = new URL(rawUrl)
  } catch (error) {
    return true // URL 解析失败，直接拒绝
  }
  const hostname = String(parsed.hostname || '').replace(/^\[|\]$/g, '')
  if (!hostname) return true

  // 放行代理到本服务自身（如 /api/proxy-image → /api/cover 的内部代理链）。
  // 内层 /api/cover 仍会对最终目标做 CDN 公网校验，因此不会绕过 SSRF 防护。
  const port = String(parsed.port || (parsed.protocol === 'https:' ? '443' : '80'))
  if ((hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') && port === '3001') {
    return false
  }

  // 字面 IPv4 / IPv6 地址：直接判断网段
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) {
    if (hostname.split('.').some(part => Number(part) > 255)) return true
    return isPrivateNetworkAddress(hostname)
  }
  if (hostname.includes(':')) {
    return isPrivateNetworkAddress(hostname)
  }

  // DNS 名称：解析后只要有一个地址落在私网网段即拒绝
  const name = hostname.toLowerCase()
  if (name === 'localhost' || name.endsWith('.local')) return true
  try {
    const addresses = await Promise.race([
      dns.promises.lookup(name, { all: true, verbatim: true }),
      new Promise((resolve, reject) => setTimeout(() => reject(new Error('DNS lookup timeout')), 3000)),
    ])
    return addresses.some(({ address }) => isPrivateNetworkAddress(address))
  } catch (error) {
    return true // 解析失败或超时：保守拒绝
  }
}

// 图片代理（解决防盗链和CORS）
// 封面内存缓存：同一 URL 不重复请求上游。大歌单滚动浏览/反复进入歌单时，
// 避免几千个封面请求反复打穿代理与上游 CDN。
const COVER_CACHE_MAX_BYTES = 128 * 1024 * 1024
const COVER_CACHE_ITEM_MAX_BYTES = 10 * 1024 * 1024
const COVER_CACHE_TTL_MS = 6 * 60 * 60 * 1000
const coverCache = new ByteLruCache({ maxBytes: COVER_CACHE_MAX_BYTES, maxEntries: 800, ttlMs: COVER_CACHE_TTL_MS })

app.get('/api/cover', async (req, res) => {
  try {
    const { url, devMode } = req.query
    const isDev = devMode === 'true'
    
    // URL 校验
    if (!url || !/^https?:\/\//i.test(url)) {
      console.error('Invalid cover URL:', url)
      res.status(400).set('Access-Control-Allow-Origin', '*').send('Invalid cover url')
      return
    }

    // SSRF 防护：拒绝指向内网/本机/链路本地地址的 URL
    if (await isBlockedFetchUrl(url)) {
      console.error('Blocked cover URL:', url)
      res.status(400).set('Access-Control-Allow-Origin', '*').send('Invalid cover url')
      return
    }

    if (isDev) console.log('Fetching cover:', url)

    // 缓存命中：直接回缓存字节（带 Cache-Control 供浏览器二次命中）
    const cached = typeof url === 'string' ? coverCache.get(url) : null
    if (cached) {
      res.set({
        'Content-Type': cached.type,
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'max-age=3600',
      })
      res.send(cached.buffer)
      return
    }

    // 重试机制：最多尝试3次
    let response
    let lastError
    const maxRetries = 3
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const controller = new AbortController()
        const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
        try {
          // 转发请求，添加必要的 headers
          response = await fetch(url, {
            signal: controller.signal,
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
              'Referer': 'https://music.163.com/',
              'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
              'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
            }
          })
        } finally {
          clearTimeout(timeoutId)
        }
        
        // 成功获取响应，跳出循环
        if (attempt > 1 && isDev) {
        }
        break
      } catch (error) {
        lastError = error
        if (isDev) console.error(`封面获取第 ${attempt} 次尝试失败:`, error.message)
        
        // 如果是最后一次尝试，不再等待
        if (attempt < maxRetries) {
          const waitTime = attempt * 300 // 递增等待时间：300ms, 600ms
          await new Promise(resolve => setTimeout(resolve, waitTime))
        }
      }
    }
    
    // 如果所有尝试都失败，返回占位图
    if (!response) {
      console.error('封面获取失败（已重试3次）:', lastError?.message || lastError)
      res.status(200).set({
        'Content-Type': 'image/svg+xml',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache',
      }).send(`<svg width="500" height="500" xmlns="http://www.w3.org/2000/svg">
        <rect width="500" height="500" fill="#1a1a1a"/>
        <text x="250" y="250" font-family="Arial" font-size="24" fill="#666" text-anchor="middle">封面加载失败</text>
      </svg>`)
      return
    }

    if (!response.ok) {
      console.error('Cover fetch failed:', response.status, response.statusText)
      
      // 返回默认占位图
      res.status(200).set({
        'Content-Type': 'image/svg+xml',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache',
      }).send(`<svg width="500" height="500" xmlns="http://www.w3.org/2000/svg">
        <rect width="500" height="500" fill="#1a1a1a"/>
        <text x="250" y="250" font-family="Arial" font-size="24" fill="#666" text-anchor="middle">封面加载失败</text>
      </svg>`)
      return
    }

    // 读取字节并写入缓存（≤10MB 才缓存），再返回给浏览器
    const contentType = response.headers.get('content-type') || 'image/jpeg'
    if (!contentType.toLowerCase().startsWith('image/')) {
      throw new Error('Cover response is not an image')
    }
    const buf = await readResponseWithLimit(response, COVER_CACHE_ITEM_MAX_BYTES)
    if (typeof url === 'string') {
      coverCache.set(url, { buffer: buf, type: contentType }, buf.length)
    }
    res.set({
      'Content-Type': contentType,
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'max-age=3600',
    })
    res.send(buf)
  } catch (error) {
    console.error('封面代理错误:', error)
    res.status(500).set('Access-Control-Allow-Origin', '*').send('Failed to load cover')
  }
})

// 图片代理接口（返回二进制数据供前端缓存）
app.get('/api/proxy-image', async (req, res) => {
  try {
    const { url } = req.query
    
    // URL 校验
    if (!url || !/^https?:\/\//i.test(url)) {
      console.error('Invalid image URL:', url)
      res.status(400).set('Access-Control-Allow-Origin', '*').send('Invalid image url')
      return
    }

    // SSRF 防护：拒绝指向内网/本机/链路本地地址的 URL
    if (await isBlockedFetchUrl(url)) {
      console.error('Blocked image URL:', url)
      res.status(400).set('Access-Control-Allow-Origin', '*').send('Invalid image url')
      return
    }
    // 重试机制：最多尝试3次
    let response
    let lastError
    const maxRetries = 3
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const controller = new AbortController()
        const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
        try {
          // 转发请求，添加必要的 headers
          response = await fetch(url, {
            signal: controller.signal,
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
              'Referer': url.includes('music.163.com') ? 'https://music.163.com/' : 'https://y.qq.com/',
              'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
              'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
            }
          })
        } finally {
          clearTimeout(timeoutId)
        }
        
        // 成功获取响应，跳出循环
        if (attempt > 1) {
        }
        break
      } catch (error) {
        lastError = error
        console.error(`图片获取第 ${attempt} 次尝试失败:`, error.message)
        
        // 如果是最后一次尝试，不再等待
        if (attempt < maxRetries) {
          const waitTime = attempt * 300 // 递增等待时间：300ms, 600ms
          await new Promise(resolve => setTimeout(resolve, waitTime))
        }
      }
    }
    
    // 如果所有尝试都失败，返回错误
    if (!response) {
      console.error('图片获取失败（已重试3次）:', lastError?.message || lastError)
      res.status(500).set('Access-Control-Allow-Origin', '*').send('Failed to load image after 3 retries')
      return
    }

    if (!response.ok) {
      console.error('Image fetch failed:', response.status, response.statusText)
      res.status(response.status).set('Access-Control-Allow-Origin', '*').send('Failed to fetch image')
      return
    }

    // 流式转发（保留 Content-Length 预检 + 实际字节数兜底，不整读进内存）
    streamProxyImage(response, res, 'Image', 'Image too large')
  } catch (error) {
    console.error('图片代理错误:', error)
    res.status(500).set('Access-Control-Allow-Origin', '*').send('Failed to load image')
  }
})

// 动态导入网易云音乐 API
let NeteaseAPI = null

async function initNeteaseAPI() {
  try {
    const module = await import('@neteasecloudmusicapienhanced/api')
    NeteaseAPI = module.default
    
    // 网易云 xeapi 需先注册匿名 token（生成 deviceId）并拉取 xeapi 公钥缓存到系统临时目录，
    // 否则 /api/netease/song/url 会报 "xeapi public key is missing"（公钥随系统重启可能被清空）。
    try {
      const { default: generateConfig } = await import('@neteasecloudmusicapienhanced/api/generateConfig.js')
      await generateConfig()
      console.log('✅ 网易云 API 初始化完成（匿名 token + xeapi 公钥）')
    } catch (initError) {
      console.warn('⚠️ 网易云 API 初始化未完全成功（可能影响网易云高音质播放）:', initError.message)
    }
    
    // 配置网易云 API 的默认超时时间
    if (NeteaseAPI && typeof NeteaseAPI === 'object') {
      // NeteaseCloudMusicApi 使用 axios，可以设置全局超时
    }
  } catch (error) {
    console.error('❌ 网易云音乐 API 加载失败:', error)
  }
}

// 初始化
initNeteaseAPI()

async function withTimeout(promise, timeoutMs, message = '请求超时') {
  let timeoutId
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs)
      }),
    ])
  } finally {
    if (timeoutId) clearTimeout(timeoutId)
  }
}

// 包装网易云 API 调用，添加统一的超时和重试逻辑
async function callNeteaseAPIWithRetry(apiFunc, params, retries = 3, timeoutMs = 15000) {
  // 底层 @neteasecloudmusicapienhanced/api 不转发 AbortSignal，但 createOption 会把
  // query.timeout 透传到 axios settings，使底层请求在超时时被真正中止，避免
  // Promise.race 只竞速留下孤儿请求。
  const requestParams = { ...(params || {}), timeout: timeoutMs }
  for (let i = 0; i < retries; i++) {
    try {
      const result = await withTimeout(apiFunc(requestParams), timeoutMs)
      
      if (result && result.body) {
        return result
      }
    } catch (error) {
      if (i === retries - 1) {
        throw error
      }
      console.warn(`[网易云API] 第 ${i + 1} 次尝试失败，等待后重试...`, error.message)
      await new Promise(resolve => setTimeout(resolve, 500 * (i + 1)))
    }
  }
}

// 专辑封面 URL 进程级缓存：避免每次搜索都对前 15 个专辑重复拉取详情（放大上游请求）。
const NETEASE_ALBUM_COVER_CACHE_MAX = 1000
const neteaseAlbumCoverCache = new Map()

function getCachedNeteaseAlbumCover(albumId) {
  const key = String(albumId)
  const cached = neteaseAlbumCoverCache.get(key)
  if (!cached) return ''
  // 简单 LRU：命中时移到末尾，淘汰时删除最久未用的条目
  neteaseAlbumCoverCache.delete(key)
  neteaseAlbumCoverCache.set(key, cached)
  return cached
}

function cacheNeteaseAlbumCover(albumId, url) {
  const key = String(albumId)
  if (!key || !url) return
  if (neteaseAlbumCoverCache.size >= NETEASE_ALBUM_COVER_CACHE_MAX) {
    const oldestKey = neteaseAlbumCoverCache.keys().next().value
    if (oldestKey !== undefined) neteaseAlbumCoverCache.delete(oldestKey)
  }
  neteaseAlbumCoverCache.set(key, url)
}

// 网易云音乐 API 路由
app.get('/api/netease/search', async (req, res) => {
  try {
    const { keywords, limit = 30, type = '1' } = req.query
    if (!keywords) {
      return res.status(400).json({ error: '请提供搜索关键词' })
    }
    
    const devMode = req.query.devMode === 'true'
    
    // 添加搜索日志
    const typeNames = { '1': '歌曲', '10': '专辑', '100': '歌手', '1000': '歌单' }
    if (!NeteaseAPI || !NeteaseAPI.search) {
      return res.status(500).json({ error: 'API 未初始化' })
    }

    // 重试机制：最多尝试3次，每次失败后等待递增的时间
    let result
    let lastError
    const maxRetries = 3
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        result = await NeteaseAPI.search({
          keywords,
          limit,
          type
        })
        // 成功获取结果，跳出循环
        if (attempt > 1) {
        }
        break
      } catch (error) {
        lastError = error
        console.error(`[网易云音乐搜索] 第 ${attempt} 次尝试失败:`, error.message || error)
        
        // 如果是最后一次尝试，不再等待
        if (attempt < maxRetries) {
          const waitTime = attempt * 500 // 递增等待时间：500ms, 1000ms
          await new Promise(resolve => setTimeout(resolve, waitTime))
        }
      }
    }
    
    // 如果所有尝试都失败，抛出最后的错误
    if (!result) {
      throw lastError
    }
    
    // 记录搜索结果数量
    if (type === '100') {
    } else if (type === '10') {
    } else if (type === '1') {
    }
    
    // 网易云搜索API返回的album.picId会被JavaScript截断
    // 只获取前30个专辑封面，其余的由前端按需加载
    if (result.body?.result?.songs) {
      // 批量获取专辑详情
      const albumIds = [...new Set(result.body.result.songs.map(s => s.album?.id).filter(Boolean))]
      const albumDetails = {}
      // 只获取前15个专辑的封面
      const firstBatch = albumIds.slice(0, 15)
      const batchSize = 3
      for (let i = 0; i < firstBatch.length; i += batchSize) {
        const batch = firstBatch.slice(i, i + batchSize)
        await Promise.all(batch.map(async (albumId) => {
          try {
            await new Promise(resolve => setTimeout(resolve, 100)) // 每个请求前等待100ms
            const albumRes = await NeteaseAPI.album({
              id: albumId
            })
            if (albumRes.body?.album?.picUrl) {
              albumDetails[albumId] = albumRes.body.album.picUrl
            }
          } catch (err) {
            if (devMode) console.error(`✗ 获取专辑 ${albumId} 详情失败:`, err.message)
          }
        }))
        // 批次之间延迟200ms
        if (i + batchSize < firstBatch.length) {
          await new Promise(resolve => setTimeout(resolve, 200))
        }
      }
      
      if (devMode) console.log(`成功获取 ${Object.keys(albumDetails).length} 个专辑封面`)
      
      // 将封面URL添加到歌曲数据，并添加VIP和版权信息
      result.body.result.songs = result.body.result.songs.map(song => {
        if (song.album && albumDetails[song.album.id]) {
          song.album.picUrl = albumDetails[song.album.id]
        }
        
        // 添加VIP和版权标识
        // fee: 0免费 1VIP 4付费专辑 8低音质免费
        song.vip = song.fee === 1 || song.fee === 4
        // 无版权：privilege.st < 0 或 privilege.playMaxbr === 0
        song.noCopyright = song.privilege?.st < 0 || song.privilege?.playMaxbr === 0
        
        return song
      })
    }
    
    res.json(result.body)
  } catch (error) {
    console.error('搜索错误:', error)
    // 返回空结果而不是 500 错误，避免前端卡住
    const typeNames = { '1': 'songs', '10': 'albums', '100': 'artists', '1000': 'playlists' }
    const resultKey = typeNames[req.query.type] || 'songs'
    res.json({ result: { [resultKey]: [] } })
  }
})

// 获取网易云专辑详情
app.get('/api/netease/album', async (req, res) => {
  try {
    const { id } = req.query
    if (!id) {
      return res.status(400).json({ error: '请提供专辑ID' })
    }
    
    if (!NeteaseAPI || !NeteaseAPI.album) {
      return res.status(500).json({ error: 'API 未初始化' })
    }

    const result = await NeteaseAPI.album({ id })
    
    if (!result.body?.album) {
      return res.status(404).json({ error: '专辑不存在' })
    }

    const album = result.body.album
    const songs = result.body.songs || []
    
    res.json({
      album: {
        id: album.id,
        name: album.name,
        picUrl: album.picUrl,
        artist: album.artist || album.artists?.[0],
        publishTime: album.publishTime,
        size: album.size,
        description: album.description
      },
      songs: songs.map(song => ({
        id: song.id,
        name: song.name,
        artists: song.ar || song.artists,
        album: {
          id: album.id,
          name: album.name,
          picUrl: album.picUrl
        },
        duration: song.dt || song.duration,
        fee: song.fee,
        vip: song.fee === 1 || song.fee === 4,
        // 传递 privilege 对象给前端做准确判断
        privilege: song.privilege || {},
        platform: 'netease'
      }))
    })
  } catch (error) {
    console.error('获取专辑详情错误:', error)
    res.status(500).json({ error: error.message })
  }
})

// 批量获取网易云专辑封面
app.get('/api/netease/albums/covers', async (req, res) => {
  try {
    const { ids, devMode } = req.query
    if (!ids) {
      return res.status(400).json({ error: '请提供专辑ID列表' })
    }

    const isDev = devMode === 'true'
    
    if (!NeteaseAPI || !NeteaseAPI.album) {
      return res.status(500).json({ error: 'API 未初始化' })
    }

    const albumIds = ids.split(',').map(id => parseInt(id)).filter(Boolean)
    const albumCovers = {}
    
    if (isDev) console.log(`批量获取 ${albumIds.length} 个专辑封面`)
    
    // 串行获取，每次间隔300ms，避免被限流
    for (const albumId of albumIds) {
      try {
        await new Promise(resolve => setTimeout(resolve, 300)) // 延迟300ms
        const albumRes = await NeteaseAPI.album({ id: albumId })
        if (albumRes.body?.album?.picUrl) {
          albumCovers[albumId] = albumRes.body.album.picUrl
        }
      } catch (err) {
        if (isDev) console.error(`获取专辑 ${albumId} 封面失败:`, err.message)
      }
    }
    
    res.json({ covers: albumCovers })
  } catch (error) {
    console.error('批量获取封面错误:', error)
    res.status(500).json({ error: error.message, covers: {} })
  }
})

app.get('/api/netease/search/suggest', async (req, res) => {
  try {
    const { keywords } = req.query
    if (!keywords) {
      return res.status(400).json({ error: '请提供搜索关键词' })
    }
    
    if (!NeteaseAPI || !NeteaseAPI.search_suggest) {
      return res.status(500).json({ error: 'API 未初始化' })
    }

    const result = await NeteaseAPI.search_suggest({
      keywords,
      type: 'mobile',
    })
    
    // 格式化返回结果
    const suggestions = []
    
    // 添加歌曲建议
    if (result.body?.result?.allMatch) {
      result.body.result.allMatch.forEach(item => {
        suggestions.push({
          type: 'song',
          name: item.keyword,
          keyword: item.keyword
        })
      })
    }
    
    // 添加歌手建议
    if (result.body?.result?.artists) {
      result.body.result.artists.slice(0, 3).forEach(artist => {
        suggestions.push({
          type: 'artist',
          id: artist.id,
          name: artist.name,
          keyword: artist.name,
          picUrl: artist.picUrl,
          trans: artist.transNames?.[0] || artist.trans
        })
      })
    }
    
    // 限制最多10个建议
    res.json({ suggestions: suggestions.slice(0, 10) })
  } catch (error) {
    console.error('搜索建议错误:', error)
    res.status(500).json({ error: error.message, suggestions: [] })
  }
})

function getFallbackSourceLabel(value) {
  try {
    const hostname = new URL(value).hostname.toLowerCase()
    if (hostname.includes('qq.com') || hostname.includes('gtimg')) return 'QQ音乐'
    if (hostname.includes('kugou') || hostname.includes('kgimg')) return '酷狗音乐'
    if (hostname.includes('kuwo')) return '酷我音乐'
    if (hostname.includes('migu')) return '咪咕音乐'
    if (hostname.includes('bilibili')) return '哔哩哔哩'
    return '跨平台备用音源'
  } catch {
    return '跨平台备用音源'
  }
}

function isAllowedFallbackAudioUrl(value) {
  try {
    const url = new URL(String(value || ''))
    if (!['http:', 'https:'].includes(url.protocol)) return false

    const hostname = url.hostname.toLowerCase()
    if (hostname === 'localhost' || hostname === '::1' || hostname.endsWith('.local')) return false
    if (/^(0|10|127|169\.254|192\.168)\./.test(hostname)) return false
    const private172 = /^172\.(\d+)\./.exec(hostname)
    if (private172 && Number(private172[1]) >= 16 && Number(private172[1]) <= 31) return false
    return true
  } catch {
    return false
  }
}


const AUDIO_QUALITY_PREFERENCES = new Set(['auto', 'standard', 'high', 'very-high', 'lossless', 'hi-res'])

function normalizeAudioQualityPreference(value) {
  return AUDIO_QUALITY_PREFERENCES.has(String(value || 'auto')) ? String(value || 'auto') : 'auto'
}


function getNeteaseQualityCandidates(preference, isVip) {
  const free = ['exhigh', 'standard']
  if (!isVip) {
    if (preference === 'standard') return ['standard']
    return free
  }
  switch (preference) {
    case 'standard': return ['standard']
    case 'high': return ['exhigh', 'standard']
    case 'very-high':
    case 'lossless': return ['lossless', 'exhigh', 'standard']
    case 'hi-res': return ['hires', 'lossless', 'exhigh', 'standard']
    case 'auto':
    default: return ['jymaster', 'hires', 'lossless', 'exhigh', 'standard']
  }
}

function getQQQualityCandidates(preference, isVip) {
  if (!isVip) {
    if (preference === 'standard') return ['128', 'm4a']
    return ['320', '128', 'm4a']
  }
  switch (preference) {
    case 'standard': return ['128', 'm4a']
    case 'high': return ['320', '128', 'm4a']
    case 'very-high':
    case 'lossless':
    case 'hi-res': return ['flac', '320', '128', 'm4a']
    case 'auto':
    default: return ['flac', '320', '128', 'm4a']
  }
}

function getQQFilename(songMid, quality) {
  const filenameMap = {
    m4a: 'C400' + songMid + '.m4a',
    '128': 'M500' + songMid + '.mp3',
    '320': 'M800' + songMid + '.mp3',
    flac: 'F000' + songMid + '.flac',
    ape: 'A000' + songMid + '.ape',
  }
  return filenameMap[quality] || filenameMap.m4a
}

const QQ_PLAYBACK_METADATA_TTL = 30 * 60 * 1000
const QQ_PLAYBACK_METADATA_MAX_ENTRIES = 512
const qqPlaybackMetadataCache = new Map()
const qqPlaybackMetadataPending = new Map()

function cacheQQPlaybackMetadata(songMid, metadata) {
  const now = Date.now()
  for (const [key, entry] of qqPlaybackMetadataCache) {
    if (entry.expiresAt <= now) qqPlaybackMetadataCache.delete(key)
  }
  qqPlaybackMetadataCache.delete(songMid)
  qqPlaybackMetadataCache.set(songMid, {
    metadata,
    expiresAt: now + QQ_PLAYBACK_METADATA_TTL,
  })
  while (qqPlaybackMetadataCache.size > QQ_PLAYBACK_METADATA_MAX_ENTRIES) {
    const oldestKey = qqPlaybackMetadataCache.keys().next().value
    if (oldestKey === undefined) break
    qqPlaybackMetadataCache.delete(oldestKey)
  }
}

async function getQQPlaybackMetadata(songMid) {
  const now = Date.now()
  const cached = qqPlaybackMetadataCache.get(songMid)
  if (cached?.expiresAt > now) {
    qqPlaybackMetadataCache.delete(songMid)
    qqPlaybackMetadataCache.set(songMid, cached)
    return cached.metadata
  }
  if (cached) qqPlaybackMetadataCache.delete(songMid)

  const pending = qqPlaybackMetadataPending.get(songMid)
  if (pending) return pending

  const request = (async () => {
    const detail = await withTimeout(
      qqMusicApi.api('song', { songmid: songMid }),
      6000,
      'QQ song metadata timeout',
    )
    const track = detail?.track_info || detail?.data?.track_info || detail?.data || detail
    const file = track?.file || null
    const metadata = {
      file,
      mediaMid: String(file?.media_mid || track?.media_mid || songMid),
      songType: Number(track?.type ?? track?.songtype ?? track?.songType) || 0,
    }
    cacheQQPlaybackMetadata(songMid, metadata)
    return metadata
  })()
  qqPlaybackMetadataPending.set(songMid, request)
  try {
    return await request
  } finally {
    if (qqPlaybackMetadataPending.get(songMid) === request) {
      qqPlaybackMetadataPending.delete(songMid)
    }
  }
}

app.get('/api/netease/song/url', async (req, res) => {
  try {
    const { id, cookie } = req.query
    const fallbackEnabled = req.query.fallback === 'true'
    const qualityPreference = normalizeAudioQualityPreference(req.query.quality)
    const isVip = req.query.vip === 'true'
    if (!id) return res.status(400).json({ error: '\u8bf7\u63d0\u4f9b\u6b4c\u66f2ID' })

    if (!NeteaseAPI || !NeteaseAPI.song_url_v1) {
      return res.status(500).json({ error: 'API \u672a\u521d\u59cb\u5316' })
    }

    const candidates = getNeteaseQualityCandidates(qualityPreference, isVip)
    let lastError = null
    let officialBody = null
    let actualQuality = null

    const officialDeadlineAt = Date.now() + (fallbackEnabled ? 8000 : 16000)
    qualityLoop: for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex += 1) {
      const level = candidates[candidateIndex]
      const attempts = candidateIndex === 0 ? 2 : 1
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        const remaining = officialDeadlineAt - Date.now()
        if (remaining <= 300) break qualityLoop
        try {
          console.log('[Netease URL] quality ' + level + ' (' + (attempt + 1) + '/' + attempts + '), song: ' + id)
          const params = { id, level }
          if (cookie) params.cookie = cookie
          const result = await withTimeout(
            NeteaseAPI.song_url_v1(params),
            Math.max(300, Math.min(4500, remaining)),
            'Netease song URL timeout',
          )
          if (result?.body) {
            officialBody = result.body
            const item = result.body?.data?.[0]
            if (item?.url) {
              actualQuality = item.level || level
              return res.json({
                ...result.body,
                fallback: false,
                source: '\u7f51\u6613\u4e91\u97f3\u4e50',
                qualityPreference,
                requestedQuality: level,
                actualQuality,
              })
            }
            break
          }
        } catch (error) {
          lastError = error
          console.warn('[Netease URL] quality ' + level + ' attempt ' + (attempt + 1) + ' failed:', error.message)
          if (attempt + 1 < attempts && officialDeadlineAt - Date.now() > 500) {
            await new Promise(resolve => setTimeout(resolve, 150))
          }
        }
      }
    }

    if (!fallbackEnabled) {
      if (officialBody) return res.json({ ...officialBody, fallback: false, source: '\u7f51\u6613\u4e91\u97f3\u4e50', qualityPreference, actualQuality })
      return res.status(500).json({ error: lastError?.message || '\u83b7\u53d6\u64ad\u653e\u94fe\u63a5\u5931\u8d25', code: 500, qualityPreference })
    }

    try {
      if (!NeteaseAPI.song_detail || !NeteaseAPI.song_url_match) {
        throw new Error('\u5f53\u524d\u7f51\u6613\u4e91 API \u4e0d\u652f\u6301\u8de8\u5e73\u53f0\u5907\u7528\u97f3\u6e90')
      }

      const detailResult = await withTimeout(
        NeteaseAPI.song_detail({ ids: String(id) }),
        4000,
        '\u6b4c\u66f2\u6743\u9650\u68c0\u67e5\u8d85\u65f6',
      )
      const song = detailResult?.body?.songs?.[0] || {}
      const privilege = detailResult?.body?.privileges?.[0] || song.privilege || {}
      const fee = Number(song.fee ?? privilege.fee ?? officialBody?.data?.[0]?.fee ?? 0)
      if (fee === 1 || fee === 4) {
        console.info('[Netease URL] paid content, cross-platform fallback blocked: ' + id)
        return res.json({
          ...(officialBody || { code: 200, data: [{ id: Number(id), url: null, fee }] }),
          fallback: false,
          fallbackBlocked: 'paid-content',
          source: '\u7f51\u6613\u4e91\u97f3\u4e50',
          qualityPreference,
        })
      }

      const matchResult = await withTimeout(
        NeteaseAPI.song_url_match({ id: String(id) }),
        8000,
        '\u5907\u7528\u97f3\u6e90\u5339\u914d\u8d85\u65f6',
      )
      const matchedUrl = typeof matchResult?.body?.data === 'string'
        ? matchResult.body.data
        : matchResult?.body?.data?.url
      if (!isAllowedFallbackAudioUrl(matchedUrl)) throw new Error('\u5907\u7528\u97f3\u6e90\u6ca1\u6709\u8fd4\u56de\u5b89\u5168\u7684\u516c\u5f00\u64ad\u653e\u5730\u5740')

      const source = getFallbackSourceLabel(matchedUrl)
      console.info('[Netease URL] fallback source for ' + id + ': ' + source)
      return res.json({
        code: 200,
        data: [{ id: Number(id), url: matchedUrl, br: 0, size: 0, md5: '', code: 200, expi: 600, type: 'fallback', level: 'fallback', fee: 0, freeTrialInfo: null }],
        fallback: true,
        source,
        matchedBy: 'NeteaseCloudMusicApiEnhanced',
        qualityPreference,
      })
    } catch (fallbackError) {
      console.warn('[Netease URL] fallback failed for ' + id + ':', fallbackError.message)
      if (officialBody) return res.json({ ...officialBody, fallback: false, fallbackAttempted: true, source: '\u7f51\u6613\u4e91\u97f3\u4e50', qualityPreference })
      return res.status(502).json({ error: lastError?.message || fallbackError.message || '\u83b7\u53d6\u64ad\u653e\u94fe\u63a5\u5931\u8d25', code: 502, fallbackAttempted: true, qualityPreference })
    }
  } catch (error) {
    console.error('[Netease URL] unexpected error:', error)
    return res.status(500).json({ error: error.message })
  }
})

app.get('/api/netease/lyric', async (req, res) => {
  try {
    const { id } = req.query
    if (!id) {
      return res.status(400).json({ error: '请提供歌曲ID' })
    }

    if (!NeteaseAPI || !NeteaseAPI.lyric_new) {
      return res.status(500).json({ error: 'API 未初始化' })
    }

    // 增强重试机制：更多次数，更长超时，指数退避
    let lastError = null
    const retries = 5 // 从 3 次增加到 5 次
    const delays = [300, 600, 1200, 2400, 4800] // 指数退避
    
    for (let i = 0; i < retries; i++) {
      try {
        console.log(`[歌词API] 尝试获取歌词 (${i + 1}/${retries})，歌曲ID: ${id}`)
        
        const result = await withTimeout(NeteaseAPI.lyric_new({ id }), 10000)
        
        // 检查结果是否有效
        if (result && result.body) {
          return res.json(result.body)
        }
      } catch (error) {
        lastError = error
        console.warn(`[歌词API] ❌ 第 ${i + 1} 次尝试失败:`, error.message)
        
        // 如果不是最后一次尝试，使用指数退避重试
        if (i < retries - 1) {
          const delay = delays[i]
          await new Promise(resolve => setTimeout(resolve, delay))
        }
      }
    }
    
    // 所有重试都失败，返回空歌词（200状态码，让前端尝试其他来源）
    console.error(`[歌词API] ⚠️ 所有 ${retries} 次重试均失败，歌曲ID: ${id}，返回空歌词`)
    res.status(200).json({ 
      code: 200,
      // 返回空歌词结构，前端会尝试其他来源
      lrc: { lyric: '' },
      tlyric: { lyric: '' },
      yrc: { lyric: '' },
      romalrc: { lyric: '' }
    })
  } catch (error) {
    console.error('[歌词API] ❌ 获取歌词错误:', error)
    res.status(200).json({ 
      code: 200,
      lrc: { lyric: '' },
      tlyric: { lyric: '' },
      yrc: { lyric: '' },
      romalrc: { lyric: '' }
    })
  }
})

// 网易云热榜API
app.get('/api/netease/top/song', async (req, res) => {
  try {
    if (!NeteaseAPI || !NeteaseAPI.playlist_detail) {
      return res.status(500).json({ error: 'API 未初始化' })
    }

    const { type = '0' } = req.query
    
    // 根据 type 参数选择不同的榜单
    // type=0: 热歌榜 (id: 3778678)
    // type=1: 飙升榜 (id: 19723756)
    const playlistId = type === '1' ? 19723756 : 3778678
    const rankName = type === '1' ? '飙升榜' : '热歌榜'
    // 添加重试机制
    let retries = 3
    let lastError = null
    
    while (retries > 0) {
      try {
        const result = await NeteaseAPI.playlist_detail({ id: playlistId })
        
        if (result.body?.playlist?.tracks) {
          res.json({ 
            code: 200,
            data: result.body.playlist.tracks,
            playlistId: playlistId // 返回歌单ID以便调试
          })
          return
        } else {
          console.warn(`[网易云${rankName}] 返回数据为空`)
          res.json({ code: 200, data: [], playlistId: playlistId })
          return
        }
      } catch (error) {
        lastError = error
        retries--
        console.warn(`[网易云${rankName}] 请求失败，剩余重试次数: ${retries}`, error.message)
        if (retries > 0) {
          await new Promise(resolve => setTimeout(resolve, 1000)) // 等待1秒后重试
        }
      }
    }
    
    // 所有重试都失败
    throw lastError
  } catch (error) {
    console.error('获取热榜错误:', error)
    res.status(502).json({ 
      code: 502,
      msg: error.message || 'read ECONNRESET'
    })
  }
})

// 网易云推荐新歌API
app.get('/api/netease/personalized/newsong', async (req, res) => {
  try {
    const { limit = 20 } = req.query
    
    if (!NeteaseAPI || !NeteaseAPI.personalized_newsong) {
      return res.status(500).json({ error: 'API 未初始化' })
    }

    const result = await NeteaseAPI.personalized_newsong({ limit })
    res.json(result.body)
  } catch (error) {
    console.error('获取推荐新歌错误:', error)
    res.status(500).json({ error: error.message })
  }
})

// 网易云登录相关 API
app.get('/api/netease/login/qr/key', async (req, res) => {
  try {
    if (!NeteaseAPI || !NeteaseAPI.login_qr_key) {
      return res.status(500).json({ error: 'API 未初始化' })
    }
    
    // 添加重试机制
    let lastError = null
    for (let i = 0; i < 3; i++) {
      try {
        const result = await NeteaseAPI.login_qr_key()
        return res.json(result.body)
      } catch (err) {
        lastError = err
        console.warn(`获取二维码key失败 (尝试 ${i + 1}/3):`, err.message)
        if (i < 2) {
          await new Promise(resolve => setTimeout(resolve, 1000)) // 等待1秒后重试
        }
      }
    }
    throw lastError
  } catch (error) {
    console.error('获取二维码key错误:', error)
    res.status(500).json({ error: error.message || '网络连接失败，请稍后重试' })
  }
})

app.get('/api/netease/login/qr/create', async (req, res) => {
  try {
    const { key } = req.query
    if (typeof key !== 'string' || !key) {
      return res.status(400).json({ error: '请提供key' })
    }
    if (!NeteaseAPI || !NeteaseAPI.login_qr_create) {
      return res.status(500).json({ error: 'API 未初始化' })
    }
    
    // 添加重试机制
    let lastError = null
    for (let i = 0; i < 3; i++) {
      try {
        const result = await NeteaseAPI.login_qr_create({ key, qrimg: true })
        return res.json(result.body)
      } catch (err) {
        lastError = err
        console.warn(`创建二维码失败 (尝试 ${i + 1}/3):`, err.message)
        if (i < 2) {
          await new Promise(resolve => setTimeout(resolve, 1000))
        }
      }
    }
    throw lastError
  } catch (error) {
    console.error('创建二维码错误:', error)
    res.status(500).json({ error: error.message || '网络连接失败，请稍后重试' })
  }
})

app.get('/api/netease/login/qr/check', async (req, res) => {
  try {
    const { key } = req.query
    if (typeof key !== 'string' || !key) {
      return res.status(400).json({ error: '请提供key' })
    }
    if (!NeteaseAPI || !NeteaseAPI.login_qr_check) {
      return res.status(500).json({ error: 'API 未初始化' })
    }
    
    // 轮询检查不需要重试，直接返回错误让前端继续轮询
    const result = await NeteaseAPI.login_qr_check({ key })
    if (result && result.body) {
      res.json(result.body)
    } else {
      // 如果没有返回结果，返回等待扫码状态
      res.json({ code: 801, message: '等待扫码' })
    }
  } catch (error) {
    console.error('检查登录状态错误:', error)
    // 返回「已过期」而非「等待扫码」：网络失败/参数错误时不能让前端无限轮询假装在等待，
    // 前端会显示「二维码已过期,请点击刷新」让用户手动重试
    res.json({ code: 800, message: '检查登录状态失败，请刷新二维码' })
  }
})

app.get('/api/netease/login/status', async (req, res) => {
  try {
    const { cookie } = req.query
    if (!NeteaseAPI || !NeteaseAPI.login_status) {
      return res.status(500).json({ error: 'API 未初始化' })
    }
    const result = await NeteaseAPI.login_status({ cookie: typeof cookie === 'string' ? cookie : '' })
    if (result && result.body) {
      res.json(result.body)
    } else {
      res.status(502).json({ error: '登录状态查询失败' })
    }
  } catch (error) {
    console.error('获取登录状态错误:', error)
    res.status(500).json({ error: error.message })
  }
})

// 获取用户账号信息
app.get('/api/netease/user/account', async (req, res) => {
  try {
    const cookie = req.headers.cookie || req.query.cookie
    if (!cookie) {
      return res.status(400).json({ error: '请提供Cookie' })
    }
    if (!NeteaseAPI || !NeteaseAPI.user_account) {
      return res.status(500).json({ error: 'API 未初始化' })
    }
    const result = await NeteaseAPI.user_account({ cookie })
    res.json(result.body)
  } catch (error) {
    console.error('获取用户账号信息错误:', error)
    res.status(500).json({ error: error.message })
  }
})

// 获取用户歌单
app.get('/api/netease/user/playlist', async (req, res) => {
  try {
    const { uid, cookie } = req.query
    if (!uid) {
      return res.status(400).json({ error: '请提供用户ID' })
    }
    if (!NeteaseAPI || !NeteaseAPI.user_playlist) {
      return res.status(500).json({ error: 'API 未初始化' })
    }
    const result = await NeteaseAPI.user_playlist({ uid, cookie })
    res.json(result.body)
  } catch (error) {
    console.error('获取用户歌单错误:', error)
    res.status(500).json({ error: error.message })
  }
})

// 获取用户详情
// 获取网易云音乐平台同步的最近播放内容。
const NETEASE_RECENT_PLAYLIST_COUNT_TTL = 10 * 60 * 1000
const NETEASE_RECENT_PLAYLIST_COUNT_CACHE_MAX = 500
const neteaseRecentPlaylistCountCache = new Map()

function getCachedNeteaseRecentPlaylistCount(id) {
  const key = String(id)
  const cached = neteaseRecentPlaylistCountCache.get(key)
  if (!cached) return 0
  if (cached.expiresAt <= Date.now()) {
    neteaseRecentPlaylistCountCache.delete(key)
    return 0
  }
  return Number(cached.count) || 0
}

function cacheNeteaseRecentPlaylistCount(id, count) {
  const normalizedCount = Number(count) || 0
  if (!id || normalizedCount <= 0) return
  if (neteaseRecentPlaylistCountCache.size >= NETEASE_RECENT_PLAYLIST_COUNT_CACHE_MAX) {
    const now = Date.now()
    for (const [key, value] of neteaseRecentPlaylistCountCache) {
      if (value.expiresAt <= now) neteaseRecentPlaylistCountCache.delete(key)
    }
    if (neteaseRecentPlaylistCountCache.size >= NETEASE_RECENT_PLAYLIST_COUNT_CACHE_MAX) {
      const oldestKey = neteaseRecentPlaylistCountCache.keys().next().value
      if (oldestKey !== undefined) neteaseRecentPlaylistCountCache.delete(oldestKey)
    }
  }
  neteaseRecentPlaylistCountCache.set(String(id), {
    count: normalizedCount,
    expiresAt: Date.now() + NETEASE_RECENT_PLAYLIST_COUNT_TTL
  })
}

async function enrichNeteaseRecentPlaylistCounts(payload, cookie = '') {
  const rows = Array.isArray(payload?.data?.list)
    ? payload.data.list
    : Array.isArray(payload?.data)
      ? payload.data
      : Array.isArray(payload?.list)
        ? payload.list
        : []
  const pending = rows.filter(row => {
    const resource = row?.resource || row?.data || row
    const count = Number(
      resource?.trackCount ?? resource?.trackNumber ?? resource?.trackNum ?? resource?.size ?? 0
    ) || (Array.isArray(resource?.tracks) ? resource.tracks.length : 0)
      || (Array.isArray(resource?.trackIds) ? resource.trackIds.length : 0)
    return count <= 0 && (row?.resourceId || resource?.id)
  })
  if (pending.length === 0 || !NeteaseAPI?.playlist_detail) return payload

  let cursor = 0
  // 路由级总 deadline：超时未完成的批次直接返回已有结果，避免整个最近播放
  // 响应被拖到上游限流窗口之外。
  const deadlineAt = Date.now() + 15000
  const worker = async () => {
    while (cursor < pending.length) {
      if (Date.now() >= deadlineAt) break
      const row = pending[cursor]
      cursor += 1
      const resource = row?.resource || row?.data || row
      const id = String(row?.resourceId || resource?.id || '')
      if (!id) continue
      const cachedCount = getCachedNeteaseRecentPlaylistCount(id)
      if (cachedCount > 0) {
        resource.trackCount = cachedCount
        continue
      }
      try {
        const result = await callNeteaseAPIWithRetry(NeteaseAPI.playlist_detail, {
          id,
          s: 0,
          cookie: String(cookie || '')
        }, 2, 10000)
        const playlist = result?.body?.playlist || {}
        const count = Number(
          playlist?.trackCount ?? playlist?.trackNumber ?? playlist?.trackNum ?? playlist?.size ?? 0
        ) || (Array.isArray(playlist?.trackIds) ? playlist.trackIds.length : 0)
          || (Array.isArray(playlist?.tracks) ? playlist.tracks.length : 0)
        if (count > 0) {
          resource.trackCount = count
          cacheNeteaseRecentPlaylistCount(id, count)
        }
      } catch (error) {
        console.warn(`[Netease recent playlists] Failed to enrich track count for ${id}:`, error?.message || error)
      }
    }
  }

  // Recent history has at most 100 entries. Keep metadata lookups bounded:
  // 并发降到 3，配合总 deadline 控制上游调用量与限流风险。
  await Promise.all(Array.from({ length: Math.min(3, pending.length) }, () => worker()))
  return payload
}

// /record/recent/* 是网易云官方 API 的账号级记录，不使用本地播放历史。
app.get('/api/netease/record/recent/:type', async (req, res) => {
  try {
    const { type } = req.params
    const { limit = 100, cookie } = req.query
    const apiName = {
      song: 'record_recent_song',
      playlist: 'record_recent_playlist',
      album: 'record_recent_album',
      dj: 'record_recent_dj',
      voice: 'record_recent_voice',
      video: 'record_recent_video'
    }[String(type)]
    if (!apiName) return res.status(400).json({ code: 400, error: '不支持的最近播放类型' })
    if (!cookie) return res.status(401).json({ code: 301, error: '请先登录网易云音乐' })
    if (!NeteaseAPI || typeof NeteaseAPI[apiName] !== 'function') {
      return res.status(500).json({ code: 500, error: '网易云最近播放 API 未初始化' })
    }
    const result = await callNeteaseAPIWithRetry(NeteaseAPI[apiName], {
      limit: Math.max(1, Math.min(Number(limit) || 100, 100)),
      cookie: String(cookie)
    })
    const body = result.body || result
    if (String(type) === 'playlist') {
      await enrichNeteaseRecentPlaylistCounts(body, String(cookie))
    }
    res.setHeader('Cache-Control', 'private, no-store')
    res.json(body)
  } catch (error) {
    console.error(`[网易云最近播放:${req.params.type}] 获取失败:`, error)
    res.status(502).json({ code: 502, error: error.message || '获取最近播放失败' })
  }
})

const getNeteaseJourneyBody = (result) => result?.body || result || {}

async function fetchNeteaseJourneyPart(apiName, params) {
  if (!NeteaseAPI || typeof NeteaseAPI[apiName] !== 'function') {
    return { available: false, error: `网易云 ${apiName} API 未初始化`, data: null }
  }
  try {
    const result = await callNeteaseAPIWithRetry(NeteaseAPI[apiName], params, 2, 12000)
    const body = getNeteaseJourneyBody(result)
    const code = Number(body?.code)
    if (Number.isFinite(code) && code !== 200) {
      return {
        available: false,
        error: body?.message || body?.msg || `网易云接口返回 ${code}`,
        data: body,
      }
    }
    return { available: true, error: '', data: body }
  } catch (error) {
    return { available: false, error: error?.message || '请求失败', data: null }
  }
}

function getNeteaseJourneyRows(payload, preferredKeys = []) {
  for (const key of preferredKeys) {
    const value = payload?.[key]
    if (Array.isArray(value)) return value
  }
  const candidates = [
    payload?.data?.list,
    payload?.data?.songs,
    payload?.data?.records,
    payload?.data,
    payload?.list,
    payload?.songs,
    payload?.records,
  ]
  return candidates.find(Array.isArray) || []
}

function normalizeNeteaseJourneySongs(payload, preferredKeys = []) {
  return getNeteaseJourneyRows(payload, preferredKeys)
    .map((row, index) => {
      const song = normalizeNeteaseExploreSong(row?.song || row?.track || row?.resource || row)
      if (!song) return null
      return {
        ...song,
        rank: Number(row?.rank || row?.order || index + 1),
        playCount: Number(row?.playCount ?? row?.count ?? row?.playTimes ?? row?.score ?? 0),
        score: Number(row?.score ?? 0),
      }
    })
    .filter(Boolean)
}

// 网易云音乐旅程：所有数据均来自当前登录账号的官方用户接口。
// 单项接口失败时保留其他卡片，避免一个实验性统计接口拖垮整个探索页。
app.get('/api/netease/journey/overview', async (req, res) => {
  try {
    const { uid, cookie } = req.query
    if (!cookie) return res.status(401).json({ code: 301, error: '请先登录网易云音乐' })
    if (!uid) return res.status(400).json({ code: 400, error: '缺少网易云用户 ID' })

    const auth = { cookie: String(cookie) }
    const [record, total, report, monthlyRank, todayRank, preference, level, subcount] = await Promise.all([
      fetchNeteaseJourneyPart('user_record', { ...auth, uid: String(uid), type: 0 }),
      fetchNeteaseJourneyPart('listen_data_total', auth),
      fetchNeteaseJourneyPart('listen_data_report', { ...auth, type: 'month' }),
      fetchNeteaseJourneyPart('listen_data_song_play_rank', { ...auth, type: 'month' }),
      fetchNeteaseJourneyPart('listen_data_today_song', auth),
      fetchNeteaseJourneyPart('style_preference', auth),
      fetchNeteaseJourneyPart('user_level', auth),
      fetchNeteaseJourneyPart('user_subcount', auth),
    ])

    const recordSongs = normalizeNeteaseJourneySongs(record.data, ['allData', 'weekData'])
    const monthlySongs = normalizeNeteaseJourneySongs(monthlyRank.data, ['songPlayRank', 'rankList'])
    const todaySongs = normalizeNeteaseJourneySongs(todayRank.data, ['songPlayRank', 'rankList'])

    res.setHeader('Cache-Control', 'private, no-store')
    res.json({
      code: 200,
      uid: String(uid),
      rank: { ...record, songs: recordSongs },
      report: {
        available: total.available || report.available || monthlyRank.available || todayRank.available,
        error: [total.error, report.error, monthlyRank.error, todayRank.error].filter(Boolean).join('；'),
        total: total.data,
        period: report.data,
        monthlyRank: monthlyRank.data,
        todayRank: todayRank.data,
        monthlySongs,
        todaySongs,
      },
      preference,
      archive: {
        available: level.available || subcount.available,
        error: [level.error, subcount.error].filter(Boolean).join('；'),
        level: level.data,
        subcount: subcount.data,
      },
    })
  } catch (error) {
    console.error('[网易云旅程概览] 处理异常:', error?.stack || error)
    res.status(500).json({ code: 500, error: error?.message || '获取旅程概览失败' })
  }
})

app.post('/api/netease/record/recent/report', async (req, res) => {
  try {
    const { cookie, songId, sourceId, playedSeconds } = req.body || {}
    if (!cookie) return res.status(401).json({ code: 301, error: '请先登录网易云音乐' })
    if (!songId) return res.status(400).json({ code: 400, error: '缺少歌曲 ID' })
    if (!NeteaseAPI || typeof NeteaseAPI.scrobble !== 'function') {
      return res.status(500).json({ code: 500, error: '网易云最近播放 API 未初始化' })
    }

    const result = await NeteaseAPI.scrobble({
      id: String(songId),
      sourceid: String(sourceId || songId),
      time: Math.max(1, Math.floor(Number(playedSeconds) || 1)),
      cookie: String(cookie)
    })
    const body = result?.body || result || {}
    res.setHeader('Cache-Control', 'private, no-store')
    res.json({ code: Number(body?.code || 200), synced: Number(body?.code || 200) === 200 })
  } catch (error) {
    console.warn('[Netease recent report] Request failed:', error?.message || String(error))
    res.status(502).json({ code: 502, synced: false, error: error?.message || '同步网易云最近播放失败' })
  }
})

app.get('/api/netease/user/detail', async (req, res) => {
  try {
    const { uid } = req.query
    if (!uid) {
      return res.status(400).json({ error: '请提供用户ID' })
    }
    if (!NeteaseAPI || !NeteaseAPI.user_detail) {
      return res.status(500).json({ error: 'API 未初始化' })
    }
    const result = await NeteaseAPI.user_detail({ uid })
    res.json(result.body)
  } catch (error) {
    console.error('获取用户详情错误:', error)
    res.status(500).json({ error: error.message })
  }
})

// 获取歌单详情
app.get('/api/netease/playlist/detail', async (req, res) => {
  try {
    const { id, limit, offset, cookie } = req.query
    if (!id) {
      return res.status(400).json({ error: '请提供歌单ID' })
    }
    if (!NeteaseAPI || !NeteaseAPI.playlist_track_all) {
      return res.status(500).json({ error: 'API 未初始化' })
    }
    
    const hasPaging = limit !== undefined || offset !== undefined
    const songLimit = limit ? Math.max(1, Math.min(parseInt(limit), 500)) : 10000
    const songOffset = offset ? Math.max(0, parseInt(offset)) : 0
    
    // 重试机制：最多尝试3次
    let lastError = null
    for (let i = 0; i < 3; i++) {
      try {
        if (hasPaging) {
          const page = await fetchNeteasePlaylistTrackPage(id, cookie, songOffset, songLimit)
          return res.json({
            playlist: {
              id: String(id),
              tracks: page.tracks,
              trackCount: page.total
            },
            offset: page.offset,
            limit: page.limit,
            nextOffset: page.nextOffset,
            more: page.more
          })
        }

        console.log(`[歌单详情API] 尝试获取完整歌单 (${i + 1}/3)，歌单ID: ${id}, 限制: ${songLimit}`)
        const songs = await fetchNeteasePlaylistTracks(id, cookie, Math.min(songLimit, 10000))

        // 检查结果是否有效
        if (Array.isArray(songs)) {
          // 元数据（播放次数/创建者/标签）：best-effort 补一次 playlist_detail，失败不影响歌曲列表
          let meta = null
          try {
            meta = (await NeteaseAPI.playlist_detail({ id }))?.body?.playlist || null
          } catch (metaError) {
            console.warn('[歌单详情API] 元数据获取失败（不影响歌曲）:', metaError?.message)
          }
          // 构造与原 API 相同的返回格式
          const response = {
            playlist: {
              id: id,
              tracks: songs,
              trackCount: Number(meta?.trackCount || songs.length),
              name: meta?.name || '',
              coverImgUrl: meta?.coverImgUrl || '',
              description: normalizePlaylistDescription(meta?.description || ''),
              playCount: Number(meta?.playCount || 0),
              tags: Array.isArray(meta?.tags) ? meta.tags : [],
              createTime: Number(meta?.createTime || 0) || undefined,
              creator: meta?.creator ? {
                userId: meta.creator.userId,
                nickname: meta.creator.nickname || '',
                avatarUrl: meta.creator.avatarUrl || ''
              } : undefined
            }
          }

          return res.json(response)
        }
      } catch (error) {
        lastError = error
        console.warn(`[歌单详情API] 第 ${i + 1} 次尝试失败:`, error.message)
        
        // 如果不是最后一次尝试，等待一段时间后重试
        if (i < 2) {
          await new Promise(resolve => setTimeout(resolve, 500 * (i + 1)))
        }
      }
    }
    
    // 所有重试都失败
    console.error('[歌单详情API] ❌ 所有重试均失败，歌单ID:', id)
    res.status(500).json({ 
      error: lastError?.message || '获取歌单详情失败',
      playlist: null
    })
  } catch (error) {
    console.error('获取歌单详情错误:', error)
    res.status(500).json({ error: error.message })
  }
})

app.get('/api/netease/song/detail', async (req, res) => {
  try {
    const { ids } = req.query
    if (!ids) {
      return res.status(400).json({ error: '请提供歌曲ID' })
    }

    if (!NeteaseAPI || !NeteaseAPI.song_detail) {
      return res.status(500).json({ error: 'API 未初始化' })
    }

    const result = await NeteaseAPI.song_detail({ ids })

    // 补充音质等级（song_music_detail）与专辑扩展信息（唱片公司/专辑类型）
    const body = result.body || result
    const song = body.songs?.[0]
    if (song) {
      try {
        const qualityRes = await NeteaseAPI.song_music_detail({ id: String(song.id) })
        const qd = qualityRes.body?.data || {}
        const qualityLevels = []
        const pushLevel = (key, label, br) => {
          if (qd[key]) qualityLevels.push({ key, label, br: qd[key].br, size: qd[key].size, sr: qd[key].sr })
        }
        if (qd.hr) pushLevel('hr', 'Hi-Res 无损', qd.hr.br)
        if (qd.sq) pushLevel('sq', '无损 FLAC', qd.sq.br)
        if (qd.db) pushLevel('db', '杜比全景声', qd.db.br)
        if (qd.jm) pushLevel('jm', '臻品母带', qd.jm.br)
        if (qd.je) pushLevel('je', '臻品全景声', qd.je.br)
        if (qd.h) pushLevel('h', '高品质', qd.h.br)
        if (qd.m) pushLevel('m', '标准', qd.m.br)
        if (qd.l) pushLevel('l', '普通', qd.l.br)
        // 按码率从高到低排序，避免杜比/臻品顺序混乱
        qualityLevels.sort((a, b) => (b.br || 0) - (a.br || 0))
        song.qualityLevels = qualityLevels
      } catch (qualityError) {
        console.warn('[网易云音质详情] 获取失败:', qualityError?.message || qualityError)
      }
      try {
        const albumRes = await NeteaseAPI.album({ id: String(song.al?.id || '') })
        const alb = albumRes.body?.album || {}
        if (alb.id) {
          song.albumExtra = {
            company: alb.company || '',
            subType: alb.subType || '',
            type: alb.type || '',
            publishTime: alb.publishTime || song.publishTime,
          }
        }
      } catch (albumError) {
        console.warn('[网易云专辑信息] 获取失败:', albumError?.message || albumError)
      }
    }

    res.json(body)
  } catch (error) {
    console.error('获取歌曲详情错误:', error)
    res.status(500).json({ error: error.message })
  }
})

// 获取每日推荐歌曲（需要登录）
app.get('/api/netease/recommend/songs', async (req, res) => {
  try {
    const { cookie } = req.query
    
    if (!cookie) {
      return res.status(401).json({ code: 301, message: '需要登录' })
    }

    if (!NeteaseAPI || !NeteaseAPI.recommend_songs) {
      return res.status(500).json({ error: 'API 未初始化' })
    }
    const result = await NeteaseAPI.recommend_songs({ cookie })
    res.json(result.body)
  } catch (error) {
    console.error('[网易云每日推荐] 获取错误:', error)
    res.status(500).json({ error: error.message })
  }
})

// 获取私人FM（需要登录）
app.get('/api/netease/personal_fm', async (req, res) => {
  try {
    const { cookie } = req.query
    
    if (!cookie) {
      return res.status(401).json({ code: 301, message: '需要登录' })
    }

    if (!NeteaseAPI || !NeteaseAPI.personal_fm) {
      return res.status(500).json({ error: 'API 未初始化' })
    }
    const result = await fetchNeteasePersonalFmBatches(cookie, 30)
    res.json(result.body)
  } catch (error) {
    console.error('[网易云私人雷达] 获取错误:', error)
    res.status(500).json({ error: error.message })
  }
})

// 获取推荐歌单（需要登录）
app.get('/api/netease/recommend/resource', async (req, res) => {
  try {
    const { cookie } = req.query
    
    if (!cookie) {
      return res.status(401).json({ code: 301, message: '需要登录' })
    }

    if (!NeteaseAPI || !NeteaseAPI.recommend_resource) {
      return res.status(500).json({ error: 'API 未初始化' })
    }
    // 尝试获取更多推荐歌单：同时请求个性化推荐和推荐歌单
    const [resourceResult, personalizedResult] = await Promise.allSettled([
      NeteaseAPI.recommend_resource({ cookie }),
      NeteaseAPI.personalized ? NeteaseAPI.personalized({ cookie, limit: 30 }) : Promise.resolve(null)
    ])
    
    let allPlaylists = []
    
    // 合并推荐歌单
    if (resourceResult.status === 'fulfilled' && resourceResult.value?.body?.recommend) {
      allPlaylists = [...resourceResult.value.body.recommend]
    }
    
    // 合并个性化推荐
    if (personalizedResult.status === 'fulfilled' && personalizedResult.value?.body?.result) {
      const personalizedLists = personalizedResult.value.body.result
      // 去重：根据id过滤
      const existingIds = new Set(allPlaylists.map(p => p.id))
      const newPlaylists = personalizedLists.filter(p => !existingIds.has(p.id))
      allPlaylists = [...allPlaylists, ...newPlaylists]
    }
    res.json({
      code: 200,
      recommend: allPlaylists
    })
  } catch (error) {
    console.error('[网易云推荐歌单] 获取错误:', error)
    res.status(500).json({ error: error.message })
  }
})

// 获取智能歌单（雷达歌单，需要登录）
app.get('/api/netease/playmode/intelligence/list', async (req, res) => {
  try {
    const { cookie, id, pid } = req.query
    
    if (!cookie) {
      return res.status(401).json({ code: 301, message: '需要登录' })
    }

    if (!NeteaseAPI || !NeteaseAPI.playmode_intelligence_list) {
      return res.status(500).json({ error: 'API 未初始化' })
    }
    const result = await NeteaseAPI.playmode_intelligence_list({ 
      cookie,
      id: id || '33894312',  // 默认歌曲ID
      pid: pid || '24381616',  // 默认歌单ID
      count: 30
    })
    res.json(result.body)
  } catch (error) {
    console.error('[网易云雷达歌单] 获取错误:', error)
    res.status(500).json({ error: error.message })
  }
})

// QQ 音乐辅助函数
function qqAlbumCover(albumMid, size = 300) {
  if (!albumMid) return ''
  // 使用 y.gtimg.cn 而不是 y.qq.com，避免CORS问题
  return `https://y.gtimg.cn/music/photo_new/T002R${size}x${size}M000${albumMid}.jpg?max_age=2592000`
}

function qqPhotoCover(type, mid, size = 300) {
  if (!type || !mid) return ''
  return `https://y.gtimg.cn/music/photo_new/${type}R${size}x${size}M000${mid}.jpg?max_age=2592000`
}

function qqTrackCover(track, size = 500) {
  const albumMid = track?.album?.mid || track?.album?.albumMid || track?.album?.albumMID ||
    track?.albummid || track?.albumMid || track?.albumMID || track?.album_mid
  if (albumMid) {
    return qqAlbumCover(albumMid, size)
  }

  const singleCoverMid = Array.isArray(track?.vs) ? track.vs.find(Boolean) : ''
  if (singleCoverMid) {
    return qqPhotoCover('T062', singleCoverMid, size)
  }

  if (track?.album?.pmid) {
    return qqAlbumCover(String(track.album.pmid).replace(/_\d+$/, ''), size)
  }

  return track?.picurl || track?.picUrl || track?.albumPic || track?.albumCover || track?.cover || ''
}

function qqNormalizeSongFromTrack(track, mid, fallback = {}) {
  const artists = (track?.singer || []).map(s => ({ id: s.id, name: s.name, mid: s.mid }))
  const coverUrl = qqTrackCover(track, 500) || fallback.album?.picUrl || fallback.albumpic || ''

  return {
    id: track?.id || fallback.id || fallback.songid || 0,
    mid: track?.mid || mid,
    name: track?.title || track?.name || fallback.name || fallback.songname || '',
    artists: artists.length ? artists : (fallback.artists || fallback.singer || []),
    singer: artists.length ? artists : (fallback.singer || fallback.artists || []),
    album: {
      id: track?.album?.id || track?.albumid || fallback.album?.id || fallback.albumid,
      mid: track?.album?.mid || track?.albummid || fallback.album?.mid || fallback.albummid,
      name: track?.album?.name || fallback.album?.name || fallback.albumname || fallback.album || '',
      picUrl: coverUrl
    },
    albumpic: coverUrl,
    duration: (track?.interval || 0) * 1000 || fallback.duration || (fallback.interval || 0) * 1000 || 0,
    platform: 'qq',
    songType: Number(track?.type ?? track?.songtype ?? track?.songType ?? fallback.songType ?? fallback.type) || 0,
    vip: fallback.vip || fallback.pay?.payplay === 1 || false,
    noCopyright: fallback.noCopyright || false
  }
}

async function qqMusicRequest(data, options = {}) {
  const requestCookie = options.cookie ?? qqMusicCookie
  const timeoutMs = Math.max(1000, Number(options.timeoutMs) || 12000)
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(QQ_MUSICU_URL, {
      method: 'POST',
      headers: {
        ...QQ_HEADERS,
        ...(requestCookie ? { Cookie: requestCookie } : {}),
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(data),
      signal: controller.signal,
    })
    if (!response.ok) throw new Error('QQ MusicU HTTP ' + response.status)
    return await response.json()
  } finally {
    clearTimeout(timeoutId)
  }
}
// QQ Music's desktop protocol exposes the account-level playback history through
// PlayRecentlyRead.GetPlayRecentlyInfo. MusicU expects type=2 for songs;
// MV history is deliberately not requested here.
function getQQRecentSongRows(payload) {
  const data = payload?.req_0?.data || payload?.data || payload || {}
  const candidates = [
    data?.data?.songList,
    data?.data?.songlist,
    data?.songList,
    data?.songlist,
    data?.list,
    data?.songs,
    payload?.songList,
    payload?.songlist,
    payload?.list
  ]
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate
  }
  return []
}

function normalizeQQRecentSongRow(row) {
  const track = row?.songInfo || row?.song || row?.track || row
  const mid = track?.mid || track?.songmid || track?.songMid || row?.mid || row?.songmid
  if (!track || (!mid && !track?.id && !track?.songid && !track?.songId)) return null
  const song = qqNormalizeSongFromTrack(track, mid, row)
  const rawPlayTime = row?.lastTime ?? row?.updateTime ?? row?.playTime ?? row?.listenTime
  const playTime = Number(rawPlayTime || 0)
  return {
    song,
    playTime: Number.isFinite(playTime) ? playTime : 0
  }
}

async function fetchQQRecentSongs(cookie, { lastTime = 0 } = {}) {
  const parsedCookie = parseQQCookie(cookie)
  const uin = String(parsedCookie.uin || parsedCookie.qqmusic_uin || parsedCookie.musicid || parsedCookie.wxuin || '').replace(/\D/g, '')
  const musicKey = parsedCookie.qm_keyst || parsedCookie.qqmusic_key || ''
  const response = await qqMusicRequest({
    comm: {
      ct: 24,
      cv: 4747474,
      format: 'json',
      inCharset: 'utf-8',
      outCharset: 'utf-8',
      platform: 'yqq.json',
      uin,
      qq: uin,
      ...(musicKey ? {
        authst: musicKey,
        g_tk: qqHash33(musicKey),
        g_tk_new_20200303: qqHash33(musicKey)
      } : {}),
      ...(parsedCookie.login_type ? {
        tmeLoginType: Number(parsedCookie.login_type) || undefined
      } : {})
    },
    req_0: {
      module: 'music.musicasset.PlayRecentlyRead',
      method: 'GetPlayRecentlyInfo',
      param: {
        type: 2,
        lastTime: Math.max(0, Number(lastTime) || 0)
      }
    }
  }, { cookie, timeoutMs: 15000 })

  const requestResult = response?.req_0 || response
  const resultCode = Number(requestResult?.code ?? response?.code ?? 0)
  if (resultCode !== 0) {
    const error = new Error(requestResult?.msg || requestResult?.message || 'QQ 音乐最近播放接口返回失败')
    error.qqCode = resultCode
    throw error
  }

  const rows = getQQRecentSongRows(response)
  const records = rows.map(normalizeQQRecentSongRow).filter(Boolean)
  const data = requestResult?.data || {}
  return {
    source: 'qq-musicu-play-recently',
    type: 2,
    updateTime: Number(data?.updateTime || data?.lastTime || 0) || 0,
    requestCnt: Number(data?.requestCnt || data?.listenCnt || records.length) || records.length,
    songlist: records.map(record => record.song),
    records
  }
}

async function reportQQRecentSong(cookie, songId) {
  const parsedCookie = parseQQCookie(cookie)
  const uin = String(parsedCookie.uin || parsedCookie.qqmusic_uin || parsedCookie.musicid || parsedCookie.wxuin || '').replace(/\D/g, '')
  const musicKey = parsedCookie.qm_keyst || parsedCookie.qqmusic_key || ''
  const response = await qqMusicRequest({
    comm: {
      ct: 24,
      cv: 4747474,
      format: 'json',
      inCharset: 'utf-8',
      outCharset: 'utf-8',
      platform: 'yqq.json',
      uin,
      qq: uin,
      ...(musicKey ? {
        authst: musicKey,
        g_tk: qqHash33(musicKey),
        g_tk_new_20200303: qqHash33(musicKey)
      } : {}),
      ...(parsedCookie.login_type ? {
        tmeLoginType: Number(parsedCookie.login_type) || undefined
      } : {})
    },
    req_0: {
      module: 'music.musicasset.PlayRecentlyWrite',
      method: 'ReportPlayRecentlyInfo',
      param: {
        data: [{
          id: String(songId),
          type: 2,
          lastTime: Math.floor(Date.now() / 1000),
          listenCnt: 1
        }]
      }
    }
  }, { cookie, timeoutMs: 15000 })

  const requestResult = response?.req_0 || response
  const resultCode = Number(requestResult?.code ?? response?.code ?? 0)
  const dataCode = Number(requestResult?.data?.code ?? 0)
  if (resultCode !== 0 || dataCode !== 0) {
    const error = new Error(requestResult?.msg || requestResult?.message || 'QQ 音乐最近播放上报失败')
    error.qqCode = resultCode || dataCode
    throw error
  }
  return { code: 0 }
}

function getXmlTagText(xml, tag) {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'i').exec(xml || '')
  return match ? decodeXmlEntities(match[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')).trim() : ''
}

function parseQQSingerDescXml(xml) {
  const desc = getXmlTagText(xml, 'desc')
  const basicItems = []
  const otherItems = []
  const collectItems = (section, target) => {
    const sectionMatch = new RegExp(`<${section}>([\\s\\S]*?)<\\/${section}>`, 'i').exec(xml || '')
    if (!sectionMatch) return

    const itemRegex = /<item>([\s\S]*?)<\/item>/gi
    let itemMatch
    while ((itemMatch = itemRegex.exec(sectionMatch[1])) !== null) {
      const itemXml = itemMatch[1]
      target.push({
        key: getXmlTagText(itemXml, 'key'),
        value: getXmlTagText(itemXml, 'value')
      })
    }
  }

  collectItems('basic', basicItems)
  collectItems('other', otherItems)

  return {
    desc,
    basic: basicItems.length ? { item: basicItems } : null,
    other: otherItems.length ? { item: otherItems } : null
  }
}

async function qqSingerDesc(mid) {
  const response = await axios.get('https://c.y.qq.com/splcloud/fcgi-bin/fcg_get_singer_desc.fcg', {
    params: {
      singermid: mid,
      format: 'xml',
      utf8: 1,
      outCharset: 'utf-8'
    },
    headers: QQ_HEADERS,
    timeout: 10000,
    responseType: 'text',
    transformResponse: data => data
  })

  return parseQQSingerDescXml(response.data)
}

function hasLyricTimestamp(text) {
  return /\[\d{1,2}:\d{2}[.:]\d{2,3}\]|\[\d+,\d+\]/.test(text)
}

function isReadableLyricText(text) {
  if (!text || !hasLyricTimestamp(text)) return false

  const compact = text.replace(/\s/g, '')
  if (!compact) return false

  let bad = 0
  for (const char of compact) {
    const code = char.charCodeAt(0)
    if (code === 0xfffd || code < 32) bad += 1
  }

  return bad / compact.length < 0.05
}

function decodeXmlEntities(value) {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

function extractQrcLyricContent(value) {
  const match = /LyricContent="([\s\S]*?)"\s*\/?\>/i.exec(value)
  return decodeXmlEntities(match?.[1] || value)
}

function decryptQQEncryptedLyric(value, label = 'lyric') {
  if (!value || typeof value !== 'string') return ''

  const text = value.trim()
  if (!/^[0-9a-f]+$/i.test(text) || text.length % 16 !== 0) return ''

  try {
    const decrypted = extractQrcLyricContent(decryptQrc(text))
    if (isReadableLyricText(decrypted)) {
      return decrypted
    }
  } catch (error) {
    console.warn(`[QQ Music Lyrics] decrypt ${label} failed:`, error.message)
  }

  return ''
}

function hasQrcWordTiming(text) {
  return /\[\d+,\d+\][\s\S]*?\(\d+,\d+\)/.test(text || '')
}

// 从 kana 格式中提取普通 LRC（去掉 [kana:...] 元数据行，只保留时间戳行）
function extractPlainLrcFromKana(kanaText) {
  if (!kanaText) return ''
  
  const lines = kanaText.split('\n')
  const plainLines = []
  
  for (const line of lines) {
    const trimmed = line.trim()
    // 跳过 [kana:...] 元数据行
    if (trimmed.startsWith('[kana:')) continue
    // 保留其他所有行（包括元数据和时间戳行）
    plainLines.push(line)
  }
  
  return plainLines.join('\n')
}

// 将 QRC 格式转换为普通 LRC 格式
// QRC: [开始ms,持续ms]文本 (字ms,字持续)字符...
// LRC: [mm:ss.xx]文本
function convertQrcToLrc(qrcText) {
  if (!qrcText) return ''
  
  const lines = qrcText.split('\n')
  const lrcLines = []
  
  for (const line of lines) {
    const trimmed = line.trim()
    
    // 保留元数据行（但跳过 kana 行）
    if (trimmed.startsWith('[') && !trimmed.match(/^\[\d+,\d+\]/)) {
      if (!trimmed.startsWith('[kana:')) {
        lrcLines.push(line)
      }
      continue
    }
    
    // 匹配 QRC 格式: [开始ms,持续ms]歌词内容...
    const qrcMatch = trimmed.match(/^\[(\d+),(\d+)\](.*)$/)
    if (qrcMatch) {
      const startMs = parseInt(qrcMatch[1])
      let lyricText = qrcMatch[3]
      
      // 去掉逐字时间信息: (ms,duration)字符
      lyricText = lyricText.replace(/\(\d+,\d+\)/g, '')
      
      // 转换为 LRC 时间格式 [mm:ss.xx]
      const totalSeconds = startMs / 1000
      const minutes = Math.floor(totalSeconds / 60)
      const seconds = (totalSeconds % 60).toFixed(2)
      const lrcTime = `[${String(minutes).padStart(2, '0')}:${String(seconds).padStart(5, '0')}]`
      
      lrcLines.push(`${lrcTime}${lyricText}`)
    }
  }
  
  return lrcLines.join('\n')
}

// 将 QRC+kana 格式转换为 YRC 格式（网易云逐字歌词格式）
// QRC: [开始ms,持续ms]歌词文本(字开始ms,字持续ms)字(字开始ms,字持续ms)字...
// YRC: [开始ms,持续ms](字开始ms,字持续ms,0)字(字开始ms,字持续ms,0)字...
function convertKanaToYrc(kanaText) {
  if (!kanaText) return ''
  
  const lines = kanaText.split('\n')
  const yrcLines = []
  let processedLines = 0
  let skippedLines = 0
  let hasWordTiming = 0
  
  for (const line of lines) {
    const trimmed = line.trim()
    
    // 跳过元数据行和 kana 行
    if (trimmed.startsWith('[ti:') || trimmed.startsWith('[ar:') || 
        trimmed.startsWith('[al:') || trimmed.startsWith('[by:') || 
        trimmed.startsWith('[offset:') || trimmed.startsWith('[kana:')) {
      continue
    }
    
    if (!trimmed) continue
    
    // 只处理 QRC 格式 [ms,ms]歌词(ms,ms)字...
    const qrcMatch = /^\[(\d+),(\d+)\](.*)$/.exec(trimmed)
    if (!qrcMatch) {
      skippedLines++
      continue
    }
    
    const lineStartMs = parseInt(qrcMatch[1])
    const lineDurationMs = parseInt(qrcMatch[2])
    const lyricContent = qrcMatch[3]
    
    if (!lyricContent) continue
    processedLines++
    
    // QQ kana/QRC puts each timestamp after its text: 字(start,duration).
    // Convert it to the prefix form consumed by parseYrc while preserving spaces.
    const wordParts = []
    const postfixTimingRegex = /\((\d+),(\d+)(?:,\d+)?\)/g
    let contentCursor = 0
    let hasTimingInLine = false
    let timingMatch

    while ((timingMatch = postfixTimingRegex.exec(lyricContent)) !== null) {
      const segment = lyricContent.slice(contentCursor, timingMatch.index)
      const startMs = parseInt(timingMatch[1])
      const durationMs = parseInt(timingMatch[2])

      if (segment) {
        const leadingWhitespace = segment.match(/^\s+/u)?.[0] || ''
        const timedText = segment.slice(leadingWhitespace.length)
        if (leadingWhitespace) {
          wordParts.push(`(${startMs},0,0)${leadingWhitespace}`)
        }
        if (timedText) {
          wordParts.push(`(${startMs},${durationMs},0)${timedText}`)
          hasTimingInLine = true
        }
      }

      contentCursor = postfixTimingRegex.lastIndex
    }

    const trailingText = lyricContent.slice(contentCursor)
    if (trailingText) {
      wordParts.push(`(0,0,0)${trailingText}`)
    }
    
    if (hasTimingInLine) hasWordTiming++
    
    // 生成 YRC 格式行
    const yrcLine = `[${lineStartMs},${lineDurationMs}]${wordParts.join('')}`
    yrcLines.push(yrcLine)
  }
  return yrcLines.join('\n')
}

function decodeQQLyricText(value) {
  if (!value || typeof value !== 'string') return ''

  const text = value.trim()
  if (!text) return ''

  const candidates = [text]
  const maybeBase64 = /^[A-Za-z0-9+/=\s]+$/.test(text) && text.length >= 8

  if (maybeBase64) {
    try {
      const decoded = Buffer.from(text, 'base64').toString('utf-8').trim()
      if (decoded && decoded !== text) candidates.push(decoded)
    } catch {
      // Ignore invalid base64-like values.
    }
  }

  for (const candidate of candidates) {
    if (isReadableLyricText(candidate)) return candidate
  }

  return ''
}
async function qqSmartboxSearch(keywords, limit = 10) {
  const url = new URL(QQ_SMARTBOX_URL)
  url.searchParams.set('format', 'json')
  url.searchParams.set('key', keywords)
  url.searchParams.set('g_tk', '5381')
  url.searchParams.set('loginUin', '0')
  url.searchParams.set('hostUin', '0')
  url.searchParams.set('inCharset', 'utf8')
  url.searchParams.set('outCharset', 'utf-8')
  url.searchParams.set('notice', '0')
  url.searchParams.set('platform', 'yqq.json')

  const response = await fetch(url.toString(), { headers: QQ_HEADERS })
  const json = await response.json()
  const items = json?.data?.song?.itemlist || []
  // 增加limit，smartbox虽然只返回少量结果，但我们尽量多取
  return items.slice(0, Math.min(limit, items.length)).map(item => {
    const mid = item.mid || item.songmid || ''
    const albumMid = item.album?.mid || item.albummid || ''
    
    // 处理歌手信息 - 可能是数组或字符串
    let artistName = ''
    let artists = []
    
    if (Array.isArray(item.singer)) {
      artists = item.singer.map(s => ({ name: s.name, mid: s.mid }))
      artistName = item.singer.map(s => s.name).join('/')
    } else if (typeof item.singer === 'string') {
      artistName = item.singer
      artists = [{ name: item.singer, mid: '' }]
    }
    
    return {
      id: item.id || 0,
      mid,
      name: item.name || item.songname || '',
      artists,
      album: {
        name: item.album?.name || item.albumname || '',
        picUrl: qqAlbumCover(albumMid, 500)
      },
      duration: item.interval || 0,
      platform: 'qq'
    }
  })
}

// 新增：使用QQ音乐网页搜索接口（正确的接口）
async function qqWebSearch(keywords, limit = 30, devMode = false) {
  try {
    const url = new URL('https://c.y.qq.com/soso/fcgi-bin/search_for_qq_cp')
    url.searchParams.set('_', Date.now().toString())
    url.searchParams.set('g_tk', '5381')
    url.searchParams.set('uin', '0')
    url.searchParams.set('format', 'json')
    url.searchParams.set('inCharset', 'utf-8')
    url.searchParams.set('outCharset', 'utf-8')
    url.searchParams.set('notice', '0')
    url.searchParams.set('platform', 'h5')
    url.searchParams.set('needNewCode', '1')
    url.searchParams.set('w', keywords)
    url.searchParams.set('zhidaqu', '1')
    url.searchParams.set('catZhida', '1')
    url.searchParams.set('t', '0') // 0=单曲
    url.searchParams.set('flag', '1')
    url.searchParams.set('ie', 'utf-8')
    url.searchParams.set('sem', '1')
    url.searchParams.set('aggr', '0')
    url.searchParams.set('perpage', limit.toString())
    url.searchParams.set('n', limit.toString())
    url.searchParams.set('p', '1')
    url.searchParams.set('remoteplace', 'txt.mqq.all')
    
    if (devMode) console.log('[QQ网页搜索] 请求URL:', url.toString())
    
    const response = await fetch(url.toString(), { 
      headers: {
        ...QQ_HEADERS,
        'Referer': 'https://y.qq.com/'
      }
    })
    const json = await response.json()
    
    if (devMode) {
    }
    
    if (json.code !== 0 || !json.data?.song?.list) {
      return []
    }
    
    const songs = json.data.song.list
    
    // 映射歌曲数据
    const mappedSongs = songs.map(item => {
      const albumMid = item.albummid || ''
      const artists = (item.singer || []).map(s => ({ id: s.id, name: s.name, mid: s.mid }))
      
      // 如果没有albummid，尝试从其他字段获取封面
      let coverUrl = ''
      if (albumMid) {
        coverUrl = qqAlbumCover(albumMid, 500)
      } else if (item.albumpic) {
        // 有些歌曲直接返回完整的图片URL
        coverUrl = item.albumpic.startsWith('http') ? item.albumpic : `https://y.gtimg.cn${item.albumpic}`
      }
      
      return {
        id: item.songid || 0,
        mid: item.songmid || '',
        name: item.songname || '',
artists,
        album: {
          id: item.albumid,
          mid: albumMid,
          name: item.albumname || '',
          picUrl: coverUrl
        },
        duration: item.interval || 0,
        platform: 'qq',
        vip: item.pay?.payplay === 1, // payplay=1表示需要VIP才能播放
        noCopyright: false, // QQ音乐搜索结果一般都有版权
        needsDetail: !coverUrl // 标记需要获取详情的歌曲
      }
    })
    
    // 对于缺少封面的歌曲，批量获取详情
    const songsNeedingDetails = mappedSongs.filter(song => song.needsDetail && song.mid)
    if (songsNeedingDetails.length > 0) {
      // 并发获取详情（限制并发数为5）
      const detailPromises = songsNeedingDetails.slice(0, 5).map(song => 
        qqSongDetail(song.mid, song, devMode).catch(err => {
          if (devMode) console.error(`[QQ音乐详情] 获取失败 ${song.name}:`, err.message)
          return song // 失败时返回原数据
        })
      )
      
      const detailedSongs = await Promise.all(detailPromises)
      
      // 更新歌曲列表
      detailedSongs.forEach(detailedSong => {
        const index = mappedSongs.findIndex(s => s.mid === detailedSong.mid)
        if (index !== -1) {
          mappedSongs[index] = detailedSong
          if (devMode && detailedSong.album?.picUrl) {
          }
        }
      })
    }
    
    // 移除临时标记
    return mappedSongs.map(({needsDetail, ...song}) => song)
  } catch (error) {
    if (devMode) console.error('[QQ网页搜索] 失败:', error.message)
    return []
  }
}

// 新增：使用musicu API进行更完整的搜索
async function qqMusicSearch(keywords, limit = 30, devMode = false) {
  try {
    // 先尝试网页搜索接口
    const webResults = await qqWebSearch(keywords, limit, devMode)
    if (webResults.length > 0) {
      return webResults
    }
    
    // 网页搜索失败，尝试musicu
    const data = {
      comm: {
        ct: 24,
        cv: 0
      },
      req_1: {
        method: 'DoSearchForQQMusicDesktop',
        module: 'music.search.SearchCgiService',
        param: {
          num_per_page: limit,
          page_num: 1,
          query: keywords,
          search_type: 0
        }
      }
    }
    
    const json = await qqMusicRequest(data)
    const songs = json?.req_1?.data?.body?.song?.list || []
    
    if (songs.length === 0) {
      return await qqSmartboxSearch(keywords, limit)
    }
    
    return songs.map(item => {
      const albumMid = item.album?.mid || ''
      const artists = (item.singer || []).map(s => ({ id: s.id, name: s.name, mid: s.mid }))
      
      return {
        id: item.id || 0,
        mid: item.mid || '',
        name: item.name || '',
        artists,
        album: {
          id: item.album?.id,
          mid: albumMid,
          name: item.album?.name || '',
          picUrl: qqAlbumCover(albumMid, 500)
        },
        duration: item.interval || 0,
        platform: 'qq'
      }
    })
  } catch (error) {
    if (devMode) console.error('[QQ音乐搜索] 失败:', error.message)
    // 降级到smartbox搜索
    return await qqSmartboxSearch(keywords, limit)
  }
}

async function qqSongDetail(mid, fallback = {}, devMode = false) {
  if (!mid) return fallback
  
  try {
    // 方法1: 尝试官方API (pf_song_detail_svr)
    let json = await qqMusicRequest({
      comm: { ct: 24, cv: 0 },
      req_1: {
        module: 'music.pf_song_detail_svr',
        method: 'get_song_detail_yqq',
        param: { song_mid: mid }
      }
    })

    let track = json?.req_1?.data?.track_info
    
    if (track) {
      const coverUrl = qqTrackCover(track, 500)
      
      if (coverUrl) {
        return qqNormalizeSongFromTrack(track, mid, fallback)
      }
    }
    
    // 方法2: 尝试vkey API (这个API通常返回更完整的信息)
    json = await qqMusicRequest({
      comm: { ct: 24, cv: 0 },
      req_1: {
        module: 'music.musicasset.song_info',
        method: 'get_song_info_all',
        param: { song_mid: mid }
      }
    })
    
    track = json?.req_1?.data?.info
    if (track) {
      const coverUrl = qqTrackCover(track, 500)
      
      if (coverUrl) {
        return qqNormalizeSongFromTrack(track, mid, fallback)
      }
    }
    return fallback
    
  } catch (error) {
    if (devMode) console.error(`[QQ音乐详情] 请求失败 ${mid}:`, error.message)
    return fallback
  }
}

// QQ 音乐 API 路由
app.get('/api/qq/search', async (req, res) => {
  try {
    const { keywords, limit = 30, type = 'song' } = req.query
    if (!keywords) {
      return res.status(400).json({ error: '请提供搜索关键词' })
    }

    const devMode = req.query.devMode === 'true'

    // 歌手搜索
    if (type === 'singer') {
      const url = new URL('https://c.y.qq.com/soso/fcgi-bin/search_for_qq_cp')
      url.searchParams.set('_', Date.now().toString())
      url.searchParams.set('g_tk', '5381')
      url.searchParams.set('uin', '0')
      url.searchParams.set('format', 'json')
      url.searchParams.set('inCharset', 'utf-8')
      url.searchParams.set('outCharset', 'utf-8')
      url.searchParams.set('notice', '0')
      url.searchParams.set('platform', 'h5')
      url.searchParams.set('needNewCode', '1')
      url.searchParams.set('w', keywords)
      url.searchParams.set('zhidaqu', '1')
      url.searchParams.set('catZhida', '1')
      url.searchParams.set('t', '2') // 2=歌手
      url.searchParams.set('flag', '1')
      url.searchParams.set('ie', 'utf-8')
      url.searchParams.set('sem', '1')
      url.searchParams.set('aggr', '0')
      url.searchParams.set('perpage', limit.toString())
      url.searchParams.set('n', limit.toString())
      url.searchParams.set('p', '1')
      url.searchParams.set('remoteplace', 'txt.mqq.all')
      
      console.log('[QQ音乐歌手搜索] 请求URL:', url.toString())
      
      const response = await fetch(url.toString(), { 
        headers: {
          ...QQ_HEADERS,
          'Referer': 'https://y.qq.com/'
        }
      })
      const json = await response.json()
      
      console.log('[QQ音乐歌手搜索] 返回数据keys:', Object.keys(json))
      const singers = []
      
      // 方法1: 从 zhida（智能直达）中获取歌手
      if (json?.data?.zhida && json.data.zhida.type === 2) {
        singers.push({
          singer_id: json.data.zhida.singerid,
          singer_mid: json.data.zhida.singermid,
          singer_name: json.data.zhida.singername,
          singer_pic: `https://y.gtimg.cn/music/photo_new/T001R300x300M000${json.data.zhida.singermid}.jpg`,
          albumNum: json.data.zhida.albumnum,
          songNum: json.data.zhida.songnum
        })
      }
      
      // 方法2: 从歌曲列表中提取歌手（去重）
      if (json?.data?.song?.list && json.data.song.list.length > 0) {
        const singerMap = new Map()
        
        // 遍历所有歌曲，提取歌手信息
        json.data.song.list.forEach(song => {
          if (song.singer && Array.isArray(song.singer)) {
            song.singer.forEach(s => {
              if (!singerMap.has(s.mid)) {
                singerMap.set(s.mid, {
                  singer_id: s.id,
                  singer_mid: s.mid,
                  singer_name: s.name,
                  singer_pic: `https://y.gtimg.cn/music/photo_new/T001R300x300M000${s.mid}.jpg`,
                  albumNum: 0,
                  songNum: 0
                })
              }
            })
          }
        })
        // 将提取的歌手添加到结果中（去重）
        singerMap.forEach(singer => {
          if (!singers.find(s => s.singer_mid === singer.singer_mid)) {
            singers.push(singer)
          }
        })
      }
      if (singers.length > 0) {
        console.log('[QQ音乐歌手搜索] 歌手列表:', JSON.stringify(singers.map(s => ({ id: s.singer_id, mid: s.singer_mid, name: s.singer_name, albumNum: s.albumNum, songNum: s.songNum })), null, 2))
        
        // 为所有没有专辑数量或歌曲数量的歌手补充详细信息
        const enrichPromises = singers.map(async (singer) => {
          if ((singer.albumNum === undefined || singer.albumNum === 0) || (singer.songNum === undefined || singer.songNum === 0)) {
            try {
              // 使用与艺人详情页相同的API
              const songsResult = await qqMusicApi.api('singer/songs', { singermid: singer.singer_mid, num: 1 })
              const songsData = songsResult.data || songsResult
              
              let albumNum = songsData?.singer?.album_num || 0
              const songNum = songsData?.total || 0
              
              // 如果专辑数量为0，尝试从专辑列表接口获取
              if (albumNum === 0) {
                try {
                  const albumsResult = await qqMusicApi.api('singer/album', { singermid: singer.singer_mid, pageSize: 1 })
                  const albumsData = albumsResult.data || albumsResult
                  albumNum = albumsData?.total || 0
                } catch (albumError) {
                  // 获取专辑数量失败，保持为0
                }
              }
              singer.albumNum = albumNum
              singer.songNum = songNum
            } catch (err) {
              console.warn('[QQ音乐歌手搜索] 补充详细信息失败:', singer.singer_name, err.message)
            }
          }
        })
        
        // 等待所有补充操作完成
        await Promise.all(enrichPromises)
        console.log('[QQ音乐歌手搜索] 最终数据:', JSON.stringify(singers.map(s => ({ name: s.singer_name, albumNum: s.albumNum, songNum: s.songNum })), null, 2))
      } else {
      }
      
      return res.json({ singers })
    }

    // 专辑搜索
    if (type === 'album') {
      const url = new URL('https://c.y.qq.com/soso/fcgi-bin/search_for_qq_cp')
      url.searchParams.set('_', Date.now().toString())
      url.searchParams.set('g_tk', '5381')
      url.searchParams.set('uin', '0')
      url.searchParams.set('format', 'json')
      url.searchParams.set('inCharset', 'utf-8')
      url.searchParams.set('outCharset', 'utf-8')
      url.searchParams.set('notice', '0')
      url.searchParams.set('platform', 'h5')
      url.searchParams.set('needNewCode', '1')
      url.searchParams.set('w', keywords)
      url.searchParams.set('zhidaqu', '1')
      url.searchParams.set('catZhida', '1')
      url.searchParams.set('t', '8') // 8=专辑
      url.searchParams.set('flag', '1')
      url.searchParams.set('ie', 'utf-8')
      url.searchParams.set('sem', '1')
      url.searchParams.set('aggr', '0')
      url.searchParams.set('perpage', limit.toString())
      url.searchParams.set('n', limit.toString())
      url.searchParams.set('p', '1')
      url.searchParams.set('remoteplace', 'txt.mqq.all')
      
      const response = await fetch(url.toString(), { 
        headers: {
          ...QQ_HEADERS,
          'Referer': 'https://y.qq.com/'
        }
      })
      const json = await response.json()
      const albumList = json?.data?.album?.list || []
      const albums = albumList.map((item, index) => {
        // 提取艺人信息，优先使用 singer 数组或直接字段
        let singerName = '未知艺人'
        let singerMid = ''
        
        if (Array.isArray(item.singer) && item.singer.length > 0) {
          singerName = item.singer.map(s => s.name).join('/')
          singerMid = item.singer[0].mid || ''
        } else if (item.singerName) {
          // 使用正确的字段名 singerName (大写N)
          singerName = item.singerName
          singerMid = item.singerMID || ''
        } else if (item.singer_name) {
          singerName = item.singer_name
        }
        
        // 使用正确的字段名 albumMID (大写)
        const albumMid = item.albumMID || item.albummid
        
        const album = {
          albumID: item.albumID || item.albumid,
          albumMID: albumMid,
          albumName: item.albumName || item.albumname,
          albumPic: `https://y.gtimg.cn/music/photo_new/T002R300x300M000${albumMid}.jpg`,
          singer_name: singerName,
          singer_mid: singerMid,
          pub_time: item.publicTime || item.public_time
        }
        
        // 调试：输出第一个专辑的完整信息
        if (index === 0) {
          console.log('[QQ音乐专辑搜索] 第一个专辑原始数据:', JSON.stringify(item, null, 2))
          console.log('[QQ音乐专辑搜索] 第一个专辑处理后:', JSON.stringify(album, null, 2))
        }
        
        return album
      })
      return res.json({ albums })
    }

    // MV 搜索（t=12，client_search_cp 返回 data.mv.list，播放 id 是 v_id）
    if (type === 'mv') {
      const url = new URL('http://c.y.qq.com/soso/fcgi-bin/client_search_cp')
      url.searchParams.set('format', 'json')
      url.searchParams.set('n', limit.toString())
      url.searchParams.set('p', '1')
      url.searchParams.set('w', keywords)
      url.searchParams.set('cr', '1')
      url.searchParams.set('g_tk', '5381')
      url.searchParams.set('t', '12') // 12=MV

      const response = await fetch(url.toString(), {
        headers: {
          ...QQ_HEADERS,
          'Referer': 'https://y.qq.com/'
        }
      })
      const json = await response.json()
      const mvList = json?.data?.mv?.list || []
      const mvs = mvList.map((item) => ({
        vid: item.v_id || item.vid,
        name: item.mv_name || item.title || '',
        picurl: item.mv_pic_url || item.picurl || '',
        playcnt: Number(item.play_count || item.playcnt || 0),
        pubtime: item.publish_date,
        singers: Array.isArray(item.singer_list) && item.singer_list.length
          ? item.singer_list.map((s) => ({ name: s.name }))
          : (item.singer_name ? [{ name: item.singer_name }] : [])
      }))
      return res.json({ provider: 'qq', mvs })
    }

    // QQ 歌单搜索（t=2，需 cookie）
    if (type === 'playlist') {
      useQQMusicCookie(req.query.cookie)
      const result = await qqMusicApi.api('search', { key: keywords, t: 2, pageNo: 1, pageSize: parseInt(limit) })
      const list = result?.list || []
      const playlists = list.map((item) => ({
        id: item.dissid || item.tid,
        name: item.dissname || item.name || '',
        coverImgUrl: item.imgurl || item.picurl || '',
        trackCount: Number(item.songnum || item.song_count || 0),
        playCount: Number(item.listennum || item.play_count || 0),
        creator: item.creator?.nick || item.nickname || '',
        platform: 'qq'
      }))
      return res.json({ provider: 'qq', playlists })
    }

    // 歌曲搜索（默认）
    const base = await qqMusicSearch(keywords, parseInt(limit), devMode)
    // 获取每首歌的详细信息（包含封面）
    const detailed = await Promise.all(base.map(async item => {
      try {
        return await qqSongDetail(item.mid, item, devMode)
      } catch (e) {
        if (devMode) console.warn('[QQ音乐] 获取详情失败:', item.mid, e.message)
        return item
      }
    }))
    
    if (devMode) console.log('[QQ音乐搜索] 返回歌曲数:', detailed.filter(s => s && s.name).length)

    res.json({ 
      provider: 'qq',
      songs: detailed.filter(song => song && song.name)
    })
  } catch (error) {
    console.error('QQ音乐搜索错误:', error)
    res.status(500).json({ error: error.message, songs: [] })
  }
})

// QQ音乐 - 获取艺人详情
app.get('/api/qq/artist', async (req, res) => {
  try {
    const { mid } = req.query
    if (!mid) {
      return res.status(400).json({ error: '请提供歌手mid' })
    }
    // 先获取歌手的歌曲和统计信息
    let singerId = ''
    let albumNum = 0
    let songNum = 0
    let singerName = '未知歌手'
    let fans = 0
    
    try {
      const songsResult = await qqMusicApi.api('singer/songs', { singermid: mid, num: 1 })
      const songsData = songsResult.data || songsResult
      singerId = songsData?.singer?.singer_id || songsData?.singer?.id || ''
      albumNum = songsData?.singer?.album_num || 0
      songNum = songsData?.total || 0
      singerName = songsData?.singer?.singername || songsData?.singer?.name || '未知歌手'
      fans = songsData?.singer?.fans || 0
      console.log('[QQ音乐艺人详情] singer对象:', JSON.stringify(songsData?.singer, null, 2))
    } catch (songsError) {
      console.warn('[QQ音乐艺人详情] 获取歌曲统计失败:', songsError.message)
    }

    // 如果专辑数量为0，尝试从专辑列表接口获取
    if (albumNum === 0) {
      try {
        const albumsResult = await qqMusicApi.api('singer/album', { singermid: mid, pageSize: 1 })
        const albumsData = albumsResult.data || albumsResult
        albumNum = albumsData?.total || 0
      } catch (albumError) {
        console.warn('[QQ音乐艺人详情] 获取专辑数量失败:', albumError.message)
      }
    }

    // 尝试获取歌手描述和详细信息
    let desc = ''
    let basicInfo = null
    let otherInfo = null
    try {
      const descData = await qqSingerDesc(mid)
      if (descData) {
        // 描述可能在多个位置：根级别的desc、basic.desc、other.desc
        desc = descData.desc || descData.basic?.desc || descData.other?.desc || ''
        basicInfo = descData.basic || null
        otherInfo = descData.other || null
        // 如果描述接口有歌手名，使用它
        if (descData.singername) {
          singerName = descData.singername
        }
      }
    } catch (descError) {
      console.warn('[QQ音乐艺人详情] 描述接口调用失败:', descError.message)
    }
    res.json({
      singer_id: singerId,
      singer_mid: mid,
      singer_name: singerName,
      albumNum: albumNum,
      songNum: songNum,
      fans: fans,
      desc: desc,
      basic: basicInfo,
      other: otherInfo
    })
  } catch (error) {
    console.error('[QQ音乐艺人详情] 错误:', error)
    res.status(500).json({ error: error.message })
  }
})

// QQ音乐 - 获取专辑详情
app.get('/api/qq/album', async (req, res) => {
  try {
    const { mid } = req.query
    if (!mid) {
      return res.status(400).json({ error: '请提供专辑mid' })
    }
    // 1. 使用 QQ音乐官方 API 获取专辑详情
    let albumInfo = null
    try {
      const apiUrl = 'https://u.y.qq.com/cgi-bin/musicu.fcg'
      const params = {
        format: 'json',
        data: JSON.stringify({
          comm: {
            ct: 24,
            cv: 0
          },
          albumInfo: {
            module: 'music.musichallAlbum.AlbumInfoServer',
            method: 'GetAlbumDetail',
            param: {
              albumMid: mid
            }
          }
        })
      }
      
      const response = await axios.get(apiUrl, {
        params: params,
        headers: {
          'Referer': 'https://y.qq.com/',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36'
        },
        timeout: 10000
      })
      
      const detail = response.data?.albumInfo?.data
      
      if (detail) {
        // 专辑基本信息在 basicInfo 对象中
        const basicInfo = detail.basicInfo || {}
        const singerInfo = detail.singer || {}
        const companyInfo = detail.company || {}
        
        console.log('[QQ音乐专辑详情] 步骤1: basicInfo:', JSON.stringify(basicInfo).substring(0, 500))
        
        // 处理歌手信息 - singer 是对象
        let singerName = ''
        let singerMid = ''
        
        if (typeof singerInfo === 'object' && singerInfo !== null) {
          singerName = singerInfo.name || singerInfo.singerName || ''
          singerMid = singerInfo.mid || singerInfo.singerMid || ''
        }
        
        // 处理唱片公司 - company 是对象
        let companyName = ''
        if (typeof companyInfo === 'object' && companyInfo !== null) {
          companyName = companyInfo.name || ''
        } else if (typeof companyInfo === 'string') {
          companyName = companyInfo
        }
        
        albumInfo = {
          albumName: basicInfo.albumName || basicInfo.name,
          albumMID: basicInfo.albumMid || basicInfo.albumMID || mid,
          singer_name: singerName,
          singer_mid: singerMid,
          pub_time: basicInfo.publishDate || basicInfo.pubTime || basicInfo.publishTime || '',
          desc: basicInfo.desc || basicInfo.description || '',
          genre: basicInfo.genre || '',
          lan: basicInfo.language || basicInfo.lan || '',
          company: companyName
        }
        
        console.log('[QQ音乐专辑详情] 步骤1: 成功获取专辑信息:', {
          name: albumInfo.albumName,
          singer: albumInfo.singer_name,
          desc: albumInfo.desc ? `有数据(${albumInfo.desc.length}字符)` : '无数据',
          pub_time: albumInfo.pub_time,
          genre: albumInfo.genre,
          lan: albumInfo.lan,
          company: albumInfo.company
        })
      } else {
        console.warn('[QQ音乐专辑详情] 步骤1: API 未返回专辑信息')
      }
    } catch (apiError) {
      console.warn('[QQ音乐专辑详情] 步骤1: API 调用失败:', apiError.message)
    }

    // 2. 获取专辑歌曲列表（使用 album/songs 接口）
    let songsResult
    try {
      songsResult = await qqMusicApi.api('album/songs', { albummid: mid })
    } catch (apiError) {
      console.warn('[QQ音乐专辑详情] album/songs 失败，改用 musicu:', apiError.message)
      songsResult = await qqMusicRequest({
        comm: { ct: 24, cv: 0 },
        albumSonglist: {
          module: 'music.musichallAlbum.AlbumSongList',
          method: 'GetAlbumSongList',
          param: { albumMid: mid, begin: 0, num: 200, order: 2 }
        }
      })
    }
    
    // 检查返回数据
    const data = songsResult?.albumSonglist?.data || songsResult.data || songsResult
    const rawList = data?.list || data?.songList || data?.songlist || data?.songs || []
    
    if (!Array.isArray(rawList)) {
      console.error('[QQ音乐专辑详情] 步骤2: 获取失败，歌曲列表格式异常')
      return res.status(500).json({ error: '获取专辑详情失败' })
    }
    // qq-music-api has returned both direct song objects and wrapped songInfo objects.
    const songs = rawList.map(item => {
      const song = item.songInfo || item.song || item
      const album = song.album || {}
      return {
        songid: song.songid || song.songID || song.id,
        songmid: song.songmid || song.songMID || song.mid,
        songname: song.songname || song.songName || song.name || song.title,
        singer: song.singer || song.artists || [],
        albumid: song.albumid || album.id,
        albummid: song.albummid || album.mid || mid,
        albumname: song.albumname || album.name,
        interval: song.interval || song.duration,
        size128: song.size128,
        pay: song.pay || {}
      }
    }).filter(song => song.songid || song.songmid)

    if (songs.length > 0) {
      console.log('[QQ音乐专辑详情] 前3首歌:', songs.slice(0, 3).map(s => s.songname))
    }

    // 合并专辑信息
    const firstSong = songs[0] || {}
    
    // 优先使用 API 返回的数据，如果没有则从歌曲列表推断
    const albumName = albumInfo?.albumName || firstSong.albumname || '未知专辑'
    const singerName = albumInfo?.singer_name || firstSong.singer?.[0]?.name || ''
    const singerMid = albumInfo?.singer_mid || firstSong.singer?.[0]?.mid || ''
    const pubTime = albumInfo?.pub_time || ''
    const desc = albumInfo?.desc || ''
    const genre = albumInfo?.genre || ''
    const lan = albumInfo?.lan || ''
    const company = albumInfo?.company || ''
    
    console.log('[QQ音乐专辑详情] 最终返回数据:', {
      albumName,
      singerName,
      pubTime,
      desc: desc ? `有数据(${desc.length}字符)` : '无数据',
      genre,
      lan,
      company,
      songsCount: songs.length
    })
    
    res.json({
      albumID: firstSong.albumid,
      albumMID: data.albummid || mid,
      albumName: albumName,
      singer_name: singerName,
      singer_mid: singerMid,
      pub_time: pubTime,
      desc: desc,
      genre: genre,
      lan: lan,
      company: company,
      songs: songs
    })
  } catch (error) {
    console.error('[QQ音乐专辑详情] 错误:', error)
    res.status(500).json({ error: error.message })
  }
})

// QQ音乐 - 获取艺人歌曲
app.get('/api/qq/artist/songs', async (req, res) => {
  try {
    const { mid, limit = 50 } = req.query
    if (!mid) {
      return res.status(400).json({ error: '请提供歌手mid' })
    }
    // 使用 qq-music-api 库获取歌手歌曲
    const result = await qqMusicApi.api('singer/songs', { singermid: mid, num: limit })
    // 兼容两种数据结构：result.data 或直接 result
    const data = result.data || result
    
    if (!data || !data.list) {
      console.error('[QQ音乐艺人歌曲] 获取失败，没有歌曲列表')
      return res.status(500).json({ error: '获取歌手歌曲失败', songs: [] })
    }

    const songs = (data.list || []).map(item => ({
      songid: item.id,
      songmid: item.mid,
      songname: item.name || item.title,
      albumid: item.album?.id,
      albummid: item.album?.mid,
      albumname: item.album?.name || item.album?.title,
      singer: item.singer || [],
      interval: item.interval || 0,  // 添加歌曲时长（秒）
      pay: item.pay || {}  // 添加VIP信息
    }))
    // 输出前5首歌曲用于调试
    if (songs.length > 0) {
      console.log('[QQ音乐艺人歌曲] 前5首歌曲:', JSON.stringify(songs.slice(0, 5), null, 2))
    }
    
    res.json({ songs, total: data.total })
  } catch (error) {
    console.error('[QQ音乐艺人歌曲] 错误:', error)
    res.status(500).json({ error: error.message, songs: [] })
  }
})

// 重试辅助函数
async function retryApiCall(apiFunc, maxRetries = 3, delayMs = 500) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const result = await apiFunc()
      
      // 检查是否是网络错误（502等）
      if (result.status === 502 || (result.body && result.body.code === 502)) {
        if (i < maxRetries - 1) {
          const waitTime = delayMs * (i + 1) // 递增延迟
          await new Promise(resolve => setTimeout(resolve, waitTime))
          continue
        }
      }
      
      return result
    } catch (error) {
      console.error(`[重试机制] 第 ${i + 1} 次尝试异常:`, error.message)
      if (i < maxRetries - 1) {
        const waitTime = delayMs * (i + 1)
        await new Promise(resolve => setTimeout(resolve, waitTime))
      } else {
        throw error
      }
    }
  }
}

// 网易云音乐 - 获取艺人详情
app.get('/api/netease/artist', async (req, res) => {
  try {
    const { id } = req.query
    if (!id) {
      console.error('[网易云艺人详情] ❌ 缺少歌手id参数')
      return res.status(400).json({ error: '请提供歌手id' })
    }
    if (!NeteaseAPI || !NeteaseAPI.artists || !NeteaseAPI.artist_detail || !NeteaseAPI.artist_desc) {
      console.error('[网易云艺人详情] ❌ API 未初始化')
      return res.status(500).json({ error: 'API 未初始化' })
    }

    // 1. 获取艺人基本信息和热门歌曲（带重试）
    const artistResult = await retryApiCall(() => NeteaseAPI.artists({ id: id }))
    if (artistResult.status !== 200 || !artistResult.body || !artistResult.body.artist) {
      console.error('[网易云艺人详情] ❌ 步骤1失败, body:', JSON.stringify(artistResult.body).substring(0, 200))
      return res.status(500).json({ error: '获取歌手详情失败' })
    }

    const artist = artistResult.body.artist
    const hotSongs = artistResult.body.hotSongs || []
    // 2. 获取艺人详细信息（briefDesc）- 带重试
    try {
      const detailResult = await retryApiCall(() => NeteaseAPI.artist_detail({ id: id }))
      if (detailResult.status === 200 && detailResult.body && detailResult.body.data) {
        if (detailResult.body.data.briefDesc) {
          artist.briefDesc = detailResult.body.data.briefDesc
        } else {
        }
      } else {
      }
    } catch (error) {
      console.error('[网易云艺人详情] ❌ 步骤2异常（已重试3次）:', error.message)
    }

    // 3. 获取艺人介绍（intro）- 带重试
    try {
      const descResult = await retryApiCall(() => NeteaseAPI.artist_desc({ id: id }))
      if (descResult.status === 200 && descResult.body) {
        if (descResult.body.introduction) {
          artist.intro = descResult.body.introduction
        } else {
        }
        
        // 如果没有 briefDesc，使用 briefDesc
        if (!artist.briefDesc && descResult.body.briefDesc) {
          artist.briefDesc = descResult.body.briefDesc
        }
      } else {
      }
    } catch (error) {
      console.error('[网易云艺人详情] ❌ 步骤3异常（已重试3次）:', error.message)
    }

    // 4. 获取粉丝数 - 带重试
    let fans = 0
    try {
      const followResult = await retryApiCall(() => NeteaseAPI.artist_follow_count({ id: id }))
      if (followResult.status === 200 && followResult.body && followResult.body.data) {
        fans = followResult.body.data.fansCnt || 0
      } else {
      }
    } catch (error) {
    }
    console.log('[网易云艺人详情] 🎉 返回数据: artist keys=', Object.keys(artist).join(', '))
    
    res.json({ 
      artist: artist,
      hotSongs: hotSongs,
      fans: fans
    })
  } catch (error) {
    console.error('[网易云艺人详情] ❌ 异常错误:', error.message)
    console.error('[网易云艺人详情] ❌ 堆栈:', error.stack)
    res.status(500).json({ error: error.message })
  }
})

// 网易云音乐 - 获取艺人全部歌曲
app.get('/api/netease/artist/songs', async (req, res) => {
  try {
    const { id, limit = 200, offset = 0 } = req.query
    if (!id) {
      return res.status(400).json({ error: '请提供歌手id' })
    }
    if (!NeteaseAPI || !NeteaseAPI.artist_songs) {
      return res.status(500).json({ error: 'API 未初始化', songs: [], total: 0 })
    }

    // 使用重试机制调用 NeteaseCloudMusicApi 的 artist_songs 接口
    const result = await retryApiCall(() => NeteaseAPI.artist_songs({
      id: id,
      limit: limit,
      offset: offset
    }))

    if (result.status !== 200 || !result.body || !result.body.songs) {
      console.error('[网易云艺人歌曲] 获取失败:', result.body)
      // 返回 200 状态码但数据为空，避免前端卡住
      return res.json({ songs: [], total: 0, more: false, error: '获取歌手歌曲失败' })
    }

    const songs = result.body.songs || []
    const total = result.body.total || songs.length

    // 输出前5首歌的详细信息用于调试
    songs.slice(0, 5).forEach((song, index) => {
      console.log(`  ${index + 1}. ${song.name} - ${song.ar?.map(a => a.name).join(', ')} (songId: ${song.id})`)
    })
    res.json({ 
      songs: songs,
      total: total,
      more: result.body.more || false
    })
  } catch (error) {
    console.error('[网易云艺人歌曲] 错误:', error)
    // 返回 200 状态码但数据为空，避免前端卡住
    res.json({ songs: [], total: 0, more: false, error: error.message })
  }
})

// 网易云音乐 - 获取艺人专辑
app.get('/api/netease/artist/albums', async (req, res) => {
  try {
    const { id, limit = 200, offset = 0 } = req.query
    if (!id) {
      return res.status(400).json({ error: '请提供歌手id', albums: [] })
    }
    const response = await fetch(`https://music.163.com/api/artist/albums/${id}?limit=${limit}&offset=${offset}`, {
      headers: {
        'Referer': 'https://music.163.com/',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    })
    const json = await response.json()

    if (!json.hotAlbums) {
      console.error('[网易云艺人专辑] 获取失败:', json)
      return res.status(500).json({ error: '获取歌手专辑失败', hotAlbums: [], artist: json.artist || {} })
    }
    res.json({ 
      hotAlbums: json.hotAlbums,
      artist: json.artist || {},
      more: json.more || false
    })
  } catch (error) {
    console.error('[网易云艺人专辑] 错误:', error)
    res.status(500).json({ error: error.message, hotAlbums: [], artist: {} })
  }
})

// QQ音乐 - 获取艺人专辑
app.get('/api/qq/artist/albums', async (req, res) => {
  try {
    const { mid, page = 1, pageSize = 50 } = req.query
    if (!mid) {
      return res.status(400).json({ error: '请提供歌手mid', albumList: [] })
    }

    const pageNum = parseInt(page)
    const pageSizeNum = parseInt(pageSize)
    // 使用 qq-music-api 库获取歌手专辑
    const result = await qqMusicApi.api('singer/album', { 
      singermid: mid, 
      page: pageNum - 1, // API从0开始计数
      pageSize: pageSizeNum 
    })
    // 兼容两种数据结构：result.data 或直接 result
    const data = result.data || result
    
    if (!data || !data.list) {
      console.error('[QQ音乐艺人专辑] 获取失败，没有专辑列表')
      return res.status(500).json({ error: '获取歌手专辑失败', albumList: [] })
    }
    const albums = (data.list || []).map(item => ({
      albumID: item.albumid || item.id,
      albumMID: item.album_mid || item.mid,
      albumName: item.album_name || item.name || item.title,
      albumPic: `https://y.gtimg.cn/music/photo_new/T002R300x300M000${item.album_mid || item.mid}.jpg`,
      singer_name: data.singer_name || data.name,
      singer_mid: data.singer_mid || mid,
      pub_time: item.pub_time || item.time_public,
      song_count: item.song_count
    }))
    if (albums.length > 0 && pageNum === 1) {
      console.log('[QQ音乐艺人专辑] 前5张专辑:', JSON.stringify(albums.slice(0, 5), null, 2))
    }
    res.json({ albumList: albums, total: data.total, page: pageNum, pageSize: pageSizeNum })
  } catch (error) {
    console.error('[QQ音乐艺人专辑] 错误:', error)
    res.status(500).json({ error: error.message, albumList: [] })
  }
})

// 网易云音乐 - 获取艺人MV
app.get('/api/netease/artist/mvs', async (req, res) => {
  try {
    const { id, limit = 200, offset = 0 } = req.query
    if (!id) {
      return res.status(400).json({ error: '请提供歌手id', mvs: [] })
    }
    if (!NeteaseAPI || !NeteaseAPI.artist_mv) {
      return res.status(500).json({ error: 'API 未初始化', mvs: [], hasMore: false, total: 0 })
    }

    // 使用 NeteaseCloudMusicApi 的 artist_mv 接口
    const result = await NeteaseAPI.artist_mv({
      id: id,
      limit: limit,
      offset: offset
    })

    if (result.status !== 200 || !result.body) {
      console.error('[网易云艺人MV] 获取失败:', result.body)
      return res.json({ mvs: [], hasMore: false, total: 0 })
    }

    const mvs = result.body.mvs || []
    const hasMore = result.body.hasMore || false
    const total = result.body.total || mvs.length
    res.json({ 
      mvs: mvs,
      hasMore: hasMore,
      total: total
    })
  } catch (error) {
    console.error('[网易云艺人MV] 错误:', error)
    res.status(500).json({ error: error.message, mvs: [], hasMore: false, total: 0 })
  }
})

// 网易云音乐 - 获取MV播放地址
app.get('/api/netease/mv/url', async (req, res) => {
  try {
    const { id, r = 1080 } = req.query
    if (!id) {
      return res.status(400).json({ error: '请提供MV id' })
    }
    if (!NeteaseAPI || !NeteaseAPI.mv_url) {
      return res.status(500).json({ error: 'API 未初始化' })
    }

    // 使用 NeteaseCloudMusicApi 的 mv_url 接口
    const result = await NeteaseAPI.mv_url({
      id: id,
      r: r
    })

    if (result.status !== 200 || !result.body) {
      console.error('[网易云MV播放地址] 获取失败:', result.body)
      return res.status(500).json({ error: '获取MV播放地址失败' })
    }

    // 网易云 MV 视频地址是 http；Electron file:// 页面下 http 会被混合内容策略拦截，
    // 转成 https（网易云视频 CDN 支持 https）保证在打包版/开发版都能播放。
    const body = JSON.parse(JSON.stringify(result.body || {}))
    const mvUrl = body?.data?.url
    if (typeof mvUrl === 'string' && mvUrl.startsWith('http://')) {
      body.data.url = mvUrl.replace(/^http:\/\//, 'https://')
    }
    res.json(body)
  } catch (error) {
    console.error('[网易云MV播放地址] 错误:', error)
    res.status(500).json({ error: error.message })
  }
})

// 网易云音乐 - 获取MV详情
app.get('/api/netease/mv/detail', async (req, res) => {
  try {
    const { mvid } = req.query
    if (!mvid) {
      return res.status(400).json({ error: '请提供MV id' })
    }
    if (!NeteaseAPI || !NeteaseAPI.mv_detail) {
      return res.status(500).json({ error: 'API 未初始化' })
    }

    // 使用 NeteaseCloudMusicApi 的 mv_detail 接口
    const result = await NeteaseAPI.mv_detail({
      mvid: mvid
    })

    if (result.status !== 200 || !result.body) {
      console.error('[网易云MV详情] 获取失败:', result.body)
      return res.status(500).json({ error: '获取MV详情失败' })
    }
    res.json(result.body)
  } catch (error) {
    console.error('[网易云MV详情] 错误:', error)
    res.status(500).json({ error: error.message })
  }
})
// 网易云音乐 - 歌单控制功能

// 创建歌单
app.post('/api/netease/playlist/create', async (req, res) => {
  try {
    const { name, privacy, type, cookie } = req.body
    if (!name) {
      return res.status(400).json({ error: '请提供歌单名称' })
    }
    if (String(name).trim().length > 40) {
      return res.status(400).json({ error: '歌单名称过长' })
    }
    if (!NeteaseAPI || !NeteaseAPI.playlist_create) {
      return res.status(500).json({ error: 'API 未初始化' })
    }

    const result = await NeteaseAPI.playlist_create({
      name: name,
      privacy: privacy || '0', // 0: 公开, 10: 私密
      type: type || 'NORMAL', // NORMAL: 普通, SHARED: 共享
      cookie: cookie
    })

    if (result.status !== 200 || !result.body) {
      console.error('[网易云创建歌单] 创建失败:', result.body)
      return res.status(500).json({ error: '创建歌单失败' })
    }
    res.json(result.body)
  } catch (error) {
    console.error('[网易云创建歌单] 错误:', error)
    res.status(500).json({ error: error.message })
  }
})

// 删除歌单
app.post('/api/netease/playlist/delete', async (req, res) => {
  try {
    const { id, cookie } = req.body
    if (!id) {
      return res.status(400).json({ error: '请提供歌单ID' })
    }
    if (!NeteaseAPI || !NeteaseAPI.playlist_delete) {
      return res.status(500).json({ error: 'API 未初始化' })
    }

    const result = await NeteaseAPI.playlist_delete({
      id: id,
      cookie: cookie
    })

    if (result.status !== 200 || !result.body) {
      console.error('[网易云删除歌单] 删除失败:', result.body)
      return res.status(500).json({ error: '删除歌单失败' })
    }
    res.json(result.body)
  } catch (error) {
    console.error('[网易云删除歌单] 错误:', error)
    res.status(500).json({ error: error.message })
  }
})

// 更新歌单信息
app.post('/api/netease/playlist/update', async (req, res) => {
  try {
    const { id, name, desc, tags, cookie } = req.body
    if (!id) {
      return res.status(400).json({ error: '请提供歌单ID' })
    }
    if (name !== undefined && String(name).trim().length > 40) {
      return res.status(400).json({ error: '歌单名称过长' })
    }
    if (desc !== undefined && String(desc).length > 980) {
      return res.status(400).json({ error: '歌单简介过长' })
    }
    if (!NeteaseAPI || !NeteaseAPI.playlist_update) {
      return res.status(500).json({ error: 'API 未初始化' })
    }

    const result = await NeteaseAPI.playlist_update({
      id: id,
      name: name,
      desc: desc,
      tags: tags,
      cookie: cookie
    })

    if (result.status !== 200 || !result.body) {
      console.error('[网易云更新歌单] 更新失败:', result.body)
      return res.status(500).json({ error: '更新歌单失败' })
    }
    res.json(result.body)
  } catch (error) {
    console.error('[网易云更新歌单] 错误:', error)
    res.status(500).json({ error: error.message })
  }
})

// 管理歌单歌曲（添加/删除）
app.post('/api/netease/playlist/tracks', async (req, res) => {
  try {
    const { op, pid, tracks, cookie } = req.body || {}
    const normalizedPid = String(pid || '').trim()
    const normalizedTracks = Array.isArray(tracks)
      ? tracks.map(track => String(track).trim()).filter(Boolean).join(',')
      : String(tracks || '').trim()
    if (!['add', 'del'].includes(op) || !/^\d+$/.test(normalizedPid) || !normalizedTracks) {
      return res.status(400).json({ error: '请提供操作类型、歌单ID和歌曲ID' })
    }
    if (!cookie) {
      return res.status(401).json({ code: 301, error: '需要登录网易云音乐账号' })
    }
    if (!NeteaseAPI || !NeteaseAPI.playlist_tracks) {
      return res.status(500).json({ error: 'API 未初始化' })
    }

    const result = await NeteaseAPI.playlist_tracks({
      op: op, // add: 添加, del: 删除
      pid: normalizedPid,
      tracks: normalizedTracks,
      cookie: cookie
    })

    if (result.status !== 200 || !result.body) {
      console.error('[网易云管理歌单歌曲] 操作失败:', result.body)
      return res.status(500).json({ error: '管理歌单歌曲失败' })
    }
    res.json(result.body)
  } catch (error) {
    console.error('[网易云管理歌单歌曲] 错误:', error)
    res.status(500).json({ error: error.message })
  }
})

// 收藏/取消收藏歌单
app.post('/api/netease/playlist/subscribe', async (req, res) => {
  try {
    const { t, id, cookie } = req.body
    if (!id) {
      return res.status(400).json({ error: '请提供歌单ID' })
    }
    if (!NeteaseAPI || !NeteaseAPI.playlist_subscribe) {
      return res.status(500).json({ error: 'API 未初始化' })
    }

    const result = await NeteaseAPI.playlist_subscribe({
      t: t, // 1: 收藏, 2: 取消收藏
      id: id,
      cookie: cookie
    })

    if (result.status !== 200 || !result.body) {
      console.error('[网易云收藏歌单] 操作失败:', result.body)
      return res.status(500).json({ error: '收藏歌单失败' })
    }
    res.json(result.body)
  } catch (error) {
    console.error('[网易云收藏歌单] 错误:', error)
    res.status(500).json({ error: error.message })
  }
})

// 更新歌单封面
app.post('/api/netease/playlist/cover', async (req, res) => {
  try {
    const { id, imageData, imgSize, imgX, imgY, cookie } = req.body
    if (!id || !imageData) {
      return res.status(400).json({ error: '请提供歌单ID和封面图片' })
    }
    if (!NeteaseAPI || !NeteaseAPI.playlist_cover_update) {
      return res.status(500).json({ error: 'API 未初始化' })
    }

    const base64 = String(imageData).replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, '')
    const imageBuffer = Buffer.from(base64, 'base64')
    if (!imageBuffer.length || imageBuffer.length > 10 * 1024 * 1024) {
      return res.status(400).json({ error: '封面图片无效或体积过大' })
    }

    const result = await NeteaseAPI.playlist_cover_update({
      id,
      imgSize: imgSize || 600,
      imgX: imgX || 0,
      imgY: imgY || 0,
      imgFile: {
        name: `playlist-${id}.jpg`,
        data: imageBuffer
      },
      cookie
    })

    if (result.status !== 200 || !result.body || result.body.code !== 200) {
      console.error('[网易云更新歌单封面] 更新失败:', result.body)
      return res.status(500).json({ error: result.body?.message || result.body?.msg || '更新歌单封面失败' })
    }
    res.json(result.body)
  } catch (error) {
    console.error('[网易云更新歌单封面] 错误:', error)
    res.status(500).json({ error: error.message })
  }
})


// QQ音乐 - 获取艺人MV
app.get('/api/qq/artist/mvs', async (req, res) => {
  try {
    const { mid, page = 1, pageSize = 50 } = req.query
    if (!mid) {
      return res.status(400).json({ error: '请提供歌手mid', mvList: [] })
    }

    const pageNum = parseInt(page)
    const pageSizeNum = parseInt(pageSize)
    // 使用 qq-music-api 库获取歌手MV
    const result = await qqMusicApi.api('singer/mv', {
      singermid: mid,
      pageNo: pageNum,
      pageSize: pageSizeNum
    })
    // 兼容两种数据结构：result.data 或直接 result
    const data = result.data || result
    
    if (!data || !data.list) {
      console.error('[QQ音乐艺人MV] 获取失败，没有MV列表')
      return res.status(500).json({ error: '获取歌手MV失败', mvList: [] })
    }

    const mvs = (data.list || []).map(item => {
      const coverUrl = normalizeQQImageUrl(
        item.pic || item.cover_pic || item.coverpic || item.picurl || item.cover
      )
      
      return {
        vid: item.vid,
        name: item.name || item.title,
        picurl: coverUrl,
        playcnt: item.playcnt || item.playCount || item.listenCount,
        pubdate: item.pubdate || item.publish_date || item.date,
        duration: item.duration
      }
    })
    if (mvs.length > 0 && pageNum === 1) {
      console.log('[QQ音乐艺人MV] 前5个MV:', JSON.stringify(mvs.slice(0, 5), null, 2))
    }
    res.json({ mvList: mvs, total: data.total, page: pageNum, pageSize: pageSizeNum })
  } catch (error) {
    console.error('[QQ音乐艺人MV] 错误:', error)
    res.status(500).json({ error: error.message, mvList: [] })
  }
})

// QQ音乐 - 获取MV播放地址（直接调 GetMvUrls，完整认证 comm；qq-music-api 版缺认证字段会返回空）
app.get('/api/qq/mv/url', async (req, res) => {
  try {
    const { vid } = req.query
    if (!vid) {
      return res.status(400).json({ error: '请提供视频vid' })
    }
    const cookie = String(req.query.cookie || '')
    // 播放类路由：请求 cookie 仅本次使用，不回写全局登录态。
    // 请求未带 cookie 时回退到全局登录态（登录后 setCookie 已同步到全局）。
    const activeCookie = resolveRequestCookie(cookie) || qqMusicCookie
    console.log('[QQ音乐MV播放地址] Cookie状态:', activeCookie ? `已设置 (${activeCookie.length}字符)` : '未设置')

    const parsedCookie = parseQQCookie(activeCookie)
    const musicId = String(parsedCookie.uin || parsedCookie.qqmusic_uin || '').replace(/\D/g, '')
    const musicKey = parsedCookie.qm_keyst || parsedCookie.qqmusic_key || ''

    const payload = {
      comm: {
        ct: 24, cv: 4747474, platform: 'yqq.json',
        ...(musicId ? { uin: musicId, qq: musicId } : {}),
        ...(musicKey ? {
          authst: musicKey,
          tmeLoginType: Number(parsedCookie.tmeLoginType) || Number(parsedCookie.login_type) || undefined,
          g_tk: qqHash33(musicKey),
        } : {}),
        format: 'json', inCharset: 'utf-8', outCharset: 'utf-8', notice: 0, need_new_code: 1
      },
      req_0: { module: 'gosrf.Stream.MvUrlProxy', method: 'GetMvUrls', param: { vids: [String(vid)], request_typet: 10001 } }
    }
    const resp = await axios.post('https://u.y.qq.com/cgi-bin/musicu.fcg', payload, {
      headers: { ...QQ_HEADERS, Cookie: activeCookie, 'Content-Type': 'application/json' },
      validateStatus: () => true
    })
    const d = resp.data?.req_0 || resp.data
    const mv = d?.data?.[vid] || {}
    const mp4 = Array.isArray(mv.mp4) ? mv.mp4 : []
    // 收集各档位的免费流（优先 freeflow_url，其次 url；每档取最高清）
    const urls = []
    for (const obj of mp4) {
      const candidates = Array.isArray(obj.freeflow_url) && obj.freeflow_url.length > 0
        ? obj.freeflow_url
        : Array.isArray(obj.url) ? obj.url : []
      if (candidates.length > 0) urls.push(candidates[candidates.length - 1])
    }

    if (urls.length === 0) {
      // freeflow_url 与是否登录无关——为空即该 MV 无免费播放源
      return res.status(200).json({
        url: null,
        error: '该MV暂无免费播放源，可能需VIP或受地区限制',
        needCookie: !activeCookie,
        vid: vid
      })
    }

    // 返回最高清晰度的URL（最后一个）
    const bestUrl = urls[urls.length - 1]
    console.log('[QQ音乐MV播放地址] 成功获取, URL:', bestUrl ? bestUrl.substring(0, 100) + '...' : 'null')
    res.json({
      url: bestUrl,
      qualities: urls.map((url, index) => ({ url, quality: `quality_${index}` }))
    })

  } catch (error) {
    console.error('[QQ音乐MV播放地址] 错误:', error)
    res.status(500).json({ error: error.message })
  }
})

// QQ 歌曲关联 MV（GetSongRelatedMv）
app.get('/api/qq/song/mv', async (req, res) => {
  try {
    const { id } = req.query
    if (!id) return res.status(400).json({ error: '请提供歌曲ID' })
    const result = await qqMusicApi.api('song/mv', { id: String(id) })
    res.json({ result: 100, data: result })
  } catch (error) {
    console.error('[QQ歌曲关联MV] 获取失败:', error?.message || error)
    res.status(502).json({ result: 500, error: error?.message || '获取失败' })
  }
})

// QQ MV 点赞/取消（mv/like，type=1 赞 type=0 取消）
app.get('/api/qq/mv/like', async (req, res) => {
  try {
    const { id, type = 1, cookie } = req.query
    if (!id) return res.status(400).json({ error: '请提供MV ID' })
    useQQMusicCookie(cookie)
    const result = await qqMusicApi.api('mv/like', { id: String(id), type: String(type), ownCookie: true })
    res.json({ result: 100, data: result })
  } catch (error) {
    console.error('[QQ MV点赞] 操作失败:', error?.message || error)
    res.status(502).json({ result: 500, error: error?.message || '操作失败' })
  }
})

// QQ 批量获取歌曲播放链接（song/urls）
app.get('/api/qq/song/urls', async (req, res) => {
  try {
    const { mids, quality = '128', cookie } = req.query
    if (!mids) return res.status(400).json({ error: '请提供歌曲mid（逗号分隔）' })
    useQQMusicCookie(cookie)
    const midList = String(mids).split(',').filter(Boolean).slice(0, 20)
    const results = await Promise.allSettled(midList.map(mid => qqMusicApi.api('song/url', { id: mid, type: String(quality), ownCookie: true })))
    const map = {}
    results.forEach((r, i) => {
      const mid = midList[i]
      map[mid] = r.status === 'fulfilled' && r.value?.url ? r.value.url : null
    })
    res.json({ result: 100, data: { urls: map } })
  } catch (error) {
    console.error('[QQ批量播放链接] 获取失败:', error?.message || error)
    res.status(502).json({ result: 500, error: error?.message || '获取失败' })
  }
})

// QQ 歌手分类（singer/category）
app.get('/api/qq/artist/category', async (req, res) => {
  try {
    const result = await qqMusicApi.api('singer/category')
    res.json({ result: 100, data: result })
  } catch (error) {
    console.error('[QQ歌手分类] 获取失败:', error?.message || error)
    res.status(502).json({ result: 500, error: error?.message || '获取失败' })
  }
})

// QQ 歌手列表（singer/list）
app.get('/api/qq/artist/list', async (req, res) => {
  try {
    const { type = -100, area = -100, sex = -100, genre = -100, index = 0, pageNo = 1, pageSize = 20 } = req.query
    const result = await qqMusicApi.api('singer/list', {
      type: Number(type), area: Number(area), sex: Number(sex), genre: Number(genre),
      index: Number(index), pageNo: Number(pageNo), pageSize: Number(pageSize)
    })
    res.json({ result: 100, data: result })
  } catch (error) {
    console.error('[QQ歌手列表] 获取失败:', error?.message || error)
    res.status(502).json({ result: 500, error: error?.message || '获取失败' })
  }
})

// QQ音乐 - 获取MV详情
app.get('/api/qq/mv/detail', async (req, res) => {
  try {
    const { vid } = req.query
    if (!vid) {
      return res.status(400).json({ error: '请提供视频vid' })
    }
    // 播放类路由：请求 cookie 仅本次使用，不回写全局登录态。
    resolveRequestCookie(req.query.cookie)
    // 使用 qq-music-api 库获取MV详情，参数名为 id
    const result = await qqMusicApi.api('mv', { id: vid })
    console.log('[QQ音乐MV详情] 接口返回data keys:', Object.keys(result.data || result || {}))
    
    const rawData = result.data || result
    // MV详情在 info 字段中
    const data = rawData.info || rawData
    
    console.log('[QQ音乐MV详情] info数据:', data ? Object.keys(data) : 'null')
    
    if (!data) {
      console.error('[QQ音乐MV详情] 获取失败，没有MV数据')
      return res.status(500).json({ error: '获取MV详情失败' })
    }

    const coverUrl = normalizeQQImageUrl(
      data.cover_pic || data.coverpic || data.pic || data.picurl || data.cover
    )
    res.json({
      vid: data.vid || vid,
      name: data.name || data.title,
      singer: data.singer_name || data.singers?.map(item => item.name).filter(Boolean).join('、') || data.singer?.[0]?.name,
      picurl: coverUrl,
      playcnt: data.playcnt || data.playCount,
      pubdate: data.pubdate || data.publish_date,
      desc: data.desc || data.desc_txt
    })
  } catch (error) {
    console.error('[QQ音乐MV详情] 错误:', error)
    res.status(500).json({ error: error.message })
  }
})

app.get('/api/qq/suggest', async (req, res) => {
  try {
    const { keywords } = req.query
    if (!keywords) {
      return res.status(400).json({ error: '请提供搜索关键词', suggestions: [] })
    }

    // 使用smartbox API获取搜索建议
    const url = new URL(QQ_SMARTBOX_URL)
    url.searchParams.set('format', 'json')
    url.searchParams.set('key', keywords)
    url.searchParams.set('g_tk', '5381')
    url.searchParams.set('loginUin', '0')
    url.searchParams.set('hostUin', '0')
    url.searchParams.set('inCharset', 'utf8')
    url.searchParams.set('outCharset', 'utf-8')
    url.searchParams.set('notice', '0')
    url.searchParams.set('platform', 'yqq.json')
    url.searchParams.set('needNewCode', '1')

    const response = await fetch(url.toString(), { 
      headers: {
        ...QQ_HEADERS,
        'Referer': 'https://y.qq.com/'
      }
    })
    const json = await response.json()
    
    const suggestions = []
    
    // 优先添加歌手建议
    if (json?.data?.singer?.itemlist) {
      json.data.singer.itemlist.slice(0, 3).forEach(item => {
        suggestions.push({
          type: 'singer',
          name: `🎤 ${item.name}`,
          keyword: item.name
        })
      })
    }
    
    // 添加专辑建议
    if (json?.data?.album?.itemlist) {
      json.data.album.itemlist.slice(0, 2).forEach(item => {
        suggestions.push({
          type: 'album',
          name: `💿 ${item.name} - ${item.singer || ''}`,
          keyword: item.name
        })
      })
    }
    
    // 最后添加歌曲建议
    if (json?.data?.song?.itemlist) {
      json.data.song.itemlist.slice(0, 5).forEach(item => {
        // 处理歌手信息 - 可能是数组或字符串
        let artistName = ''
        if (Array.isArray(item.singer)) {
          artistName = item.singer.map(s => s.name).join('/')
        } else if (typeof item.singer === 'string') {
          artistName = item.singer
        } else if (item.singer?.name) {
          artistName = item.singer.name
        }
        
        suggestions.push({
          type: 'song',
          name: `🎵 ${item.name}${artistName ? ' - ' + artistName : ''}`,
          keyword: item.name
        })
      })
    }
    
    res.json({ suggestions })
  } catch (error) {
    console.error('QQ音乐搜索建议错误:', error)
    res.status(500).json({ error: error.message, suggestions: [] })
  }
})

// ── 酷狗音乐（kugou.com）代理路由 ─────────────────────────────
// 公开接口（搜索）由前端 kugouService 直连；以下为需登录的接口（播放直链/歌词）。

/** 酷狗播放数据（wwwapi.kugou.com r=play/getdata，需 kg_token cookie） */
app.get('/api/kugou/song/url', async (req, res) => {
  try {
    const { hash, albumId, album_audio_id, cookie } = req.query
    if (!hash) return res.status(400).json({ error: '请提供歌曲 hash' })
    const result = await resolveKugouSongUrl({
      hash,
      albumId: String(albumId || ''),
      albumAudioId: Number(album_audio_id || 0) || undefined,
    }, cookie ? String(cookie).replace(/^['"]|['"]$/g, '') : '')
    if (result.playable && result.url) {
      res.json({ url: result.url, level: result.level, source: result.source, songName: '', author: '' })
    } else {
      res.status(403).json({ error: result.message || '酷狗播放获取失败', reason: result.reason || 'url_unavailable' })
    }
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
})

/** 酷狗歌词（krcs.kugou.com，规范 LRC） */
app.get('/api/kugou/lyric', async (req, res) => {
  try {
    const { hash, album_audio_id, duration } = req.query
    if (!hash) return res.status(400).json({ error: '请提供歌曲 hash' })
    const result = await fetchKugouLyric(String(hash), Number(album_audio_id || 0) || undefined, Number(duration) || 0)
    if (!result.lyric) return res.status(404).json({ error: '未获取到歌词' })
    res.json({ lyric: result.lyric, translation: result.trans || '' })
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
})

// ── 酷狗公开接口代理（kugou.com 不返回 CORS 头，渲染进程需经本地服务转发）────────

const KG_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

/** 酷狗搜索（songsearch.kugou.com/song_search_v2） */
app.get('/api/kugou/search', async (req, res) => {
  try {
    const { keyword, limit = '30' } = req.query
    if (!keyword) return res.status(400).json({ error: '请提供关键词' })
    const url = new URL('https://songsearch.kugou.com/song_search_v2')
    url.searchParams.set('keyword', String(keyword))
    url.searchParams.set('page', '1')
    url.searchParams.set('pagesize', String(limit))
    url.searchParams.set('platform', 'WebFilter')
    const resp = await fetch(url.toString(), {
      headers: { 'User-Agent': KG_UA, Referer: 'https://www.kugou.com/' },
      signal: AbortSignal.timeout(10000),
    })
    const json = await resp.json()
    res.json(json?.data?.lists || [])
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
})

/** 酷狗榜单分类列表（m.kugou.com/rank/list） */
app.get('/api/kugou/rank/list', async (_req, res) => {
  try {
    const resp = await fetch('https://m.kugou.com/rank/list?json=true&page=1&pagesize=20', {
      headers: { 'User-Agent': KG_UA },
      signal: AbortSignal.timeout(10000),
    })
    const json = await resp.json()
    const list = json?.rank?.list || json?.list || []
    const ranks = list.map(item => ({
      rankid: String(item.rankid || item.rank_id || ''),
      rankname: String(item.rankname || ''),
      img: item.banner_9 || item.img_9 || item.album_img_9 || '',
      classify: item.classify,
      playTimes: item.play_times,
    })).filter(item => item.rankid && item.rankname)
    res.json(ranks)
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
})

/** 酷狗榜单歌曲（m.kugou.com/rank/info） */
app.get('/api/kugou/rank/info', async (req, res) => {
  try {
    const { rankid = '8888', page = '1', pagesize = '30' } = req.query
    const url = new URL('https://m.kugou.com/rank/info/')
    url.searchParams.set('rankid', String(rankid))
    url.searchParams.set('page', String(page))
    url.searchParams.set('pagesize', String(pagesize))
    url.searchParams.set('json', 'true')
    const resp = await fetch(url.toString(), {
      headers: { 'User-Agent': KG_UA },
      signal: AbortSignal.timeout(10000),
    })
    const json = await resp.json()
    const info = json?.info || {}
    const rawSongs = json?.songs?.list || json?.songs || []
    const songs = rawSongs.map(song => ({
      hash: String(song.hash || ''),
      filename: String(song.filename || ''),
      album_id: String(song.album_id || song.albumId || ''),
      album_audio_id: String(song.album_audio_id || ''),
      album_img: String(song.album_sizable_cover || song.album_img || song.img || ''),
      duration: Number(song.duration || 0),
      rank: Number(song.rank || 0),
    }))
    res.json({ rankname: String(info.rankname || ''), songs })
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
})

/** 酷狗歌单列表（m.kugou.com/plist/index） */
app.get('/api/kugou/playlist/list', async (req, res) => {
  try {
    const { page = '1', pagesize = '24' } = req.query
    const url = new URL('https://m.kugou.com/plist/index')
    url.searchParams.set('json', 'true')
    url.searchParams.set('page', String(page))
    url.searchParams.set('pagesize', String(pagesize))
    const resp = await fetch(url.toString(), {
      headers: { 'User-Agent': KG_UA },
      signal: AbortSignal.timeout(10000),
    })
    const json = await resp.json()
    const info = json?.plist?.list?.info || []
    const playlists = info.map(item => ({
      specialid: String(item.specialid || ''),
      name: String(item.specialname || item.name || ''),
      img: String(item.imgurl || item.img || item.icon || ''),
      playcount: Number(item.playcount || 0),
      songcount: Number(item.songcount || 0),
      songs: Array.isArray(item.songs) ? item.songs.map(s => ({
        hash: String(s.hash || ''),
        filename: String(s.filename || ''),
      })) : [],
    })).filter(item => item.specialid && item.name)
    res.json(playlists)
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
})

/** 酷狗歌单详情（m.kugou.com/plist/list/{specialid}，HTML 内嵌歌曲行） */
app.get('/api/kugou/playlist/detail', async (req, res) => {
  try {
    const { specialid, page = '1', pagesize = '50' } = req.query
    if (!specialid) return res.status(400).json({ error: '请提供歌单 ID' })
    const resp = await fetch(`https://m.kugou.com/plist/list/${String(specialid)}/?json=true&page=${page}&pagesize=${pagesize}`, {
      headers: { 'User-Agent': KG_UA },
      redirect: 'follow',
      signal: AbortSignal.timeout(12000),
    })
    // 酷狗移动端页面为 GBK 编码，需按页面字符集解码，否则中文乱码
    const charset = (resp.headers.get('content-type') || '').match(/charset=([a-z0-9-]+)/i)?.[1]?.toLowerCase() || ''
    const buffer = Buffer.from(await resp.arrayBuffer())
    const text = charset === 'gbk' || charset === 'gb2312'
      ? new TextDecoder('gbk').decode(buffer)
      : buffer.toString('utf8')
    let json = null
    try { json = JSON.parse(text) } catch { json = null }
    let songs = []
    let name = ''
    let img = ''
    if (json && json.info) {
      // JSON 响应（移动端接口）
      const info = json.info || {}
      name = String(info.specialname || info.name || '')
      img = String(info.img || '')
      const rawSongs = json.songs?.list || json.songs || []
      songs = rawSongs.map(song => ({
        hash: String(song.hash || ''),
        filename: String(song.filename || ''),
        album_id: String(song.album_id || song.albumId || ''),
        duration: Number(song.duration || 0),
        album_img: String(song.album_img || ''),
      })).filter(song => song.hash && song.filename)
    } else {
      // HTML 响应：解析歌曲列表行（<a data="hash|时长" title="歌手 - 歌名">）
      const titleMatch = text.match(/<title>([^<]*?)_精选集[^<]*<\/title>/) || text.match(/<title>([^<]*?)<\/title>/)
      name = titleMatch ? titleMatch[1].trim() : ''
      const imgMatch = text.match(/class="cover"[^>]*src="([^"]+)"/) || text.match(/<img[^>]*class="[^"]*cover[^"]*"[^>]*src="([^"]+)"/)
      if (imgMatch) img = imgMatch[1]
      const rowRe = /<a\s+title="([^"]+)"[^>]*href="[^"]*"[^>]*data="([A-Fa-f0-9]+)\|(\d+)"/g
      let m
      const seen = new Set()
      while ((m = rowRe.exec(text)) !== null) {
        const hash = m[2].toUpperCase()
        if (seen.has(hash)) continue
        seen.add(hash)
        songs.push({
          hash,
          filename: m[1].trim(),
          duration: Math.round(Number(m[3]) / 1000),
          album_id: '',
          album_img: '',
        })
        if (songs.length >= Number(pagesize)) break
      }
    }
    if (songs.length === 0) return res.status(404).json({ error: '歌单不存在或已失效' })
    res.json({ specialname: name, img, songs })
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
})

// ── 酷狗公开目录接口代理（mobilecdn.kugou.com/api/v3，无需登录/签名）────────
// 老 m.kugou.com/app/i/* 接口已下线（No Action Found），歌手/专辑/目录数据走该网关。

const KG_MOBILECDN_BASE = 'http://mobilecdn.kugou.com/api/v3'
const KG_MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148'

async function kugouMobileApi(path, params = {}) {
  const url = new URL(`${KG_MOBILECDN_BASE}${path}`)
  Object.entries({ plat: 0, version: 9108, ...params }).forEach(([k, v]) => url.searchParams.set(k, String(v)))
  const resp = await fetch(url.toString(), {
    headers: { 'User-Agent': KG_MOBILE_UA, Referer: 'http://m.kugou.com/' },
    signal: AbortSignal.timeout(12000),
  })
  if (!resp.ok) throw new Error(`酷狗目录接口 HTTP ${resp.status}`)
  const json = await resp.json()
  if (!json || Number(json.errcode) !== 0) throw new Error('酷狗目录接口返回错误')
  return json
}

function kugouMobileCover(url) {
  return String(url || '').replace(/^http:\/\//i, 'https://').replace(/\{size\}/g, '400')
}

/** 酷狗新专辑列表（mobilecdn /api/v3/album/list） */
app.get('/api/kugou/album/list', async (req, res) => {
  try {
    const { page = '1', pagesize = '24' } = req.query
    const json = await kugouMobileApi('/album/list', { page, pagesize })
    const albums = (json?.data?.info || []).map(item => ({
      albumid: String(item.albumid || ''),
      albumname: String(item.albumname || ''),
      singername: String(item.singername || ''),
      singerid: String(item.singerid || ''),
      imgurl: kugouMobileCover(item.imgurl || ''),
      publishtime: String(item.publishtime || ''),
      songcount: Number(item.songcount || 0),
    })).filter(a => a.albumid && a.albumname)
    res.json({ albums })
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
})

/** 酷狗专辑详情（album/info + album/song，封面取自专辑信息） */
app.get('/api/kugou/album/detail', async (req, res) => {
  try {
    const { albumid } = req.query
    if (!albumid) return res.status(400).json({ error: '请提供专辑 ID' })
    const [infoJson, songsJson] = await Promise.all([
      kugouMobileApi('/album/info', { albumid }),
      kugouMobileApi('/album/song', { albumid, page: 1, pagesize: 200 }),
    ])
    const info = infoJson?.data || {}
    const cover = kugouMobileCover(info.imgurl || '')
    const singerid = String(info.singerid || '')
    const songs = (songsJson?.data?.info || []).map(song => ({
      hash: String(song.hash || '').toUpperCase(),
      filename: String(song.filename || ''),
      album_id: String(song.album_id || albumid || ''),
      album_audio_id: Number(song.album_audio_id || song.audio_id || 0),
      duration: Number(song.duration || 0),
      singerid,
      album_img: cover,
    })).filter(s => s.hash && s.filename)
    res.json({
      album: {
        albumid: String(info.albumid || albumid),
        albumname: String(info.albumname || ''),
        singername: String(info.singername || ''),
        singerid,
        imgurl: cover,
        publishtime: String(info.publishtime || ''),
        intro: String(info.intro || ''),
        songcount: Number(info.songcount || songs.length),
      },
      songs,
    })
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
})

/** 酷狗歌手详情（mobilecdn /api/v3/singer/info） */
app.get('/api/kugou/singer/detail', async (req, res) => {
  try {
    const { singerid } = req.query
    if (!singerid) return res.status(400).json({ error: '请提供歌手 ID' })
    const json = await kugouMobileApi('/singer/info', { singerid })
    const d = json?.data || {}
    res.json({
      singer: {
        singerid: String(d.singerid || singerid),
        singername: String(d.singername || ''),
        imgurl: kugouMobileCover(d.imgurl || ''),
        intro: String(d.intro || d.mix_intro || ''),
        songcount: Number(d.songcount || 0),
        mvcount: Number(d.mvcount || 0),
        alias: String(d.alias || ''),
      },
    })
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
})

/** 酷狗歌手热门歌曲（singer/song；封面经歌手专辑 albumid→imgurl 映射补全） */
app.get('/api/kugou/singer/song', async (req, res) => {
  try {
    const { singerid, page = '1', pagesize = '50' } = req.query
    if (!singerid) return res.status(400).json({ error: '请提供歌手 ID' })
    const songsJson = await kugouMobileApi('/singer/song', { singerid, page, pagesize })
    // 歌手歌曲响应不含封面，用歌手专辑列表建立 albumid → 封面映射
    let coverMap = new Map()
    try {
      const albumsJson = await kugouMobileApi('/singer/album', { singerid, page: 1, pagesize: 100 })
      for (const item of albumsJson?.data?.info || []) {
        if (item.albumid) coverMap.set(String(item.albumid), kugouMobileCover(item.imgurl || ''))
      }
    } catch { /* 专辑映射失败则歌曲无封面 */ }
    const songs = (songsJson?.data?.info || []).map(song => ({
      hash: String(song.hash || '').toUpperCase(),
      filename: String(song.filename || ''),
      album_id: String(song.album_id || ''),
      album_audio_id: Number(song.album_audio_id || song.audio_id || 0),
      duration: Number(song.duration || 0),
      singerid: String(singerid),
      album_img: coverMap.get(String(song.album_id || '')) || '',
    })).filter(s => s.hash && s.filename)
    res.json({ songs, total: Number(songsJson?.data?.total || songs.length) })
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
})

/** 酷狗歌手专辑列表（singer/album） */
app.get('/api/kugou/singer/album', async (req, res) => {
  try {
    const { singerid, page = '1', pagesize = '100' } = req.query
    if (!singerid) return res.status(400).json({ error: '请提供歌手 ID' })
    const json = await kugouMobileApi('/singer/album', { singerid, page, pagesize })
    const albums = (json?.data?.info || []).map(item => ({
      albumid: String(item.albumid || ''),
      albumname: String(item.albumname || ''),
      singername: String(item.singername || ''),
      singerid: String(item.singerid || singerid),
      imgurl: kugouMobileCover(item.imgurl || ''),
      publishtime: String(item.publishtime || ''),
      songcount: Number(item.songcount || 0),
      intro: String(item.intro || ''),
    })).filter(a => a.albumid && a.albumname)
    res.json({ albums })
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
})

/** 酷狗用户信息（www.kugou.com r=user/getinfo，需登录 cookie） */
app.get('/api/kugou/user/info', async (req, res) => {
  try {
    const cookie = req.query.cookie ? String(req.query.cookie).replace(/^['"]|['"]$/g, '') : ''
    const url = new URL('https://www.kugou.com/yy/index.php')
    url.searchParams.set('r', 'user/getinfo')
    const resp = await fetch(url.toString(), {
      headers: { 'User-Agent': KG_UA, Referer: 'https://www.kugou.com/', ...(cookie ? { Cookie: cookie } : {}) },
      signal: AbortSignal.timeout(8000),
    })
    const json = await resp.json()
    const data = json?.data || json?.user_info || json?.user || {}
    res.json({
      nickname: data.nickname || data.user_name || data.userName || data.name || '',
      user_id: data.user_id || data.userid || data.id || '',
      avatar: data.avatar || data.head_img || data.headimg || data.user_pic || '',
    })
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
})

/** 酷狗用户歌单（H5 签名网关 /v7/get_all_list，绕开 www 域 WAF；需 KuGoo 会话与 token） */
app.get('/api/kugou/user/playlist', async (req, res) => {
  try {
    const cookie = req.query.cookie ? String(req.query.cookie).replace(/^['"]|['"]$/g, '') : ''
    if (!cookie) return res.status(401).json({ error: '酷狗未登录' })
    const result = await fetchKugouUserPlaylists(cookie)
    if (!result.success) return res.status(401).json({ error: result.message || result.error })
    const playlists = (result.playlists || []).map(pl => ({
      specialid: pl.id,
      name: pl.name,
      img: pl.coverUrl || '',
      songcount: pl.songcount || 0,
      playcount: pl.playcount || 0,
      isMine: pl.isMine,
    }))
    res.json(playlists)
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
})

/** 酷狗用户歌单曲目（H5 签名网关 /v4/get_list_all_file） */
app.get('/api/kugou/user/playlist/tracks', async (req, res) => {
  try {
    const { listid, page, pagesize, cookie } = req.query
    const cookieStr = cookie ? String(cookie).replace(/^['"]|['"]$/g, '') : ''
    if (!cookieStr || !listid) return res.status(400).json({ error: '缺少参数' })
    const result = await fetchKugouPlaylistTracks(String(listid), cookieStr, Number(pagesize) || 50, Number(page) || 1)
    if (!result.success) return res.status(401).json({ error: result.error })
    res.json({ songs: result.tracks, total: result.total })
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
})

/** 酷狗喜欢检查（批量 hash） */
app.post('/api/kugou/like/check', async (req, res) => {
  try {
    const { hashes, cookie } = req.body || {}
    const cookieStr = cookie ? String(cookie).replace(/^['"]|['"]$/g, '') : ''
    if (!cookieStr) return res.status(401).json({ error: '酷狗未登录' })
    const result = await kugouLikeCheckHashes(Array.isArray(hashes) ? hashes : [], cookieStr)
    if (result.error) return res.status(401).json({ error: result.error })
    res.json({ liked: result.liked })
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
})

/** 酷狗喜欢/加歌（H5 签名网关 /v6/add_song；喜欢=加入默认"我喜欢"歌单） */
app.post('/api/kugou/like', async (req, res) => {
  try {
    const { like, song, listId, cookie } = req.body || {}
    const cookieStr = cookie ? String(cookie).replace(/^['"]|['"]$/g, '') : ''
    if (!cookieStr) return res.status(401).json({ error: '酷狗未登录' })
    if (like) {
      const result = await kugouAddSongToList(String(listId || ''), song || {}, cookieStr)
      if (!result.success) return res.status(400).json({ error: result.error || '加歌失败' })
      res.json({ result: 100, platform: 'kugou', listId: result.listId })
    } else {
      // 取消喜欢：酷狗无"移除"专用轻接口，走从歌单删除（需要 fileid）——先返回支持标记
      res.json({ result: 100, platform: 'kugou', note: 'unlike-via-remove' })
    }
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
})

/** 酷狗歌单加歌（H5 签名网关 /v6/add_song） */
app.post('/api/kugou/playlist/tracks', async (req, res) => {
  try {
    const { op, pid, song, cookie } = req.body || {}
    const cookieStr = cookie ? String(cookie).replace(/^['"]|['"]$/g, '') : ''
    if (!cookieStr) return res.status(401).json({ error: '酷狗未登录' })
    if (op === 'add') {
      const result = await kugouAddSongToList(String(pid || ''), song || {}, cookieStr)
      if (!result.success) return res.status(400).json({ error: result.error || '加歌失败' })
      res.json({ result: 100, platform: 'kugou' })
    } else {
      res.status(400).json({ error: '酷狗暂不支持从歌单删除' })
    }
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
})

// ── 汽水音乐公开目录代理（火山引擎公开 API，无需登录/签名；替代抖音 DOM 抓取）──────────
const QISHUI_PUBLIC_HEADERS = {
  'Accept': 'application/json,text/plain,*/*',
  'User-Agent': 'WaveForge/0.1 (Qishui public catalog bridge)',
}
const QISHUI_PUBLIC_SEARCH_URL = 'https://api-vehicle.volcengine.com/v2/search/type'
const QISHUI_PUBLIC_CONTENTS_URL = 'https://api-vehicle.volcengine.com/v2/custom/contents'

app.get('/api/qishui/search', async (req, res) => {
  try {
    const { keyword, limit = '30', offset = '0' } = req.query
    if (!keyword) return res.status(400).json({ error: '缺少关键词' })
    const requestLimit = Math.min(100, Math.max(Number(offset) + (Number(limit) * 3 || 0), 36))
    const url = new URL(QISHUI_PUBLIC_SEARCH_URL)
    url.searchParams.set('keyword', String(keyword))
    url.searchParams.set('search_type', 'music')
    url.searchParams.set('limit', String(requestLimit))
    url.searchParams.set('real_offset', '0')
    url.searchParams.set('search_source', 'qishui')
    const resp = await fetch(url.toString(), { headers: QISHUI_PUBLIC_HEADERS, signal: AbortSignal.timeout(10000) })
    const json = await resp.json()
    const list = (json && json.data && Array.isArray(json.data.list)) ? json.data.list : []
    const songs = list.map(item => ({
      id: String(item.item_id || ''),
      name: String(item.title || ''),
      artist: String((item.author_info && item.author_info.name) || ''),
      coverUrl: String(item.cover_url || ''),
      durationMs: Number(item.duration_ms || item.duration || 0),
      album: String((item.album_info && item.album_info.name) || ''),
    })).filter(s => s.id && s.name)
    res.json({ songs })
  } catch (error) {
    res.status(500).json({ error: error.message, songs: [] })
  }
})

app.get('/api/qishui/detail', async (req, res) => {
  try {
    const { id } = req.query
    if (!id) return res.status(400).json({ error: '缺少 item_id' })
    const url = new URL(QISHUI_PUBLIC_CONTENTS_URL)
    url.searchParams.set('sources', 'qishui')
    url.searchParams.set('need_author', 'true')
    url.searchParams.set('need_album', 'true')
    url.searchParams.set('need_ugc', 'true')
    url.searchParams.set('need_stat', 'true')
    url.searchParams.set('item_ids', String(id))
    const resp = await fetch(url.toString(), { headers: QISHUI_PUBLIC_HEADERS, signal: AbortSignal.timeout(10000) })
    const json = await resp.json()
    const item = json && json.data && Array.isArray(json.data.list) ? json.data.list[0] : null
    if (!item) return res.status(404).json({ error: '未找到歌曲' })
    const lyricInfo = item.lyric_info || item.lyric || {}
    const lyric = String(
      lyricInfo.lyric_text || lyricInfo.content || lyricInfo.lyric ||
      (lyricInfo.lyric_entity && lyricInfo.lyric_entity.content) || '',
    )
    res.json({ song: item, lyric })
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
})

app.get('/api/qq/song/url', async (req, res) => {
  try {
    const { mid, id, cookie } = req.query
    if (!mid && !id) return res.status(400).json({ error: '\u8bf7\u63d0\u4f9b\u6b4c\u66f2mid\u6216id' })

    const routeDeadlineAt = Date.now() + 18_000
    const remainingTimeout = (maximum = 5000) => {
      const remaining = routeDeadlineAt - Date.now()
      if (remaining <= 250) throw new Error('QQ playback URL deadline exceeded')
      return Math.max(250, Math.min(maximum, remaining))
    }

    const songMid = String(mid || id)
    const qualityPreference = normalizeAudioQualityPreference(req.query.quality)
    const isVip = req.query.vip === 'true'
    const candidates = getQQQualityCandidates(qualityPreference, isVip)
    const normalizedCookie = cookie ? String(cookie).replace(/^['"]|['"]$/g, '') : qqMusicCookie
    console.log('[QQ URL] cookie: ' + (normalizedCookie ? 'provided' : 'missing'))

    // 播放类路由：请求 cookie 仅通过 qqMusicRequest 的 options.cookie 按本次请求
    // 传递，绝不回写全局登录态，避免并发播放请求互相冲掉登录账号。

    const parsedCookie = parseQQCookie(normalizedCookie)
    const qqUin = String(parsedCookie.uin || parsedCookie.qqmusic_uin || parsedCookie.musicid || parsedCookie.wxuin || '').replace(/\D/g, '')
    const qqMusicKey = parsedCookie.skey || parsedCookie.p_skey || parsedCookie.qm_keyst || parsedCookie.qqmusic_key || ''

    let mediaMid = songMid
    let songType = 0
    let qqFileInfo = null
    try {
      const metadata = await getQQPlaybackMetadata(songMid)
      qqFileInfo = metadata.file
      mediaMid = metadata.mediaMid
      songType = metadata.songType
    } catch (detailError) {
      console.warn('[QQ URL] failed to resolve media metadata:', detailError.message)
    }

    const qualitySizeFields = {
      flac: 'size_flac',
      ape: 'size_ape',
      '320': 'size_320mp3',
      '128': 'size_128mp3',
      m4a: 'size_48aac',
    }
    const isQQQualityAvailable = quality => {
      if (!qqFileInfo) return true
      const sizeField = qualitySizeFields[quality]
      return !sizeField || Number(qqFileInfo[sizeField] || 0) > 0
    }
    const availableCandidates = candidates.filter(isQQQualityAvailable)

    const getActualQQQuality = (url, fallbackQuality) => {
      const pathname = (() => {
        try { return new URL(url).pathname } catch { return String(url || '') }
      })()
      if (/\/F000[A-Za-z0-9]+\.flac(?:$|\/)/i.test(pathname)) return 'flac'
      if (/\/A000[A-Za-z0-9]+\.ape(?:$|\/)/i.test(pathname)) return 'ape'
      if (/\/M800[A-Za-z0-9]+\.mp3(?:$|\/)/i.test(pathname)) return '320'
      if (/\/M500[A-Za-z0-9]+\.mp3(?:$|\/)/i.test(pathname)) return '128'
      if (/\/C400[A-Za-z0-9]+\.m4a(?:$|\/)/i.test(pathname)) return 'm4a'
      return fallbackQuality
    }

    const requestDirectQQUrl = async (quality, loginflag) => {
      const filename = getQQFilename(mediaMid, quality)
      const json = await qqMusicRequest({
        comm: {
          uin: qqUin,
          format: 'json',
          ct: 24,
          cv: 0,
          ...(qqMusicKey ? { authst: qqMusicKey } : {}),
        },
        req_1: {
          module: 'vkey.GetVkeyServer',
          method: 'CgiGetVkey',
          param: {
            guid: String(Math.floor(Math.random() * 10000000)),
            songmid: [songMid],
            songtype: [songType],
            uin: qqUin,
            loginflag,
            platform: '20',
            filename: [filename],
          },
        },
      }, {
        cookie: normalizedCookie,
        timeoutMs: remainingTimeout(5500),
      })
      const responseData = json?.req_1?.data || json?.req_0?.data
      const info = responseData?.midurlinfo?.[0]
      const purl = info?.purl
      if (!purl) return null
      if (info?.songmid && String(info.songmid) !== songMid) return null
      const domains = Array.isArray(responseData?.sip) ? responseData.sip : []
      const domain = domains.find(item => typeof item === 'string' && !item.startsWith('http://ws')) || domains[0] || 'https://dl.stream.qqmusic.qq.com/'
      const url = purl.startsWith('http') ? purl : new URL(purl, domain).toString()
      return { url, quality, actualQuality: getActualQQQuality(url, quality) }
    }

    for (const quality of availableCandidates) {
      try {
        const direct = await requestDirectQQUrl(quality, qqUin ? 1 : 0)
        if (direct) {
          console.log('[QQ URL] direct quality ' + direct.quality + ' succeeded as ' + direct.actualQuality)
          return res.json({
            url: direct.url,
            qualityPreference,
            requestedQuality: direct.quality,
            actualQuality: direct.actualQuality,
            isPreview: false,
          })
        }
      } catch (directErr) {
        console.warn('[QQ URL] direct quality ' + quality + ' failed:', directErr.message)
      }
    }

    // The package fallback is slower and uses global library state. Run it only after
    // direct candidates, and only for the two best playable candidates.
    for (const quality of availableCandidates.slice(0, 2)) {
      try {
        const apiResult = await withTimeout(
          qqMusicApi.api('song/url', { id: songMid, type: quality }),
          remainingTimeout(5000),
          'QQ package URL timeout',
        )
        const url = typeof apiResult === 'string' ? apiResult : apiResult?.data
        if (typeof url === 'string' && url.startsWith('http')) {
          const actualQuality = getActualQQQuality(url, quality)
          const path = (() => { try { return new URL(url).pathname } catch { return url } })()
          const expectedFilename = getQQFilename(mediaMid, actualQuality)
          if (path.endsWith('/' + expectedFilename) || path.includes('/' + expectedFilename + '?')) {
            console.log('[QQ URL] package quality ' + quality + ' succeeded')
            return res.json({ url, qualityPreference, requestedQuality: quality, actualQuality, isPreview: false })
          }
          console.warn('[QQ URL] ignored package URL with unexpected media id:', path)
        }
      } catch (apiErr) {
        console.warn('[QQ URL] package quality ' + quality + ' failed:', apiErr.message)
      }
    }

    try {
      const preview = await requestDirectQQUrl('m4a', 0)
      if (preview) {
        return res.json({ url: preview.url, qualityPreference, requestedQuality: 'm4a', actualQuality: preview.actualQuality, isPreview: true })
      }
    } catch (previewError) {
      console.warn('[QQ URL] preview failed:', previewError.message)
    }

    return res.json({ url: null, qualityPreference, isPreview: false })
  } catch (error) {
    console.error('[QQ URL] unexpected error:', error)
    return res.status(500).json({ error: error.message, url: null })
  }
})
app.get('/api/qq/song/detail', async (req, res) => {
  try {
    const { mid, id } = req.query
    const songMid = mid || id
    if (!songMid) {
      return res.status(400).json({ error: '请提供歌曲mid', song: null })
    }

    const song = await qqSongDetail(songMid, { mid: songMid })
    // 额外获取完整板块（基础信息 info：语种/流派/唱片公司/发行时间/简介等）
    let detail = null
    try {
      const full = await qqMusicApi.api('song', { songmid: songMid })
      if (full && full.info) {
        detail = { info: full.info, track_info: full.track_info || null, extras: full.extras || null }
      }
    } catch (detailError) {
      console.warn('[QQ音乐详情] 板块获取失败:', detailError?.message || detailError)
    }

    // 从 track_info.file 提取可用音质等级（size_* > 0 表示该音质可用）
    const ti = detail?.track_info
    if (ti?.file) {
      const f = ti.file
      const qualityLevels = []
      const pushLevel = (key, label, br) => {
        if (Number(f[key]) > 0) qualityLevels.push({ key, label, br })
      }
      pushLevel('size_hires', 'Hi-Res 无损', 9216)
      pushLevel('size_flac', '无损 FLAC', 1024)
      pushLevel('size_dolby', '杜比全景声', 1536)
      pushLevel('size_320mp3', '高品质 320k', 320)
      pushLevel('size_192aac', '192k AAC', 192)
      pushLevel('size_128mp3', '标准 128k', 128)
      pushLevel('size_96aac', '96k AAC', 96)
      pushLevel('size_48aac', '48k AAC', 48)
      qualityLevels.sort((a, b) => (b.br || 0) - (a.br || 0))
      ti.qualityLevels = qualityLevels
      // 发行日期 / MV / BPM
      song.qualityLevels = qualityLevels
      if (ti.time_public) song.publishDate = ti.time_public
      if (ti.bpm) song.bpm = Number(ti.bpm)
      if (ti.genre != null) song.genreId = Number(ti.genre)
      if (ti.language != null) song.languageId = Number(ti.language)
      if (ti.mv?.vid) song.mvVid = ti.mv.vid
      if (ti.mv?.id) song.mvId = ti.mv.id
    }

    res.json({ song, detail })
  } catch (error) {
    console.error('[QQ音乐详情] 获取错误:', error.message)
    res.status(500).json({ error: error.message, song: null })
  }
})

app.get('/api/qq/lyric', async (req, res) => {
  try {
    const { id, mid, cookie } = req.query
    if (!id && !mid) {
      return res.status(400).json({ error: '请提供歌曲id或mid' })
    }

    const songMid = mid || id
    console.log(`[QQ音乐歌词] Cookie: ${cookie ? `已提供 (长度:${cookie.length})` : '未提供'}`)
    
    // 方法1: 使用musicu API (Mineradio的主要方法，支持qrc、roma等)
    let lyricText = ''
    let transText = ''
    let romanText = ''
    let qrcText = ''
    
    try {
      const param = { lrc: 1, qrc: 1, qrc_t: 0, trans: 1, trans_t: 0, roma: 1, roma_t: 0, crypt: 1, ct: 19, cv: 2111, type: 0 }
      if (songMid) param.songMID = songMid
      // id 只有**整体是纯数字**才是 songID。QQ 的 songmid 是字母开头的字符串
      //（如 "003Vz5hK1iS1ZY"），parseInt 会吃掉前导数字变成 3——把垃圾 songID=3 发给
      // musicu 会返回别歌/空数据（方法1 的 lrc/trans/roma/qrc 全乱），只剩方法2 兜回
      // 普通 LRC → 今天批量出现"没逐字/没翻译/没罗马音"的回归
      const idStr = String(id ?? '').trim()
      const idIsNumeric = /^\d+$/.test(idStr)
      if (idIsNumeric) param.songID = Number(idStr)

      const callMusicu = async (p) => {
        const j = await qqMusicRequest({
          comm: { ct: 24, cv: 0 },
          lyric: { module: 'music.musichallSong.PlayLyricInfo', method: 'GetPlayLyricInfo', param: p },
        })
        return j?.lyric?.data || null
      }

      let data = await callMusicu(param)
      // 自适应：主请求没取到任何歌词内容（歌曲 id 可能是 songID 纯数字，也可能是 songmid
      // 字符串；形态混用/猜错会取空）→ 用**另一形态**重试一次，确保 lrc/qrc/trans/roma
      // 都能拿到（实测 Done for Me 只传 songMID 全空、带 songID 才有完整逐字+翻译）
      if (data && (data.lyric || data.qrc || data.trans)) {
        /* 主请求已取到内容 */
      } else if (songMid) {
        const retryParam = { ...param }
        if (idIsNumeric) {
          // 数字 id：主请求（songMID+可能带 songID）取空 → 只按 songID 形态重试（去掉可能干扰的 songMID）
          retryParam.songID = Number(idStr)
          delete retryParam.songMID
        }
        const retried = await callMusicu(retryParam)
        if (retried && (retried.lyric || retried.qrc || retried.trans)) {
          data = retried
          console.log(`[QQ音乐歌词] 自适应重试成功（id=${idStr} 形态：${idIsNumeric ? 'songMID→songID' : 'songID→songMID'}）`)
        }
      }
      console.log(`[QQ音乐歌词] musicu返回字段:`, Object.keys(data || {}))

      // 添加详细的原始数据日志
      if (data?.lyric && typeof data.lyric === 'string') {
        console.log(`[QQ音乐歌词] lyric长度: ${data.lyric.length}, 前50字符: ${data.lyric.substring(0, 50)}`)
      }
      if (data?.qrc && typeof data.qrc === 'string') {
        console.log(`[QQ音乐歌词] qrc字符串长度: ${data.qrc.length}, 前50字符: ${data.qrc.substring(0, 50)}`)
      } else {
        console.log(`[QQ音乐歌词] qrc字段值: ${data?.qrc} (不是字符串，无法解密)`)
      }
      
      // 尝试解密 QRC（只有当 qrc 是非空字符串时）
      let qrcDecrypted = ''
      if (data?.qrc && typeof data.qrc === 'string' && data.qrc.length > 0) {
        qrcDecrypted = decryptQQEncryptedLyric(data.qrc, 'QRC field')
        if (qrcDecrypted.length > 0) {
          console.log(`[QQ音乐歌词] ✅ QRC字段解密成功！前100字符: ${qrcDecrypted.substring(0, 100)}`)
        }
      }
      
      // 尝试解密 lyric 字段（可能包含加密的逐字歌词）
      const decryptedLyric = decryptQQEncryptedLyric(data?.lyric, 'lyric field')
      if (decryptedLyric.length > 100) {
        console.log(`[QQ音乐歌词] lyric字段解密结果前100字符: ${decryptedLyric.substring(0, 100)}`)
      }
      
      const officialTrans = decodeQQLyricText(data?.trans) || decryptQQEncryptedLyric(data?.trans, 'trans')
      const officialRoman = decodeQQLyricText(data?.roma) || decryptQQEncryptedLyric(data?.roma, 'roma')
      
      console.log(`[QQ音乐歌词] trans字段: ${data?.trans ? '有数据' : '无'}, 解密后长度: ${officialTrans?.length || 0}`)
      console.log(`[QQ音乐歌词] roma字段: ${data?.roma ? '有数据' : '无'}, 解密后长度: ${officialRoman?.length || 0}`)
      if (officialRoman && officialRoman.length > 0) {
        console.log(`[QQ音乐歌词] ✅ 找到罗马音! 前200字符: ${officialRoman.substring(0, 200)}`)
      }


      // 优先使用 QRC 字段的解密结果作为逐字歌词
      if (hasQrcWordTiming(qrcDecrypted)) {
        // 检测是否为 kana 格式
        if (qrcDecrypted.includes('[kana:')) {
          qrcText = convertKanaToYrc(qrcDecrypted)
          if (qrcText.length > 0) {
            console.log(qrcText.substring(0, 300))
          }
        } else {
          qrcText = qrcDecrypted
          console.log(qrcDecrypted.substring(0, 800))
        }
      } else if (hasQrcWordTiming(decryptedLyric)) {
        // 检测是否为 kana 格式
        if (decryptedLyric.includes('[kana:')) {
          qrcText = convertKanaToYrc(decryptedLyric)
        } else {
          qrcText = decryptedLyric
          console.log(decryptedLyric.substring(0, 800))
        }
      } else {
        console.log(`[QQ音乐歌词] ⚠️ 未找到逐字歌词 (QRC格式)`)
        if (qrcDecrypted.length > 0) {
          console.log(qrcDecrypted.substring(0, 500))
        }
      }
      
      // 处理普通歌词：需要将 QRC 格式转换为普通 LRC
      let officialLyric = decodeQQLyricText(data?.lyric)
      if (!officialLyric && decryptedLyric) {
        // 检测是否为 QRC 格式 [ms,ms]歌词(ms,ms)字...
        if (/^\[(\d+),(\d+)\]/.test(decryptedLyric.trim().split('\n').find(l => l.trim().startsWith('[') && l.match(/^\[\d+,\d+\]/)))) {
          officialLyric = convertQrcToLrc(decryptedLyric)
          if (officialLyric.length > 100) {
            console.log(`[QQ音乐歌词] 转换后前200字符: ${officialLyric.substring(0, 200)}`)
          }
        } else if (decryptedLyric.includes('[kana:')) {
          officialLyric = extractPlainLrcFromKana(decryptedLyric)
        } else {
          officialLyric = decryptedLyric
        }
      }
      
      if (officialLyric) lyricText = officialLyric
      if (officialTrans) transText = officialTrans
      if (officialRoman) romanText = officialRoman
      // 如果官方已有完整歌词，直接返回（优化速度）
      if (lyricText && transText && romanText) {
        res.json({ 
          lrc: { lyric: lyricText },
          qrc: { lyric: qrcText },
          trans: { lyric: transText },
          roma: { lyric: romanText }
        })
        return
      }
    } catch (e) {
      console.warn(`[QQ音乐歌词] 方法1失败:`, e.message)
    }
    
    // 方法2: fcg_query_lyric_new (备用方法)
    // 如果没有歌词，尝试方法2（已有翻译则跳过）
    if ((!lyricText || !transText || !romanText) && songMid) {
      try {
        const lyricUrl = new URL('https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg')
        lyricUrl.searchParams.set('songmid', songMid)
        lyricUrl.searchParams.set('songtype', '0')
        lyricUrl.searchParams.set('format', 'json')
        lyricUrl.searchParams.set('pcachetime', Date.now().toString())
        lyricUrl.searchParams.set('g_tk', '5381')
        lyricUrl.searchParams.set('loginUin', '0')
        lyricUrl.searchParams.set('hostUin', '0')
        lyricUrl.searchParams.set('inCharset', 'utf8')
        lyricUrl.searchParams.set('outCharset', 'utf-8')
        lyricUrl.searchParams.set('notice', '0')
        lyricUrl.searchParams.set('platform', 'yqq')
        lyricUrl.searchParams.set('needNewCode', '0')
        
        const controller = new AbortController()
        const timeoutId = setTimeout(() => controller.abort(), 2000) // 2秒超时
        
        const response = await fetch(lyricUrl.toString(), {
          headers: {
            'Referer': 'https://y.qq.com/portal/player.html',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Cookie': cookie || ''
          },
          signal: controller.signal
        })
        
        clearTimeout(timeoutId)
        
        const text = await response.text()
        const jsonText = text.replace(/^MusicJsonCallback\(/, '').replace(/\)$/, '')
        const data = JSON.parse(jsonText)
        
        const fallbackDecryptedLyric = decryptQQEncryptedLyric(data.lyric, 'fallback qrc lyric')
        const fallbackLyric = decodeQQLyricText(data.lyric) || fallbackDecryptedLyric
        const fallbackTrans = decodeQQLyricText(data.trans) || decryptQQEncryptedLyric(data.trans, 'fallback trans')
        const fallbackRoman = decodeQQLyricText(data.roma) || decryptQQEncryptedLyric(data.roma, 'fallback roma')

        if (fallbackDecryptedLyric && !qrcText && hasQrcWordTiming(fallbackDecryptedLyric)) qrcText = fallbackDecryptedLyric
        if (fallbackLyric && !lyricText) lyricText = fallbackLyric
        if (fallbackTrans && !transText) transText = fallbackTrans
        if (fallbackRoman && !romanText) romanText = fallbackRoman
      } catch (e) {
        console.warn(`[QQ音乐歌词] 方法2失败:`, e.message)
      }
    }
    
    // 方法3: AMLL TTML DB (仅在需要翻译时调用)
    if ((!transText || !romanText) && songMid) {
      try {
        const controller = new AbortController()
        const timeoutId = setTimeout(() => controller.abort(), 3000) // 3秒超时
        
        const response = await fetch(`https://amlldb.bikonoo.com/qq-lyrics/${songMid}.ttml`, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
          },
          signal: controller.signal
        })
        
        clearTimeout(timeoutId)
        
        if (response.ok) {
          const ttmlText = await response.text()
          // 解析TTML格式
          const ttmlLyric = parseTTMLSimple(ttmlText)
          
          if (ttmlLyric.translation) {
            transText = ttmlLyric.translation
          }
          
          if (ttmlLyric.lyric && !lyricText) {
            lyricText = ttmlLyric.lyric
          }
          
          if (ttmlLyric.roman && !romanText) {
            romanText = ttmlLyric.roman
          }
        } else {
          console.log(`[QQ音乐歌词] AMLL TTML未找到 (${response.status})`)
        }
      } catch (e) {
        if (e.name === 'AbortError') {
          console.warn(`[QQ音乐歌词] 方法3超时`)
        } else {
          console.warn(`[QQ音乐歌词] 方法3失败:`, e.message)
        }
      }
    }
    

    if (transText) {
    } else {
    }
    
    res.json({ 
      lrc: { lyric: lyricText },
      qrc: { lyric: qrcText },
      trans: { lyric: transText },
      roma: { lyric: romanText }
    })
  } catch (error) {
    console.error('[QQ音乐歌词] ❌ 获取错误:', error)
    res.status(500).json({ error: error.message, lrc: { lyric: '' }, qrc: { lyric: '' }, trans: { lyric: '' }, roma: { lyric: '' } })
  }
})

// QQ音乐热榜API
app.get('/api/qq/top', async (req, res) => {
  try {
    const { id = 26, devMode } = req.query // 26: 热歌榜, 4: 流行榜
    const isDev = devMode === 'true'
    
    if (isDev) console.log('[QQ音乐热榜] 正在获取热榜，ID:', id)
    
    // 使用qq-music-api获取热榜
    const result = await qqMusicApi.api('top', { id: parseInt(id) })
    
    if (isDev) console.log('[QQ音乐热榜] API返回结果:', result ? '成功' : '失败')
    
    if (result && result.data) {
      res.json(result)
    } else {
      if (isDev) console.warn('[QQ音乐热榜] API返回数据为空')
      res.json({
        result: 100,
        data: {
          song_list: []
        }
      })
    }
  } catch (error) {
    console.error('[QQ音乐热榜] 获取错误:', error.message)
    res.status(200).json({
      result: 100,
      data: {
        song_list: []
      }
    })
  }
})

// QQ音乐新歌推荐API（使用正确的new/songs接口）
app.get('/api/qq/new/songs', async (req, res) => {
  try {
    const devMode = req.query.devMode === 'true'
    // 使用 new/songs API（不需要登录）
    // type: 0=最新, 1=内地, 2=港台, 3=欧美, 4=韩国, 5=日本
    const newSongsResult = await qqMusicApi.api('new/songs', { 
      type: 0 // 获取最新歌曲
    })
    
    if (newSongsResult && newSongsResult.result === 100 && newSongsResult.data && newSongsResult.data.list) {
      const songs = newSongsResult.data.list
      res.json({
        result: 100,
        data: {
          songlist: songs
        }
      })
    } else {
      if (devMode) console.warn('[QQ新歌] 新歌列表为空')
      res.json({ result: 100, data: { songlist: [] } })
    }
  } catch (error) {
    console.error('[QQ新歌] 错误:', error.message || error)
    res.status(200).json({ result: 100, data: { songlist: [] } })
  }
})

// QQ音乐每日推荐（需要登录）
app.get('/api/qq/recommend/daily', async (req, res) => {
  try {
    const { cookie, devMode } = req.query
    const isDev = devMode === 'true'
    
    if (!cookie && !qqMusicCookie) {
      return res.status(401).json({ result: 301, errMsg: '需要登录' })
    }
    
    if (isDev) console.log('[QQ音乐每日推荐] 正在获取每日推荐...')
    
    // 设置Cookie
    resolveRequestCookie(cookie)

    // 优先使用用户自行配置的 QQ Music Skills；未配置时直接读取登录账号
    // 的 99 号“猜你喜欢”电台并连续取批次，避免旧 recommend/daily 接口
    // 错把有效 Cookie 判为未登录。
    const skillKey = getQQMusicSkillKey(req)
    let songs = []
    let source = 'qq-guess-you-like-fallback'
    if (skillKey) {
      try {
        // 官方 Skills 的每日推荐会分页返回；只取首个响应会稳定停在首批 5 首。
        const dailyMix = await requestQQMusicSkillPages(
          '/discover/daily-mix',
          {},
          skillKey,
          'songlist',
          30
        )
        songs = Array.isArray(dailyMix?.songlist) ? dailyMix.songlist.slice(0, 30) : []
        if (songs.length > 0) source = 'qqmusic-skills-daily'
      } catch (skillError) {
        if (isDev) console.warn('[QQ Daily] Official enhancement unavailable:', skillError?.message || skillError)
      }
    }
    if (songs.length < 30) {
      const radio = await fetchQQRadioBatches(99, 30, 8, cookie)
      const radioSongs = radio?.tracks || radio?.songlist || radio?.list || []
      const mergedSongs = [...songs, ...(Array.isArray(radioSongs) ? radioSongs : [])]
      songs = Array.from(new Map(mergedSongs.map(song => [
        String(song?.songMid || song?.mid || song?.songmid || song?.songId || song?.id || song?.songid || ''),
        song
      ])).values()).filter(song => song).slice(0, 30)
    }
    return res.json({
      result: 100,
      data: {
        songlist: songs,
        source,
        personalized: true
      }
    })
    
  } catch (error) {
    console.error('[QQ音乐每日推荐] 获取错误:', error.message)
    res.status(200).json({
      result: 100,
      data: {
        song_list: [],
        songlist: [],
        list: []
      }
    })
  }
})

// QQ音乐推荐歌单
app.get('/api/qq/recommend/playlist', async (req, res) => {
  try {
    const devMode = req.query.devMode === 'true'
    // 尝试获取多个来源的歌单推荐
    const results = await Promise.allSettled([
      qqMusicApi.api('recommend/playlist/u'),
      qqMusicApi.api('songlist/list', { id: 10000000, page: 1, pageSize: 30, sort: 5 })
    ])
    
    let allPlaylists = []
    
    // 合并推荐歌单
    if (results[0].status === 'fulfilled' && results[0].value?.list) {
      // 打印第一个歌单的字段结构
      if (results[0].value.list[0]) {
        if (devMode) console.log('[QQ音乐推荐歌单] 第一个歌单的字段:', Object.keys(results[0].value.list[0]))
        if (devMode) console.log('[QQ音乐推荐歌单] 第一个歌单示例:', JSON.stringify(results[0].value.list[0], null, 2))
      }
      allPlaylists = [...results[0].value.list]
    }
    
    // 合并热门歌单
    if (results[1].status === 'fulfilled' && results[1].value?.list) {
      // 去重：根据id过滤
      const existingIds = new Set(allPlaylists.map(p => 
        p.content_id || p.dissid || p.tid || p.id
      ))
      const newPlaylists = results[1].value.list.filter(p => {
        const pid = p.content_id || p.dissid || p.tid || p.id
        return !existingIds.has(pid)
      })
      allPlaylists = [...allPlaylists, ...newPlaylists]
    }
    

    const enrichedPlaylists = []
    const batchSize = 4
    for (let i = 0; i < allPlaylists.length; i += batchSize) {
      const batch = allPlaylists.slice(i, i + batchSize)
      const enrichedBatch = await Promise.all(batch.map(async playlist => {
        const existingCount = playlist.song_cnt || playlist.songnum || playlist.song_num || playlist.songNum || playlist.song_count
        if (existingCount) return playlist

        const id = playlist.content_id || playlist.dissid || playlist.tid || playlist.id
        if (!id) return playlist

        try {
          const detail = await fetchQQPlaylistDetail(id, 1)
          const countCandidates = [
            detail?.song_cnt,
            detail?.songnum,
            detail?.song_num,
            detail?.songCount,
            detail?.total_song_num,
            detail?.cdlist?.[0]?.songnum,
            detail?.cdlist?.[0]?.song_cnt,
            detail?.dissinfo?.song_cnt,
            detail?.data?.song_cnt,
            detail?.data?.songnum,
            detail?.data?.cdlist?.[0]?.songnum,
            detail?.data?.cdlist?.[0]?.song_cnt,
            detail?.songlist?.length
          ]
          const songCount = countCandidates
            .map(value => Number(value))
            .find(value => Number.isFinite(value) && value > 0) || 0

          return { ...playlist, song_cnt: songCount }
        } catch (error) {
          if (devMode) console.warn(`[QQ音乐推荐歌单] 获取歌单 ${id} 的歌曲数量失败`, error.message)
          return { ...playlist, song_cnt: 0 }
        }
      }))
      enrichedPlaylists.push(...enrichedBatch)
    }
    // 包装成统一格式
    if (enrichedPlaylists.length > 0) {
      res.json({
        result: 100,
        data: {
          list: enrichedPlaylists,
          count: enrichedPlaylists.length
        }
      })
    } else {
      if (devMode) console.warn('[QQ音乐推荐歌单] API返回数据为空')
      res.json({
        result: 100,
        data: {
          list: []
        }
      })
    }
  } catch (error) {
    console.error('[QQ音乐推荐歌单] 获取错误:', error.message)
    res.status(200).json({
      result: 100,
      data: {
        list: []
      }
    })
  }
})

// QQ音乐猜你喜欢（歌曲）
app.get('/api/qq/recommend/songs', async (req, res) => {
  try {
    const { cookie } = req.query
    // 登录后读取账号 99 号“猜你喜欢”电台；访客只回退到公开新歌，
    // 不再用随机公共歌单伪装成个性化推荐。
    const hasLogin = Boolean(resolveRequestCookie(cookie))
    if (hasLogin) {
      const radio = await fetchQQRadioBatches(99, 30, 8, cookie)
      const radioSongs = radio?.tracks || radio?.songlist || radio?.list || []
      return res.json({
        result: 100,
        data: {
          songlist: Array.isArray(radioSongs) ? radioSongs.slice(0, 30) : [],
          source: 'qq-radio-99',
          personalized: true
        }
      })
    }

    const publicSongs = await qqMusicApi.api('new/songs', { type: 0 })
    const publicList = publicSongs?.list || publicSongs?.data?.list || []
    return res.json({
      result: 100,
      data: {
        songlist: Array.isArray(publicList) ? publicList.slice(0, 30) : [],
        source: 'qq-public-new-songs',
        personalized: false
      }
    })
    
  } catch (error) {
    console.error('[QQ音乐猜你喜欢歌曲] 获取错误:', error.message)
    res.status(200).json({
      result: 100,
      data: {
        songlist: []
      }
    })
  }
})

// QQ音乐新歌推荐
app.get('/api/qq/new/songs', async (req, res) => {
  try {
    const { type = 0, devMode } = req.query
    const isDev = devMode === 'true'
    if (isDev) console.log('[QQ音乐新歌推荐] 正在获取新歌，类型:', type)
    
    const result = await qqMusicApi.api('new/songs', { type })
    
    if (isDev) console.log('[QQ音乐新歌推荐] API返回数据结构:', result ? Object.keys(result) : 'null')
    
    if (result && result.result === 100 && result.data) {
      if (isDev) console.log('[QQ音乐新歌推荐] 返回歌曲数:', result.data.list?.length || 0)
      // 将 list 转换为 songlist 格式，以保持前端统一处理
      res.json({
        result: 100,
        data: {
          songlist: result.data.list || []
        }
      })
    } else {
      if (isDev) console.warn('[QQ音乐新歌推荐] API返回数据为空')
      res.json({
        result: 100,
        data: {
          songlist: []
        }
      })
    }
  } catch (error) {
    console.error('[QQ音乐新歌推荐] 获取错误:', error.message)
    res.status(200).json({
      result: 100,
      data: {
        songlist: []
      }
    })
  }
})

// QQ音乐登录相关 API
// 探索模式聚合接口 ---------------------------------------------------------
//
// 探索页同时消费网易云和 QQ 音乐的公开内容，并在登录态可用时叠加个性化
// 推荐。QQ 音乐官方 Skills API 是可选增强：仅从服务端环境变量读取 Key，
// 永远不会把 Key 发送到渲染进程；未配置时自动使用现有 qq-music-api 数据。

const QQMUSIC_SKILL_VERSION = '0.0.3'

const stripExploreMarkup = (value) => String(value || '')
  .replace(/<br\s*\/?>/gi, '\n')
  .replace(/<[^>]*>/g, '')
  .replace(/&nbsp;/gi, ' ')
  .replace(/&amp;/gi, '&')
  .trim()

const settledExploreValue = (result, fallback = null) => (
  result?.status === 'fulfilled' ? result.value : fallback
)

// 并发组统一 deadline：与 Promise.allSettled 语义一致（保持响应结构不变），
// 但最多等 deadlineMs（12s，与 Skills 的 12s abort 对齐）；超时后已完成的调用
// 保留其结果，未完成的降级为 rejected，不阻塞整个探索页。
function settleExploreCallsWithDeadline(calls, deadlineMs = 12000) {
  return new Promise((resolve) => {
    const results = new Array(calls.length).fill(null)
    let remaining = calls.length
    let settled = false
    const done = () => {
      if (settled) return
      settled = true
      resolve(results.map(result => result || {
        status: 'rejected',
        reason: new Error('QQ 探索页请求超时')
      }))
    }
    calls.forEach((call, index) => {
      Promise.resolve(call).then(
        value => {
          results[index] = { status: 'fulfilled', value }
          remaining -= 1
          if (remaining === 0) done()
        },
        reason => {
          results[index] = { status: 'rejected', reason }
          remaining -= 1
          if (remaining === 0) done()
        }
      )
    })
    setTimeout(done, deadlineMs)
  })
}

function normalizeNeteaseExploreSong(input, fallback = {}) {
  const track = input?.song || input?.mainSong || input || {}
  const album = track.al || track.album || {}
  const artists = track.ar || track.artists || []
  const numericId = Number(track.id || fallback.id || 0)

  if (!numericId || !(track.name || fallback.name)) return null

  return {
    id: numericId,
    name: track.name || fallback.name || '未知歌曲',
    artists: artists.length > 0
      ? artists.map(artist => ({
          id: Number(artist.id) || undefined,
          name: artist.name || '未知歌手'
        }))
      : [{ name: fallback.artist || '未知歌手' }],
    album: {
      id: Number(album.id) || undefined,
      name: album.name || fallback.album || '',
      picUrl: album.picUrl || album.blurPicUrl || input?.picUrl || fallback.coverUrl || ''
    },
    duration: Number(track.dt || track.duration || 0),
    platform: 'netease',
    vip: Number(track.fee) === 1,
    fee: Number(track.fee) || 0,
    noCopyright: Number(track.privilege?.st) < 0
  }
}

function normalizeQQExploreSong(input, fallback = {}) {
  const track = input?.songInfo || input?.song || input || {}
  const mid = String(
    track.mid || track.songmid || track.songMid || track.song_mid || fallback.mid || ''
  ).trim()
  const rawId = track.id || track.songid || track.songId || fallback.id || 0
  const numericId = Number(rawId) || Number.parseInt(String(rawId).replace(/\D/g, ''), 10) || 0
  const rawArtists = track.singer || track.singers || track.artists || []
  const artists = Array.isArray(rawArtists)
    ? rawArtists.map(artist => ({
        id: Number(artist.id || artist.singerid) || undefined,
        mid: artist.mid || artist.singermid || artist.singerMid || undefined,
        name: artist.name || artist.title || artist.singerName || '未知歌手'
      }))
    : []
  const album = track.album || {}
  const albumMid = album.mid || album.pmid || track.albummid || track.albumMid || fallback.albumMid || ''
  const coverUrl = normalizeQQImageUrl(
    track.cover || track.picUrl || track.picurl || track.albumpic || track.albumPic ||
    album.picUrl || album.picurl || album.cover || album.coverUrl || fallback.coverUrl
  ) || (albumMid ? qqAlbumCover(String(albumMid).replace(/_\d+$/, ''), 500) : '')
  const name = track.name || track.title || track.songname || track.songName || fallback.name || ''

  if (!name || (!mid && !numericId)) return null

  return {
    id: numericId || Number(fallback.id) || 0,
    mid: mid || undefined,
    name,
    artists: artists.length > 0
      ? artists
      : [{
          mid: track.singerMid || fallback.singerMid || undefined,
          name: track.singerName || fallback.artist || '未知歌手'
        }],
    album: {
      id: Number(album.id || track.albumid) || undefined,
      mid: albumMid || undefined,
      pmid: album.pmid || undefined,
      name: album.name || album.title || track.albumname || fallback.album || '',
      picUrl: coverUrl
    },
    duration: Number(track.interval || fallback.interval || 0) * 1000 || Number(track.duration || 0),
    platform: 'qq',
    songType: Number(track.type ?? track.songtype ?? track.songType ?? fallback.songType ?? fallback.type) || 0,
    vip: Boolean(track.pay?.pay_play || track.pay?.paydownload || track.isonly === 1)
  }
}

function normalizeQQExplorePlaylist(item, source = 'community') {
  const id = item?.dissId || item?.dissid || item?.content_id || item?.tid || item?.dirid || item?.id
  if (!id) return null

  const albumPicMid = item?.album_pic_mid || item?.pic_mid || item?.cover_mid || ''
  const coverUrl = normalizeQQImageUrl(
    item?.picUrl || item?.picurl || item?.cover || item?.coverUrl || item?.cover_url_big ||
    item?.cover_url_medium || item?.cover_url_small || item?.imgUrl || item?.imgurl ||
    item?.image || item?.logo || item?.album?.picUrl
  ) || (albumPicMid ? qqAlbumCover(String(albumPicMid).replace(/_\d+$/, ''), 500) : '')

  return {
    id: String(id),
    name: item?.dissName || item?.dissname || item?.title || item?.name || 'QQ 音乐歌单',
    description: stripExploreMarkup(item?.dissDesc || item?.desc || item?.rcmdcontent || item?.copywriter || ''),
    coverUrl,
    playCount: Number(item?.listen_num || item?.listennum || item?.access_num || item?.playCount || 0),
    trackCount: Number(item?.song_cnt || item?.songnum || item?.song_num || item?.trackCount || 0),
    creator: item?.creatorName || item?.username || item?.creator?.name || item?.creator_info?.nick || '',
    platform: 'qq',
    source
  }
}

const QQMUSIC_SKILL_ALLOWED_PATHS = new Set([
  '/discover/daily-mix',
  '/discover/radio',
  '/discover/ai-playlists',
  '/charts',
  '/charts/detail',
  '/playlists/detail',
  '/me/report',
  '/assistant/ai_interpretation'
])

function normalizeQQMusicSkillKey(value) {
  const key = String(value || '').trim()
  return /^qmk-[A-Za-z0-9._-]+$/.test(key) ? key : ''
}

function getQQMusicSkillKey(req) {
  return normalizeQQMusicSkillKey(req.get('X-QQMusic-Skill-Key')) ||
    normalizeQQMusicSkillKey(process.env.QQMUSIC_API_KEY)
}

async function requestQQMusicSkill(path, params = {}, keyOverride = '') {
  const apiKey = normalizeQQMusicSkillKey(keyOverride) || normalizeQQMusicSkillKey(process.env.QQMUSIC_API_KEY)
  if (!apiKey) return null

  if (!QQMUSIC_SKILL_ALLOWED_PATHS.has(path)) throw new Error('不允许的 QQ 音乐 Skills 路径')

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 12000)

  try {
    const response = await fetch(`https://a.y.qq.com${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json'
      },
      body: JSON.stringify({
        params,
        comm: { skill_version: QQMUSIC_SKILL_VERSION }
      }),
      signal: controller.signal
    })

    if (!response.ok) throw new Error(`QQ 音乐 Skills HTTP ${response.status}`)
    const data = await response.json()
    if ((data.ret != null && Number(data.ret) !== 0) || (data.sub_ret != null && Number(data.sub_ret) !== 0)) {
      throw new Error(data.msg || 'QQ 音乐 Skills 返回错误')
    }
    return data
  } finally {
    clearTimeout(timeout)
  }
}

async function requestQQMusicSkillPages(path, params, key, listField, maxPages = 50) {
  const pages = []
  let firstPage = null
  for (let page = 0; page < maxPages; page += 1) {
    const result = await requestQQMusicSkill(path, { ...params, page }, key)
    if (!result) break
    if (!firstPage) firstPage = result
    const items = Array.isArray(result[listField]) ? result[listField] : []
    pages.push(...items)
    if (!result.hasMore || items.length === 0) break
    // 官方接口有 QPS 限制；分页串行并留出短间隔。
    await new Promise(resolve => setTimeout(resolve, 80))
  }
  if (!firstPage) return null
  const uniqueItems = Array.from(new Map(pages.map(item => [
    String(item?.songMid || item?.mid || item?.songId || item?.id || JSON.stringify(item)),
    item
  ])).values())
  return { ...firstPage, [listField]: uniqueItems, hasMore: false }
}

// 部分 Skills 电台响应未返回 hasMore，但仍接受 page 参数并继续给出下一批。
// 不依赖 hasMore 连续取几页，配合去重和无增长保护补齐连续推荐队列。
async function requestQQMusicSkillBatches(path, params, key, listField, targetCount = 30, maxPages = 8) {
  let firstPage = null
  const items = []
  const seen = new Set()
  let noGrowthCount = 0

  for (let page = 0; page < maxPages && items.length < targetCount; page += 1) {
    const result = await requestQQMusicSkill(path, { ...params, page }, key)
    if (!result) break
    if (!firstPage) firstPage = result
    const pageItems = Array.isArray(result[listField]) ? result[listField] : []
    const before = items.length
    for (const item of pageItems) {
      const itemKey = String(item?.songMid || item?.mid || item?.songId || item?.id || '')
      if (!itemKey || seen.has(itemKey)) continue
      seen.add(itemKey)
      items.push(item)
      if (items.length >= targetCount) break
    }
    noGrowthCount = items.length === before ? noGrowthCount + 1 : 0
    if (noGrowthCount >= 2 || pageItems.length === 0) break
    if (page < maxPages - 1 && items.length < targetCount) {
      await new Promise(resolve => setTimeout(resolve, 80))
    }
  }

  return firstPage ? { ...firstPage, [listField]: items, hasMore: false } : null
}

async function fetchQQRadioBatches(id, targetCount = 30, maxBatches = 8, cookie = '', startBatch = 0) {
  // 播放/推荐类读取：请求 cookie 仅本次请求使用，不回写全局。
  const requestCookie = cookie || qqMusicCookie
  let firstResult = null
  const tracks = []
  const seen = new Set()
  let noGrowthCount = 0
  const pageSize = Math.min(30, Math.max(15, targetCount))

  const fetchRadioPage = async (pageNo, continuation = false) => {
    try {
      const result = await qqMusicRequest({
        songlist: {
          module: 'mb_track_radio_svr',
          method: 'get_radio_track',
          param: {
            id: Number(id),
            // QQ 电台接口以 firstplay=1 返回一批完整的推荐；传 0 会退化成
            // 当前播放上下文的短批次，通常只有 5 首。
            firstplay: continuation ? 0 : 1,
            page: pageNo,
            pageNo,
            page_num: pageNo,
            offset: (pageNo - 1) * pageSize,
            num: pageSize
          }
        },
        comm: { ct: 24, cv: 0 }
      }, { cookie: requestCookie })
      return result?.songlist?.data || result?.songlist || result
    } catch (error) {
      console.warn(`[QQ音乐电台] 分页获取第 ${pageNo} 页失败，回退 qq-music-api:`, error?.message || error)
      return qqMusicApi.api('radio', { id: Number(id) })
    }
  }

  for (let batch = 0; batch < maxBatches && tracks.length < targetCount; batch += 1) {
    const pageNo = startBatch + batch + 1
    const result = await fetchRadioPage(pageNo, startBatch > 0 || batch > 0)
    if (!firstResult) firstResult = result || {}
    const candidates = result?.tracks || result?.track_list || result?.songlist || result?.list ||
      result?.data?.tracks || result?.data?.track_list || result?.data?.songlist || result?.data?.list || []
    const before = tracks.length
    for (const track of candidates) {
      const key = String(track?.mid || track?.songmid || track?.songMid || track?.id || track?.songid || '')
      if (!key || seen.has(key)) continue
      seen.add(key)
      tracks.push(track)
      if (tracks.length >= targetCount) break
    }
    noGrowthCount = tracks.length === before ? noGrowthCount + 1 : 0
    if (!Array.isArray(candidates) || noGrowthCount >= 3) break
    if (batch < maxBatches - 1 && tracks.length < targetCount) {
      await new Promise(resolve => setTimeout(resolve, 80))
    }
  }

  return { ...(firstResult || {}), tracks }
}

app.get('/api/explore/qq/radio/next', async (req, res) => {
  try {
    const cookie = String(req.query.cookie || '')
    const hasLogin = Boolean(resolveRequestCookie(cookie))
    const count = Math.max(5, Math.min(Number(req.query.count) || 30, 60))
    const batch = Math.max(1, Math.floor(Number(req.query.batch) || 1))
    const excluded = new Set(String(req.query.exclude || '').split(',').map(value => value.trim()).filter(Boolean))
    const songs = []
    const seen = new Set(excluded)
    if (hasLogin) {
      for (let attempt = 0; attempt < 4 && songs.length < count; attempt += 1) {
        const radio = await fetchQQRadioBatches(99, count, 8, cookie, batch + attempt)
        const candidates = (radio?.tracks || radio?.songlist || radio?.list || [])
          .map(song => normalizeQQExploreSong(song))
          .filter(Boolean)
        for (const song of candidates) {
          const key = String(song?.mid || song?.id || '')
          if (!key || seen.has(key)) continue
          seen.add(key)
          songs.push(song)
          if (songs.length >= count) break
        }
      }
    }

    // 未登录或个性化电台短批次耗尽时，继续从公开新歌与榜单补充。
    // 这样 QQ 探索页始终保持连续队列，登录后仍优先使用真正的“猜你喜欢”。
    if (songs.length < count) {
      const [newSongResult, categoryResult] = await Promise.allSettled([
        qqMusicApi.api('new/songs', { type: (batch - 1) % 6 }),
        qqMusicApi.api('top/category', { showDetail: 1 })
      ])
      const newSongPayload = settledExploreValue(newSongResult, { list: [] }) || {}
      const chartGroups = settledExploreValue(categoryResult, []) || []
      const chartIds = chartGroups.flatMap(group => (group?.list || []).map(chart => chart.topId || chart.value)).filter(Boolean)
      const chartId = chartIds.length > 0 ? chartIds[(batch - 1) % chartIds.length] : 4
      const chart = await fetchQQChartPages(chartId, 100).catch(() => ({ list: [] }))
      const publicCandidates = [
        ...(newSongPayload.list || newSongPayload.data?.list || newSongPayload.songlist || []),
        ...(chart?.list || [])
      ].map(song => normalizeQQExploreSong(song)).filter(Boolean)
      for (const song of publicCandidates) {
        const key = String(song?.mid || song?.id || '')
        if (!key || seen.has(key)) continue
        seen.add(key)
        songs.push(song)
        if (songs.length >= count) break
      }
    }
    res.setHeader('Cache-Control', 'no-store')
    return res.json({ code: 200, songs, batch, hasMore: true })
  } catch (error) {
    console.error('[探索模式][QQ音乐] 获取下一批猜你喜欢失败:', error)
    return res.status(502).json({ code: 502, error: error?.message || '获取下一批猜你喜欢失败' })
  }
})

app.get('/api/explore/netease/recommendations/next', async (req, res) => {
  try {
    if (!NeteaseAPI) return res.status(503).json({ code: 503, error: '网易云 API 未初始化' })
    const cookie = String(req.query.cookie || '')
    const count = Math.max(10, Math.min(Number(req.query.count) || 30, 60))
    const batch = Math.max(1, Math.floor(Number(req.query.batch) || 1))
    const excluded = new Set(String(req.query.exclude || '').split(',').map(value => value.trim()).filter(Boolean))
    const areaTypes = [0, 7, 96, 8, 16]
    const areaType = areaTypes[(batch - 1) % areaTypes.length]

    const results = await Promise.allSettled([
      cookie ? fetchNeteasePersonalFmBatches(cookie, count, 6) : Promise.resolve(null),
      cookie ? NeteaseAPI.recommend_songs({ cookie }) : Promise.resolve(null),
      NeteaseAPI.personalized_newsong({ limit: 100 }),
      NeteaseAPI.top_song({ type: areaType }),
      NeteaseAPI.personalized({ limit: 30 })
    ])
    const fmBody = settledExploreValue(results[0], { body: {} })?.body || {}
    const dailyBody = settledExploreValue(results[1], { body: {} })?.body || {}
    const newSongBody = settledExploreValue(results[2], { body: {} })?.body || {}
    const topSongBody = settledExploreValue(results[3], { body: {} })?.body || {}
    const playlistBody = settledExploreValue(results[4], { body: {} })?.body || {}

    const playlistSummaries = playlistBody.result || []
    const rotatedPlaylists = playlistSummaries.length > 0
      ? [...playlistSummaries.slice((batch * 3) % playlistSummaries.length), ...playlistSummaries].slice(0, 4)
      : []
    const playlistTracks = (await Promise.all(rotatedPlaylists.map(playlist =>
      fetchNeteasePlaylistTracks(playlist.id, cookie, 80).catch(() => [])
    ))).flat()

    const rawCandidates = [
      ...(fmBody.data || []),
      ...(dailyBody.data?.dailySongs || dailyBody.recommend || []),
      ...(newSongBody.result || []).map(item => item?.song || item),
      ...(topSongBody.data || []),
      ...playlistTracks
    ]
    const songs = []
    const seen = new Set(excluded)
    for (const candidate of rawCandidates) {
      const song = normalizeNeteaseExploreSong(candidate, { coverUrl: candidate?.picUrl || '' })
      const key = String(song?.id || '')
      if (!song || !key || seen.has(key)) continue
      seen.add(key)
      songs.push(song)
      if (songs.length >= count) break
    }

    res.setHeader('Cache-Control', 'private, no-store')
    return res.json({ code: 200, songs, batch, hasMore: true })
  } catch (error) {
    console.error('[探索模式][网易云] 获取下一批无限推荐失败:', error)
    return res.status(502).json({ code: 502, error: error?.message || '获取下一批无限推荐失败' })
  }
})

async function fetchQQChartPages(id, maxTracks = 1000) {
  const pageSize = 100
  let firstResult = null
  const tracks = []
  const seen = new Set()
  for (let pageNo = 1; tracks.length < maxTracks; pageNo += 1) {
    const result = await qqMusicApi.api('top', { id: Number(id), pageNo, pageSize })
    if (!firstResult) firstResult = result || {}
    const pageTracks = result?.list || []
    for (const track of pageTracks) {
      const key = String(track?.mid || track?.songmid || track?.songMid || track?.id || track?.songid || '')
      if (!key || seen.has(key)) continue
      seen.add(key)
      tracks.push(track)
      if (tracks.length >= maxTracks) break
    }
    const total = Number(result?.total || firstResult?.total || 0)
    if (pageTracks.length < pageSize || (total > 0 && tracks.length >= total)) break
  }
  return { ...(firstResult || {}), list: tracks }
}

async function fetchNeteasePersonalFmBatches(cookie, targetCount = 21, maxBatches = 8) {
  let firstResult = null
  const songs = []
  const seen = new Set()
  let noGrowthCount = 0

  for (let batch = 0; batch < maxBatches && songs.length < targetCount; batch += 1) {
    const result = await NeteaseAPI.personal_fm({ cookie })
    if (!firstResult) firstResult = result || {}
    const candidates = result?.body?.data || []
    const before = songs.length
    for (const song of candidates) {
      const key = String(song?.id || '')
      if (!key || seen.has(key)) continue
      seen.add(key)
      songs.push(song)
      if (songs.length >= targetCount) break
    }
    noGrowthCount = songs.length === before ? noGrowthCount + 1 : 0
    if (!Array.isArray(candidates) || candidates.length === 0 || noGrowthCount >= 2) break
    if (batch < maxBatches - 1 && songs.length < targetCount) {
      await new Promise(resolve => setTimeout(resolve, 80))
    }
  }

  return {
    ...(firstResult || {}),
    body: { ...(firstResult?.body || {}), data: songs }
  }
}

const neteasePlaylistTrackIdCache = new Map()
const neteaseSongDetailCache = new Map()
const NETEASE_PLAYLIST_META_TTL = 5 * 60 * 1000
const NETEASE_SONG_DETAIL_TTL = 20 * 60 * 1000

function setNeteaseSongDetailCache(song) {
  const key = String(song?.id || '')
  if (!key) return
  neteaseSongDetailCache.set(key, { song, expiresAt: Date.now() + NETEASE_SONG_DETAIL_TTL })
  if (neteaseSongDetailCache.size > 5000) {
    for (const oldestKey of neteaseSongDetailCache.keys()) {
      neteaseSongDetailCache.delete(oldestKey)
      if (neteaseSongDetailCache.size <= 3500) break
    }
  }
}

async function getNeteasePlaylistTrackIds(id, cookie = '') {
  const cacheKey = String(id)
  const cached = neteasePlaylistTrackIdCache.get(cacheKey)
  if (cached && cached.expiresAt > Date.now()) return cached.ids

  let playlist = null
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 12000)
    try {
      const url = new URL('https://music.163.com/api/v6/playlist/detail')
      url.searchParams.set('id', String(id))
      url.searchParams.set('n', '100000')
      url.searchParams.set('s', '0')
      const response = await fetch(url, {
        headers: {
          Referer: 'https://music.163.com/',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          ...(cookie ? { Cookie: String(cookie).replace(/[\r\n]/g, '').trim() } : {})
        },
        signal: controller.signal
      })
      const data = await response.json()
      if (response.ok && Number(data?.code) === 200) playlist = data.playlist
    } finally {
      clearTimeout(timeout)
    }
  } catch (error) {
    console.warn('[网易云歌单] Web 详情端点失败，降级到增强 API:', error.message)
  }

  if (!playlist) {
    const result = await NeteaseAPI.playlist_detail({
      id: String(id),
      s: 0,
      cookie: String(cookie || '')
    })
    playlist = result?.body?.playlist
  }

  for (const song of playlist?.tracks || []) setNeteaseSongDetailCache(song)
  const ids = (playlist?.trackIds || [])
    .map(item => String(item?.id || ''))
    .filter(Boolean)
  if (ids.length > 0) {
    neteasePlaylistTrackIdCache.set(cacheKey, {
      ids,
      expiresAt: Date.now() + NETEASE_PLAYLIST_META_TTL
    })
    while (neteasePlaylistTrackIdCache.size > 100) {
      neteasePlaylistTrackIdCache.delete(neteasePlaylistTrackIdCache.keys().next().value)
    }
  }
  return ids
}

async function fetchNeteaseSongDetailBatches(ids, cookie = '') {
  const groups = []
  for (let index = 0; index < ids.length; index += 50) groups.push(ids.slice(index, index + 50))
  const songs = []
  let cursor = 0
  const worker = async () => {
    while (cursor < groups.length) {
      const group = groups[cursor]
      cursor += 1
      let batchSongs = []
      try {
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), 10000)
        try {
          const url = new URL('https://music.163.com/api/song/detail/')
          url.searchParams.set('ids', JSON.stringify(group.map(id => Number(id))))
          const response = await fetch(url, {
            headers: {
              Referer: 'https://music.163.com/',
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
              ...(cookie ? { Cookie: String(cookie).replace(/[\r\n]/g, '').trim() } : {})
            },
            signal: controller.signal
          })
          const data = await response.json()
          if (response.ok && Number(data?.code) === 200) batchSongs = data.songs || []
        } finally {
          clearTimeout(timeout)
        }
      } catch (error) {
        console.warn('[网易云歌单] Web 歌曲详情端点失败，降级到增强 API:', error.message)
      }

      if (batchSongs.length === 0) {
        const result = await NeteaseAPI.song_detail({ ids: group.join(','), cookie: String(cookie || '') })
        batchSongs = result?.body?.songs || []
      }
      for (const song of batchSongs) {
        setNeteaseSongDetailCache(song)
        songs.push(song)
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(2, groups.length) }, () => worker()))
  return songs
}

async function fetchNeteasePlaylistTrackPage(id, cookie = '', offset = 0, limit = 120) {
  const orderedIds = await getNeteasePlaylistTrackIds(id, cookie)
  const safeOffset = Math.max(0, Number(offset) || 0)
  const safeLimit = Math.max(1, Math.min(Number(limit) || 120, 500))
  const pageIds = orderedIds.slice(safeOffset, safeOffset + safeLimit)
  const songsById = new Map()
  const missingIds = []

  for (const trackId of pageIds) {
    const cached = neteaseSongDetailCache.get(trackId)
    if (cached && cached.expiresAt > Date.now()) songsById.set(trackId, cached.song)
    else missingIds.push(trackId)
  }

  if (missingIds.length > 0) {
    for (const song of await fetchNeteaseSongDetailBatches(missingIds, cookie)) {
      songsById.set(String(song.id), song)
    }
  }

  // 上游偶尔对较大的歌曲详情请求只返回极少数结果；仅针对缺失项用 10 首小批次补一次。
  const retryIds = pageIds.filter(trackId => !songsById.has(trackId))
  if (retryIds.length > 0 && retryIds.length < pageIds.length) {
    for (let index = 0; index < retryIds.length; index += 10) {
      for (const song of await fetchNeteaseSongDetailBatches(retryIds.slice(index, index + 10), cookie)) {
        songsById.set(String(song.id), song)
      }
    }
  }

  const nextOffset = Math.min(orderedIds.length, safeOffset + pageIds.length)
  return {
    tracks: pageIds.map(trackId => songsById.get(trackId)).filter(Boolean),
    total: orderedIds.length,
    offset: safeOffset,
    limit: safeLimit,
    nextOffset,
    more: nextOffset < orderedIds.length
  }
}

async function fetchNeteasePlaylistTracks(id, cookie = '', maxTracks = 10000) {
  const pageSize = 500
  const tracks = []
  const seen = new Set()
  let lastError = null

  // playlist_track_all 偶尔只返回歌单开头的一小部分歌曲，却仍然是成功响应。
  // 先读取完整 trackIds，再分批查询歌曲详情，才能区分“609 首歌单”和“只返回 6 首”。
  try {
    const detailResult = await NeteaseAPI.playlist_detail({
      id: String(id),
      s: 0,
      cookie: String(cookie || '')
    })
    const orderedIds = (detailResult?.body?.playlist?.trackIds || [])
      .map(item => String(item?.id || ''))
      .filter(Boolean)
      .slice(0, maxTracks)

    if (orderedIds.length > 0) {
      const songsById = new Map()
      for (let offset = 0; offset < orderedIds.length; offset += pageSize) {
        const ids = orderedIds.slice(offset, offset + pageSize)
        const result = await NeteaseAPI.song_detail({
          ids: ids.join(','),
          cookie: String(cookie || '')
        })
        for (const song of result?.body?.songs || []) {
          const key = String(song?.id || '')
          if (key) songsById.set(key, song)
        }
      }

      const orderedSongs = orderedIds.map(trackId => songsById.get(trackId)).filter(Boolean)
      if (orderedSongs.length > 0) return orderedSongs
    }
  } catch (error) {
    lastError = error
    console.warn('[网易云歌单] 使用 trackIds 补齐完整歌曲失败，尝试分页接口:', error.message)
  }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    tracks.length = 0
    seen.clear()
    try {
      for (let offset = 0; offset < maxTracks; offset += pageSize) {
        const result = await NeteaseAPI.playlist_track_all({
          id: String(id),
          limit: Math.min(pageSize, maxTracks - offset),
          offset,
          cookie: String(cookie || '')
        })
        const pageSongs = result?.body?.songs || []
        for (const song of pageSongs) {
          const key = String(song?.id || '')
          if (!key || seen.has(key)) continue
          seen.add(key)
          tracks.push(song)
        }
        if (pageSongs.length < Math.min(pageSize, maxTracks - offset)) break
      }
      if (tracks.length > 0) return tracks
    } catch (error) {
      lastError = error
      if (attempt === 0) await new Promise(resolve => setTimeout(resolve, 160))
    }
  }

  // playlist_track_all 偶发被上游重置连接。网易云公开详情端点返回同一份
  // 榜单/公开歌单数据，用作只读降级，避免 UI 间歇性出现 0 首或 502。
  try {
    const playlist = await fetchNeteasePublicPlaylist(id, maxTracks)
    return (playlist?.tracks || []).slice(0, maxTracks)
  } catch (fallbackError) {
    throw lastError || fallbackError
  }
}

async function fetchNeteasePublicPlaylist(id, limit = 1000) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 12000)
  try {
    const url = new URL('https://music.163.com/api/v6/playlist/detail')
    url.searchParams.set('id', String(id))
    url.searchParams.set('n', String(Math.max(1, Math.min(Number(limit) || 1000, 10000))))
    url.searchParams.set('s', '0')
    const response = await fetch(url, {
      headers: {
        Referer: 'https://music.163.com/',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      },
      signal: controller.signal
    })
    if (!response.ok) throw new Error(`网易云公开歌单详情 HTTP ${response.status}`)
    const data = await response.json()
    if (Number(data?.code) !== 200 || !data?.playlist) {
      throw new Error(data?.message || '网易云公开歌单详情返回无效数据')
    }
    return data.playlist
  } finally {
    clearTimeout(timeout)
  }
}

async function fetchNeteaseRadioPrograms(id, cookie = '', maxPrograms = 5000) {
  const pageSize = 100
  let firstBody = null
  const programs = []
  const seen = new Set()
  for (let offset = 0; offset < maxPrograms; offset += pageSize) {
    const result = await NeteaseAPI.dj_program({
      rid: String(id),
      limit: Math.min(pageSize, maxPrograms - offset),
      offset,
      asc: 'false',
      cookie: String(cookie || '')
    })
    const body = result?.body || {}
    if (!firstBody) firstBody = body
    const pagePrograms = body.programs || body.data?.programs || []
    for (const program of pagePrograms) {
      const key = String(program?.id || program?.mainSong?.id || program?.mainTrack?.id || '')
      if (!key || seen.has(key)) continue
      seen.add(key)
      programs.push(program)
    }
    const total = Number(body.count || firstBody?.count || 0)
    const hasMore = body.more === true || (total > 0 && programs.length < total)
    if (!hasMore || pagePrograms.length === 0) break
  }
  return { ...(firstBody || {}), programs, count: Number(firstBody?.count || programs.length) }
}

app.get('/api/explore/qq', async (req, res) => {
  try {
    const cookie = String(req.query.cookie || '')
    const hasLogin = Boolean(resolveRequestCookie(cookie))
    const skillKey = getQQMusicSkillKey(req)
    // Skills Key 与 QQ 账号绑定；未登录时不调用也不暴露任何 Skills 内容。
    const hasOfficialSkill = Boolean(hasLogin && skillKey)

    const calls = [
      qqMusicApi.api('top/category', { showDetail: 1 }),
      qqMusicApi.api('recommend/playlist/u'),
      qqMusicApi.api('songlist/list', { id: 10000000, page: 1, pageSize: 30, sort: 5 }),
      Promise.all([3317, 59, 71, 3056, 64].map(id =>
        qqMusicApi.api('recommend/playlist', { id, pageNo: 1, pageSize: 20 })
      )),
      qqMusicApi.api('new/songs', { type: 0 }),
      qqMusicApi.api('radio/category'),
      // QQ 电台 99 就是客户端里的“猜你喜欢”。旧实现只取了电台分类，
      // 没有真正请求歌曲，所以探索页主推荐一直由每日推荐或新歌代替。
      hasLogin ? fetchQQRadioBatches(99, 30, 8, cookie) : Promise.resolve(null),
      // 每日推荐是分页接口。这里必须聚合分页，简约模式的“每日 30 首”
      // 才不会只显示官方接口首批返回的 5 首。
      hasOfficialSkill ? requestQQMusicSkillPages('/discover/daily-mix', {}, skillKey, 'songlist', 30) : Promise.resolve(null),
      // Skill 电台首批通常只有 5 首，且部分响应不会提供 hasMore。
      hasOfficialSkill ? requestQQMusicSkillBatches('/discover/radio', {}, skillKey, 'songlist', 30) : Promise.resolve(null),
      hasOfficialSkill ? requestQQMusicSkill('/discover/ai-playlists', { reqType: 'all' }, skillKey) : Promise.resolve(null),
      hasOfficialSkill ? requestQQMusicSkill('/charts', {}, skillKey) : Promise.resolve(null)
    ]
    const [
      chartResult,
      playlistResult,
      hotPlaylistResult,
      categoryPlaylistResult,
      newSongResult,
      radioResult,
      personalizedRadioResult,
      skillDailyResult,
      skillRadioResult,
      skillPlaylistResult,
      skillChartResult
    ] = await settleExploreCallsWithDeadline(calls)

    const chartGroups = settledExploreValue(chartResult, []) || []
    const communityPlaylists = settledExploreValue(playlistResult, { list: [] })?.list || []
    const hotPlaylists = settledExploreValue(hotPlaylistResult, { list: [] })?.list || []
    const categoryPlaylists = (settledExploreValue(categoryPlaylistResult, []) || []).flatMap(result =>
      result?.list || result?.data?.list || []
    )
    const newSongPayload = settledExploreValue(newSongResult, { list: [] }) || {}
    const publicNewSongs = newSongPayload.list || newSongPayload.data?.list || newSongPayload.songlist || []
    const radioGroups = settledExploreValue(radioResult, []) || []
    const personalizedRadio = settledExploreValue(personalizedRadioResult, null)
    const skillDaily = settledExploreValue(skillDailyResult, null)
    const skillRadio = settledExploreValue(skillRadioResult, null)
    const skillPlaylistSummaries = settledExploreValue(skillPlaylistResult, null)?.playlists || []
    const skillCharts = settledExploreValue(skillChartResult, null)?.groupList || []
    const officialEnhanced = hasOfficialSkill && [skillDailyResult, skillRadioResult, skillPlaylistResult, skillChartResult]
      .some(result => result.status === 'fulfilled' && Boolean(result.value))

    const skillPlaylists = []
    for (const playlist of skillPlaylistSummaries.slice(0, 12)) {
      const hasCover = playlist?.picUrl || playlist?.picurl || playlist?.cover || playlist?.coverUrl || playlist?.cover_url_big
      if (hasCover || !skillKey) {
        skillPlaylists.push(playlist)
        continue
      }
      try {
        const detail = await requestQQMusicSkill('/playlists/detail', {
          dissId: Number(playlist.dissId || playlist.dissid || playlist.id),
          page: 0
        }, skillKey)
        skillPlaylists.push({
          ...playlist,
          picUrl: detail?.picUrl || '',
          song_cnt: detail?.totalNum || playlist.song_cnt,
          dissDesc: playlist.dissDesc || detail?.desc || ''
        })
      } catch {
        skillPlaylists.push(playlist)
      }
      await new Promise(resolve => setTimeout(resolve, 80))
    }
    skillPlaylists.push(...skillPlaylistSummaries.slice(12))

    const officialDailyRaw = Array.isArray(skillDaily?.songlist) ? skillDaily.songlist : []
    let officialDailySongs = []
    if (officialDailyRaw.length > 0) {
      const enriched = await Promise.all(officialDailyRaw.slice(0, 30).map(async song => {
        const mid = song.songMid || song.mid
        // Skills 的简略歌曲对象通常不带专辑封面；每一首都补全详情，
        // 避免第 13 首起统一退化为无封面占位图。
        if (!mid) return normalizeQQExploreSong(song)
        try {
          return normalizeQQExploreSong(await qqSongDetail(mid, {
            mid,
            name: song.songName,
            singerName: song.singerName
          }))
        } catch {
          return normalizeQQExploreSong(song)
        }
      }))
      officialDailySongs = enriched.filter(Boolean)
    }

    const personalizedRadioRaw = personalizedRadio?.tracks || personalizedRadio?.songlist || personalizedRadio?.list || []
    const personalizedRadioSongs = (Array.isArray(personalizedRadioRaw) ? personalizedRadioRaw : [])
      .map(song => normalizeQQExploreSong(song))
      .filter(Boolean)
    const mergeQQSongs = (...groups) => Array.from(new Map(groups
      .flat()
      .filter(Boolean)
      .map(song => [String(song.mid || song.id || ''), song]))
      .values())
      .filter(song => song.mid || song.id)
    const dailySongs = mergeQQSongs(officialDailySongs, personalizedRadioSongs).slice(0, 30)

    const officialRadioRaw = Array.isArray(skillRadio?.songlist) ? skillRadio.songlist : []
    const officialRadioSongs = (await Promise.all(officialRadioRaw.map(async song => {
      const mid = song.songMid || song.mid
      if (!mid) return normalizeQQExploreSong(song)
      try {
        return normalizeQQExploreSong(await qqSongDetail(mid, {
          mid,
          name: song.songName,
          singerName: song.singerName
        }))
      } catch {
        return normalizeQQExploreSong(song)
      }
    }))).filter(Boolean)
    const radioSongs = mergeQQSongs(personalizedRadioSongs, officialRadioSongs).slice(0, 30)

    const normalizedCommunityPlaylists = [...communityPlaylists, ...hotPlaylists, ...categoryPlaylists]
      .map(item => normalizeQQExplorePlaylist(item, 'community'))
      .filter(Boolean)
    const normalizedSkillPlaylists = skillPlaylists
      .map(item => normalizeQQExplorePlaylist(item, 'qqmusic-skills'))
      .filter(Boolean)
    const playlistIds = new Set()
    const playlists = [...normalizedSkillPlaylists, ...normalizedCommunityPlaylists]
      .filter(item => {
        if (playlistIds.has(item.id)) return false
        playlistIds.add(item.id)
        return true
      })

    const communityCharts = chartGroups.flatMap(group => (group?.list || []).map(chart => ({
      id: String(chart.topId || chart.value),
      name: chart.label || 'QQ 音乐榜单',
      group: group.title || '榜单',
      description: stripExploreMarkup(chart.intro || ''),
      coverUrl: normalizeQQImageUrl(chart.picUrl),
      playCount: Number(chart.listenNum || 0),
      updateText: chart.updateTime || chart.period || '',
      platform: 'qq',
      source: 'community',
      songs: (chart.song || []).slice(0, 3).map(song => ({
        id: Number(song.songId || 0),
        // 播放必须用 mid（QQ song/url 接口不接受纯数字 id），此前漏传导致榜单歌曲点播失败
        mid: String(song.songMid || song.songmid || song.mid || ''),
        name: song.title || song.songName || '未知歌曲',
        artist: song.singerName || '未知歌手',
        coverUrl: normalizeQQImageUrl(song.cover) || (song.albumMid ? qqAlbumCover(song.albumMid, 500) : '')
      }))
    })))

    const communityChartById = new Map(communityCharts.map(chart => [chart.id, chart]))
    const officialCharts = skillCharts.flatMap(group => (group.groupTopList || []).map(chart => {
      const community = communityChartById.get(String(chart.topId))
      return {
        id: String(chart.topId),
        name: chart.topName || 'QQ 音乐榜单',
        group: group.groupName || '榜单',
        description: community?.description || '',
        coverUrl: community?.coverUrl || normalizeQQImageUrl(chart.topHeaderPic || chart.topBannerPic || ''),
        playCount: Number(chart.listenNum || 0),
        updateText: community?.updateText || '',
        platform: 'qq',
        source: 'qqmusic-skills',
        songs: (chart.songList || []).slice(0, 3).map(song => ({
          id: Number(song.songId || 0),
          mid: String(song.songMid || song.songmid || song.mid || ''),
          name: song.songName || '未知歌曲',
          artist: song.singerName || '未知歌手',
          // 官方榜单 songList 不带封面，优先从 community 同名榜单的歌曲补封面
          coverUrl: community?.songs?.find(s => s.name === (song.songName || ''))?.coverUrl
            || normalizeQQImageUrl(song.cover)
            || (song.albumMid ? qqAlbumCover(song.albumMid, 500) : '')
        }))
      }
    }))
    const chartIds = new Set()
    const charts = [...officialCharts, ...communityCharts].filter(chart => {
      if (chartIds.has(chart.id)) return false
      chartIds.add(chart.id)
      return true
    })

    const channels = radioGroups.flatMap(group => {
      const items = group?.list || group?.radio_list || []
      return items.map(channel => ({
        id: String(channel.id),
        name: channel.title || channel.name || '音乐电台',
        group: group.title || '电台',
        description: channel.listenDesc || '',
        coverUrl: normalizeQQImageUrl(channel.pic_url || channel.picUrl),
        playCount: Number(channel.listenNum || 0),
        platform: 'qq'
      }))
    })

    res.setHeader('Cache-Control', 'private, max-age=120')
    res.setHeader('Vary', 'X-QQMusic-Skill-Key')
    const hasPersonalizedRecommendation = hasLogin && (
      personalizedRadioSongs.length > 0 ||
      (hasOfficialSkill && (officialRadioSongs.length > 0 || officialDailySongs.length > 0))
    )

    res.json({
      code: 200,
      platform: 'qq',
      officialEnhanced,
      // 有 Cookie 不等于推荐已经个性化；只有账号电台或已验证的 Skill
      // 确实返回内容时才标记为个性化，避免把公共降级内容伪装成猜你喜欢。
      personalized: hasPersonalizedRecommendation,
      dailySongs,
      radioSongs,
      newSongs: publicNewSongs.map(item => normalizeQQExploreSong(item)).filter(Boolean).slice(0, 50),
      playlists,
      charts: charts.slice(0, 30),
      channels,
      meta: {
        source: officialEnhanced ? 'qqmusic-skills + QQMusicApi' : 'QQMusicApi',
        recommendationSource: personalizedRadioSongs.length > 0
          ? 'qq-guess-you-like'
          : officialRadioSongs.length > 0
            ? 'qqmusic-skills-radio'
            : dailySongs.length > 0
              ? 'qq-daily'
              : 'public',
        updatedAt: Date.now()
      }
    })
  } catch (error) {
    console.error('[探索模式][QQ音乐] 获取聚合数据失败:', error)
    res.status(502).json({ code: 502, error: error.message || 'QQ 音乐探索数据加载失败' })
  }
})

app.get('/api/explore/netease', async (req, res) => {
  try {
    if (!NeteaseAPI) return res.status(503).json({ code: 503, error: '网易云 API 未初始化' })

    const cookie = String(req.query.cookie || '')
    const hasLogin = Boolean(cookie)
    const calls = [
      NeteaseAPI.personalized({ limit: 30 }),
      NeteaseAPI.personalized_newsong({ limit: 30 }),
      NeteaseAPI.top_song({ type: 0 }),
      NeteaseAPI.toplist_detail(),
      NeteaseAPI.personalized_djprogram(),
      NeteaseAPI.dj_personalize_recommend({ limit: 30 }),
      NeteaseAPI.dj_program_toplist({ limit: 30, offset: 0 }),
      hasLogin ? NeteaseAPI.recommend_songs({ cookie }) : Promise.resolve(null),
      // 私人 FM 每次只返回一个很小的动态批次；连续拉取并去重，避免“更多”里只有 3 首。
      hasLogin ? fetchNeteasePersonalFmBatches(cookie, 30) : Promise.resolve(null),
      hasLogin ? NeteaseAPI.recommend_resource({ cookie }) : Promise.resolve(null)
    ]
    const [
      playlistResult,
      newSongResult,
      topSongResult,
      chartResult,
      channelResult,
      channelRecommendResult,
      channelToplistResult,
      dailyResult,
      fmResult,
      resourceResult
    ] = await Promise.allSettled(calls)

    const publicPlaylists = settledExploreValue(playlistResult, { body: { result: [] } })?.body?.result || []
    const recommendedResources = settledExploreValue(resourceResult, { body: { recommend: [] } })?.body?.recommend || []
    const playlistIds = new Set()
    const playlists = [...recommendedResources, ...publicPlaylists]
      .map(item => ({
        id: String(item.id),
        name: item.name || '网易云歌单',
        description: stripExploreMarkup(item.copywriter || item.description || ''),
        coverUrl: item.picUrl || item.coverImgUrl || '',
        playCount: Number(item.playcount || item.playCount || 0),
        trackCount: Number(item.trackCount || 0),
        creator: item.creator?.nickname || '',
        platform: 'netease',
        source: hasLogin && recommendedResources.some(resource => String(resource.id) === String(item.id))
          ? 'personalized'
          : 'community'
      }))
      .filter(item => item.id && !playlistIds.has(item.id) && playlistIds.add(item.id))
      .slice(0, 30)

    const dailyBody = settledExploreValue(dailyResult, { body: {} })?.body || {}
    const fmBody = settledExploreValue(fmResult, { body: {} })?.body || {}
    const newSongBody = settledExploreValue(newSongResult, { body: {} })?.body || {}
    const topSongBody = settledExploreValue(topSongResult, { body: {} })?.body || {}
    const dailySongs = (dailyBody.data?.dailySongs || dailyBody.recommend || [])
      .map(item => normalizeNeteaseExploreSong(item))
      .filter(Boolean)
      .slice(0, 30)
    const radioSongs = (fmBody.data || [])
      .map(item => normalizeNeteaseExploreSong(item))
      .filter(Boolean)
      .slice(0, 30)
    const newSongIds = new Set()
    const newSongs = [...(newSongBody.result || []), ...(topSongBody.data || [])]
      .filter(item => {
        const id = String(item?.song?.id || item?.id || '')
        if (!id || newSongIds.has(id)) return false
        newSongIds.add(id)
        return true
      })
      .map(item => normalizeNeteaseExploreSong(item, { coverUrl: item.picUrl }))
      .filter(Boolean)
      .slice(0, 50)

    const chartBody = settledExploreValue(chartResult, { body: {} })?.body || {}
    const charts = (chartBody.list || []).map(chart => ({
      id: String(chart.id),
      name: chart.name || '网易云榜单',
      group: chart.ToplistType ? '官方榜' : '特色榜',
      description: stripExploreMarkup(chart.description || ''),
      coverUrl: chart.coverImgUrl || '',
      playCount: Number(chart.playCount || 0),
      updateText: chart.updateFrequency || '',
      platform: 'netease',
      songs: (chart.tracks || []).slice(0, 3).map((song, index) => ({
        id: 0,
        name: song.first || song.name || '未知歌曲',
        artist: song.second || song.artist || '未知歌手',
        coverUrl: '',
        rank: index + 1
      }))
    })).slice(0, 30)
    await Promise.all(charts.slice(0, 12).map(async chart => {
      if (chart.songs.length > 0) return
      try {
        const playlist = await fetchNeteasePublicPlaylist(chart.id, 3)
        chart.songs = (playlist?.tracks || []).slice(0, 3).map((song, index) => ({
          id: Number(song.id) || 0,
          name: song.name || '未知歌曲',
          artist: (song.ar || song.artists || []).map(artist => artist.name).filter(Boolean).join(' / ') || '未知歌手',
          coverUrl: song.al?.picUrl || song.album?.picUrl || '',
          rank: index + 1
        }))
      } catch (error) {
        console.warn(`[探索模式][网易云] ${chart.name} 预览补全失败:`, error?.message || error)
      }
    }))

    const channelBody = settledExploreValue(channelResult, { body: {} })?.body || {}
    const channelRecommendBody = settledExploreValue(channelRecommendResult, { body: {} })?.body || {}
    const channelToplistBody = settledExploreValue(channelToplistResult, { body: {} })?.body || {}
    const channelIds = new Set()
    const channelCandidates = [
      ...(channelBody.result || []),
      ...(Array.isArray(channelRecommendBody.data)
        ? channelRecommendBody.data
        : Array.isArray(channelRecommendBody.djRadios) ? channelRecommendBody.djRadios : []),
      ...(Array.isArray(channelToplistBody.toplist)
        ? channelToplistBody.toplist
        : Array.isArray(channelToplistBody.programs) ? channelToplistBody.programs : [])
    ]
    const channels = channelCandidates.map(item => {
      const program = item.program || item || {}
      const radio = program.radio || item.radio || (item.dj ? item : {})
      const radioId = String(radio.id || program.radioId || program.id || item.id || '')
      return {
        id: radioId,
        name: radio.name || item.name || program.name || '声音节目',
        group: radio.category || program.category || '播客',
        description: item.copywriter || radio.desc || program.description || '',
        coverUrl: radio.picUrl || item.picUrl || program.coverUrl || program.blurCoverUrl || '',
        playCount: Number(radio.subCount || program.listenerCount || program.likedCount || 0),
        platform: 'netease',
        song: normalizeNeteaseExploreSong(program.mainSong, { coverUrl: item.picUrl })
      }
    }).filter(item => item.id && !channelIds.has(item.id) && channelIds.add(item.id))

    res.setHeader('Cache-Control', 'private, max-age=120')
    res.json({
      code: 200,
      platform: 'netease',
      officialEnhanced: false,
      personalized: dailySongs.length > 0 || radioSongs.length > 0,
      dailySongs,
      radioSongs,
      newSongs,
      playlists,
      charts,
      channels,
      meta: {
        source: 'NeteaseCloudMusicApiEnhanced',
        updatedAt: Date.now()
      }
    })
  } catch (error) {
    console.error('[探索模式][网易云] 获取聚合数据失败:', error)
    res.status(502).json({ code: 502, error: error.message || '网易云探索数据加载失败' })
  }
})

app.get('/api/explore/chart', async (req, res) => {
  try {
    const { platform = 'netease', id, cookie = '', source = '' } = req.query
    if (!id) return res.status(400).json({ code: 400, error: '请提供榜单 ID' })

    if (platform === 'qq') {
      const hasLogin = Boolean(resolveRequestCookie(String(cookie || '')))
      const skillKey = getQQMusicSkillKey(req)
      if (source === 'qqmusic-skills' && hasLogin && skillKey) {
        const chart = await requestQQMusicSkillPages(
          '/charts/detail',
          { topId: Number(id) },
          skillKey,
          'trackList'
        )
        const songs = (chart?.trackList || []).map(item => normalizeQQExploreSong(item)).filter(Boolean)
        return res.json({
          code: 200,
          playlist: {
            id: String(id),
            name: chart?.topName || String(req.query.name || 'QQ 音乐榜单'),
            coverImgUrl: normalizeQQImageUrl(chart?.topHeaderPic || chart?.topBannerPic || req.query.coverUrl || ''),
            trackCount: Number(chart?.totalNum || songs.length),
            description: stripExploreMarkup(chart?.topDesc || req.query.description || ''),
            platform: 'qq'
          },
          songs
        })
      }
      const chart = await fetchQQChartPages(id)
      const songs = (chart?.list || []).map(item => normalizeQQExploreSong(item)).filter(Boolean)
      return res.json({
        code: 200,
        playlist: {
          id: String(id),
          name: chart?.info?.title || 'QQ 音乐榜单',
          coverImgUrl: normalizeQQImageUrl(chart?.info?.picUrl),
          trackCount: Number(chart?.total || songs.length),
          description: stripExploreMarkup(chart?.info?.desc || chart?.info?.titleDetail || ''),
          platform: 'qq'
        },
        songs
      })
    }

    let publicPlaylist = null
    try {
      publicPlaylist = await fetchNeteasePublicPlaylist(id, 10000)
    } catch {
      // 登录态或上游网络不允许公开端点时，再走带 Cookie 的 API 适配层。
    }
    const tracks = publicPlaylist?.tracks?.length
      ? publicPlaylist.tracks
      : await fetchNeteasePlaylistTracks(id, cookie, 10000)
    const songs = tracks
      .map(item => normalizeNeteaseExploreSong(item))
      .filter(Boolean)
    res.json({
      code: 200,
      playlist: {
        id: String(id),
        name: publicPlaylist?.name || String(req.query.name || '网易云榜单'),
        coverImgUrl: publicPlaylist?.coverImgUrl || String(req.query.coverUrl || ''),
        trackCount: songs.length,
        description: stripExploreMarkup(publicPlaylist?.description || req.query.description || ''),
        platform: 'netease'
      },
      songs
    })
  } catch (error) {
    console.error('[探索模式] 获取榜单详情失败:', error)
    res.status(502).json({ code: 502, error: error.message || '榜单详情加载失败' })
  }
})

app.get('/api/explore/radio', async (req, res) => {
  try {
    const { platform = 'qq', id, cookie = '' } = req.query
    if (!id) return res.status(400).json({ code: 400, error: '请提供电台 ID' })

    if (platform === 'netease') {
      if (!NeteaseAPI?.dj_program) {
        return res.status(503).json({ code: 503, error: '网易云播客 API 未初始化' })
      }
      const radio = await fetchNeteaseRadioPrograms(id, cookie)
      const programs = radio.programs || []
      const songs = programs
        .map(program => normalizeNeteaseExploreSong(program.mainSong || program.mainTrack || program.song, {
          coverUrl: program.coverUrl || program.blurCoverUrl || req.query.coverUrl || ''
        }))
        .filter(Boolean)
      return res.json({
        code: 200,
        playlist: {
          id: String(id),
          name: radio?.radio?.name || String(req.query.name || '声音与播客'),
          coverImgUrl: radio?.radio?.picUrl || String(req.query.coverUrl || ''),
          trackCount: Number(radio?.count || songs.length),
          description: stripExploreMarkup(radio?.radio?.desc || ''),
          platform: 'netease'
        },
        songs
      })
    }

    resolveRequestCookie(String(cookie || ''))
    // QQ 电台是无 page 参数的动态小批次接口；重复请求、去重后形成可连续播放的完整队列。
    const radio = await fetchQQRadioBatches(id, 30, 8, cookie)
    const rawTracks = radio?.tracks || radio?.songlist || radio?.list || []
    const songs = rawTracks.map(item => normalizeQQExploreSong(item)).filter(Boolean)
    res.json({
      code: 200,
      playlist: {
        id: String(id),
        name: radio?.name || String(req.query.name || 'QQ 音乐电台'),
        coverImgUrl: normalizeQQImageUrl(radio?.bg_pic_url || req.query.coverUrl || ''),
        trackCount: songs.length,
        description: stripExploreMarkup(radio?.slogan || ''),
        platform: 'qq'
      },
      songs
    })
  } catch (error) {
    console.error('[探索模式] 获取 QQ 电台失败:', error)
    res.status(502).json({ code: 502, error: error.message || '电台加载失败' })
  }
})

app.get('/api/explore/qq/skills/status', async (req, res) => {
  try {
    const hasLogin = Boolean(resolveRequestCookie(String(req.query.cookie || '')))
    if (!hasLogin) return res.status(401).json({ code: 401, error: '请先登录 QQ 音乐' })
    const skillKey = getQQMusicSkillKey(req)
    if (!skillKey) return res.json({ code: 200, configured: false, valid: false })
    await requestQQMusicSkill('/charts', {}, skillKey)
    res.json({ code: 200, configured: true, valid: true, version: QQMUSIC_SKILL_VERSION })
  } catch (error) {
    res.status(401).json({ code: 401, configured: true, valid: false, error: error.message || 'API Key 验证失败' })
  }
})

app.get('/api/explore/qq/skills/report', async (req, res) => {
  try {
    const hasLogin = Boolean(resolveRequestCookie(String(req.query.cookie || '')))
    const skillKey = getQQMusicSkillKey(req)
    if (!hasLogin) return res.status(401).json({ code: 401, error: '请先登录 QQ 音乐' })
    if (!skillKey) return res.status(401).json({ code: 401, error: '请先配置 QQ 音乐官方 API Key' })
    const timeKey = ['d', 'w', 'm'].includes(String(req.query.timeKey)) ? String(req.query.timeKey) : 'm'
    const params = { timeKey }
    const startTime = Number(req.query.startTime || 0)
    if (startTime > 0 && timeKey !== 'm') params.startTime = Math.floor(startTime)
    const report = await requestQQMusicSkill('/me/report', params, skillKey)
    res.setHeader('Cache-Control', 'private, no-store')
    res.json({ code: 200, timeKey, report })
  } catch (error) {
    res.status(502).json({ code: 502, error: error.message || '听歌报告加载失败' })
  }
})

app.post('/api/explore/qq/skills/interpretation', async (req, res) => {
  const hasLogin = Boolean(resolveRequestCookie(String(req.body?.cookie || '')))
  const skillKey = getQQMusicSkillKey(req)
  const query = String(req.body?.query || '').trim().slice(0, 500)
  const assetTypes = Array.isArray(req.body?.assetTypes)
    ? req.body.assetTypes.map(Number).filter(value => value === 1 || value === 2)
    : []

  if (!hasLogin) return res.status(401).json({ code: 401, error: '请先登录 QQ 音乐' })
  if (!skillKey) return res.status(401).json({ code: 401, error: '请先配置 QQ 音乐官方 API Key' })
  if (!query) return res.status(400).json({ code: 400, error: '请输入想要解读的问题' })

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 90000)
  req.on('aborted', () => controller.abort())
  res.on('close', () => {
    if (!res.writableEnded) controller.abort()
  })
  try {
    const upstream = await fetch('https://a.y.qq.com/assistant/ai_interpretation', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${skillKey}`,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream'
      },
      body: JSON.stringify({
        params: { query, ...(assetTypes.length ? { assetTypes } : {}) },
        comm: { skill_version: QQMUSIC_SKILL_VERSION }
      }),
      signal: controller.signal
    })
    if (!upstream.ok || !upstream.body) {
      throw new Error(`QQ 音乐 AI 解读 HTTP ${upstream.status}`)
    }
    // 诊断日志：确认上游返回类型（SSE 或 JSON），便于排查"正在连接后无内容"类问题
    const upstreamType = upstream.headers.get('content-type') || ''
    console.log(`[QQ AI 解读] upstream=${upstream.status} type=${upstreamType}`)
    res.status(200)
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
    res.setHeader('Cache-Control', 'no-cache, no-transform')
    res.setHeader('Connection', 'keep-alive')
    res.flushHeaders?.()
    if (upstreamType.includes('text/event-stream')) {
      // 上游是标准 SSE：原样透传
      for await (const chunk of upstream.body) res.write(chunk)
    } else {
      // 上游返回 JSON（整包）：解析后提取文本，以 SSE data 事件转发，前端才能增量显示
      const json = await upstream.json().catch(() => null)
      if (json) {
        const text =
          json.text || json.content || json.answer || json.reply || json.response ||
          json.data?.text || json.data?.content || json.data?.answer || json.data?.reply || json.data?.response || ''
        if (text) {
          res.write(`data: ${JSON.stringify({ text })}\n\n`)
        } else if (json.code && json.code !== 0) {
          res.write(`\nevent: error\ndata: ${JSON.stringify({ message: json.msg || json.message || 'QQ 音乐 AI 解读失败' })}\n\n`)
        } else {
          res.write(`\nevent: error\ndata: ${JSON.stringify({ message: 'QQ 音乐 AI 未返回有效内容' })}\n\n`)
        }
      }
    }
    res.end()
  } catch (error) {
    if (res.headersSent) {
      res.write(`\nevent: error\ndata: ${JSON.stringify({ message: error.message || 'AI 解读失败' })}\n\n`)
      return res.end()
    }
    res.status(502).json({ code: 502, error: error.message || 'AI 解读失败' })
  } finally {
    clearTimeout(timeout)
  }
})

app.post('/api/qq/user/setCookie', async (req, res) => {
  try {
    const data = req.body?.data || req.body?.cookie
    if (!data) {
      return res.status(400).json({ result: 500, errMsg: '请提供Cookie' })
    }

    // 同时更新本地状态与 qq-music-api，确保 MV、评论和歌单共用登录态。
    setQQMusicCookie(data)
    persistQQMusicCookie(data)
    const cookieObj = parseQQCookie(data)

    // 提取uin（用户ID）- 尝试多个可能的字段
    let uin = cookieObj.uin || cookieObj.wxuin || cookieObj.ts_uid || cookieObj.psrf_qqopenid || ''
    uin = uin.replace(/\D/g, '')
    console.log('📋 Cookie字段:', Object.keys(cookieObj).join(', '))

    res.json({
      result: 100,
      data: {
        message: '登录成功',
        uin
      }
    })
  } catch (error) {
    console.error('设置QQ音乐Cookie错误:', error)
    res.status(500).json({ result: 500, errMsg: error.message })
  }
})

app.get('/api/qq/user/detail', async (req, res) => {
  try {
    const { id, cookie } = req.query
    const devMode = req.query.devMode === 'true'
    if (!id) {
      return res.status(400).json({ result: 500, errMsg: '请提供用户ID' })
    }
    // 读取类路由：请求 cookie 仅本次使用，不回写全局登录态。
    resolveRequestCookie(cookie)
    
    // 使用qq-music-api获取用户信息
    const result = await qqMusicApi.api('user/detail', { id })
    
    if (result && result.creator) {
    } else {
      if (devMode) console.warn('[QQ音乐用户详情] 返回数据格式异常')
    }
    
    res.json(result)
  } catch (error) {
    console.error('[QQ音乐用户详情] 获取错误:', error)
    res.status(500).json({ result: 500, errMsg: error.message })
  }
})

// 获取QQ音乐用户歌单
app.get('/api/qq/user/playlist', async (req, res) => {
  try {
    const { id, cookie } = req.query
    const devMode = req.query.devMode === 'true'
    if (!id) {
      return res.status(400).json({ result: 500, errMsg: '请提供用户ID' })
    }
    // 读取类路由：请求 cookie 仅本次使用，不回写全局登录态。
    resolveRequestCookie(cookie)
    
    // 使用qq-music-api获取用户歌单
    const result = await qqMusicApi.api('user/songlist', { id })
    
    if (devMode) console.log('[QQ音乐用户歌单] API返回结果:', JSON.stringify(result, null, 2))
    
    res.json(result)
  } catch (error) {
    console.error('[QQ音乐用户歌单] 获取错误:', error)
    res.status(500).json({ result: 500, errMsg: error.message, data: { list: [] } })
  }
})

// 获取QQ音乐收藏歌单
app.get('/api/qq/user/collect', async (req, res) => {
  try {
    const { id, cookie, pageNo = 1, pageSize = 100 } = req.query
    const devMode = req.query.devMode === 'true'
    if (!id) {
      return res.status(400).json({ result: 500, errMsg: '请提供用户ID' })
    }
    // 读取类路由：请求 cookie 仅本次使用，不回写全局登录态。
    resolveRequestCookie(cookie)

    // 直接使用库内已有的收藏歌单路由。旧代码调用了不存在的 getCookie()，
    // 因而无论是否登录，请求头里的 Cookie 始终为空。
    const result = await qqMusicApi.api('user/collect/songlist', {
      id,
      pageNo: Number(pageNo),
      pageSize: Number(pageSize)
    })
    if (devMode) console.log('[QQ音乐收藏歌单] 获取数量:', result?.list?.length || 0)
    res.json({ result: 100, data: result || { list: [], total: 0 } })
  } catch (error) {
    console.error('[QQ音乐收藏歌单] 获取错误:', error)
    res.status(500).json({ result: 500, errMsg: error.message, data: { list: [] } })
  }
})

// 获取QQ音乐歌单详情
app.get('/api/qq/playlist/detail', async (req, res) => {
  try {
    const { id, cookie, songNum = 10000, source = '' } = req.query
    const devMode = req.query.devMode === 'true'
    if (!id) {
      return res.status(400).json({ result: 500, errMsg: '请提供歌单ID' })
    }
    const hasLogin = Boolean(resolveRequestCookie(cookie))
    const skillKey = getQQMusicSkillKey(req)
    if (source === 'qqmusic-skills' && hasLogin && skillKey) {
      const skillPlaylist = await requestQQMusicSkillPages(
        '/playlists/detail',
        { dissId: Number(id) },
        skillKey,
        'trackList'
      )
      const rawTracks = skillPlaylist?.trackList || skillPlaylist?.songlist || skillPlaylist?.songList || skillPlaylist?.tracks || skillPlaylist?.songInfoList || []
      // Skills 的简略歌曲对象通常不带封面/时长，逐首用 qqSongDetail 补全，
      // 否则 AI 歌单打开后整列无封面、时长为 0:00。
      const songlist = (await Promise.all(rawTracks.map(async song => {
        const mid = song?.songMid || song?.mid
        if (!mid) return normalizeQQExploreSong(song)
        try {
          return normalizeQQExploreSong(await qqSongDetail(mid, {
            mid,
            name: song.songName,
            singerName: song.singerName
          }))
        } catch {
          return normalizeQQExploreSong(song)
        }
      }))).filter(Boolean)
      return res.json({
        result: 100,
        songlist,
        songnum: Number(skillPlaylist?.totalNum || songlist.length),
        playlist: {
          id: String(id),
          name: skillPlaylist?.dissName || 'QQ 音乐 AI 歌单',
          coverImgUrl: normalizeQQImageUrl(skillPlaylist?.picUrl || ''),
          trackCount: Number(skillPlaylist?.totalNum || songlist.length),
          description: stripExploreMarkup(skillPlaylist?.desc || ''),
          platform: 'qq'
        }
      })
    }
    // 使用qq-music-api获取歌单详情
    const result = await fetchQQPlaylistDetail(id, Math.max(1, Math.min(Number(songNum) || 10000, 10000)))
    
    // songlist 在 result 根级别，不是在 result.data 下
    if (devMode) console.log('[QQ音乐歌单详情] API返回结果 (歌曲数):', result?.songlist?.length || 0)
    
    // 检查是否有有效数据
    if (!result || !result.songlist) {
      if (devMode) console.warn('[QQ音乐歌单详情] API返回数据无效，尝试备用方法')
      // 返回空列表而不是报错
      return res.json({
        result: 100,
        songlist: [],
        errMsg: 'QQ音乐API暂时不可用'
      })
    }
    
    const songlist = (result.songlist || []).map(song => {
      const track = song?.songInfo || song?.song || song
      return qqNormalizeSongFromTrack(track, track?.mid || track?.songmid || track?.songMid, track)
    })
    res.json({
      ...result,
      songlist,
      playlist: normalizeQQPlaylistDetail(result, id)
    })
  } catch (error) {
    console.error('[QQ音乐歌单详情] 获取错误:', error)
    // 返回空列表而不是500错误
    res.json({ 
      result: 100, 
      songlist: [],
      errMsg: error.message 
    })
  }
})

app.delete('/api/qq/cookie', (_req, res) => {
  qqMusicCookie = ''
  qqMusicApi.setCookie({})
  persistQQMusicCookie('')
  res.json({ success: true })
})

// 双平台歌曲“喜欢”。网易云使用专用 like 接口；QQ 音乐的“我喜欢”
// 本质上是 dirId=201 的系统歌单，因此复用歌单增删接口。
app.post('/api/netease/like', async (req, res) => {
  try {
    const { id, like = true, cookie } = { ...req.query, ...(req.body || {}) }
    if (!id) return res.status(400).json({ code: 400, error: '请提供歌曲 ID' })
    if (!cookie) return res.status(401).json({ code: 301, error: '需要登录网易云音乐账号' })
    if (!NeteaseAPI?.like) return res.status(500).json({ code: 500, error: 'API 未初始化' })

    const result = await NeteaseAPI.like({
      id: String(id),
      like: String(like) !== 'false',
      cookie: String(cookie)
    })
    res.status(result?.status || 200).json(result?.body || { code: 500, error: '喜欢操作失败' })
  } catch (error) {
    console.error('[网易云歌曲喜欢] 失败:', error)
    res.status(500).json({ code: 500, error: error?.message || '喜欢操作失败' })
  }
})

app.get('/api/netease/likelist', async (req, res) => {
  try {
    const { uid, cookie } = req.query
    if (!uid) return res.status(400).json({ code: 400, error: '请提供用户 ID' })
    if (!cookie) return res.status(401).json({ code: 301, error: '需要登录网易云音乐账号' })
    if (!NeteaseAPI?.likelist) return res.status(500).json({ code: 500, error: 'API 未初始化' })

    const result = await NeteaseAPI.likelist({ uid: String(uid), cookie: String(cookie) })
    res.status(result?.status || 200).json(result?.body || { code: 500, ids: [] })
  } catch (error) {
    console.error('[网易云喜欢列表] 获取失败:', error)
    res.status(500).json({ code: 500, error: error?.message || '获取喜欢列表失败', ids: [] })
  }
})

app.post('/api/qq/like', async (req, res) => {
  try {
    const { id, mid, songType, type, like = true, cookie } = { ...req.query, ...(req.body || {}) }
    if (!id && !mid) return res.status(400).json({ result: 500, error: '请提供歌曲 ID 或 MID' })
    if (!requireQQLogin(res, cookie)) return

    const shouldLike = String(like) !== 'false'
    let numericId = id && /^\d+$/.test(String(id)) ? String(id) : ''
    const songMid = mid || (!numericId ? id : '')
    const requestedSongType = songType ?? type
    let resolvedSongType = Number.isFinite(Number(requestedSongType)) ? Number(requestedSongType) : null
    console.log(`[QQ喜欢] operation=${shouldLike ? 'add' : 'remove'} id=${id || ''} mid=${songMid || ''} cookie=${Boolean(cookie)}`)
    if (songMid && (!numericId || resolvedSongType === null)) {
      // MusicU 的歌单写接口只接受数字 songId。有些探索/搜索来源只有 songmid，
      // 先通过歌曲详情补齐数字 ID 和真实 songType。
      const songDetail = await qqSongDetail(String(songMid), { mid: String(songMid) })
      if (/^\d+$/.test(String(songDetail?.id || ''))) {
        numericId = String(songDetail.id)
      }
      if (Number.isFinite(Number(songDetail?.songType))) {
        resolvedSongType = Number(songDetail.songType)
      }
    }
    if (!shouldLike && !numericId && songMid) {
      // QQ 的取消喜欢接口需要 songid；列表里的歌曲有时只有 songmid。
      const likedMap = await qqMusicApi.api('songlist/map', { dirid: '201' })
      const likedIds = Array.isArray(likedMap?.id) ? likedMap.id : []
      const likedMids = Array.isArray(likedMap?.mid) ? likedMap.mid : []
      const midIndex = likedMids.findIndex(value => String(value) === String(songMid))
      if (midIndex >= 0 && likedIds[midIndex] !== undefined) {
        numericId = String(likedIds[midIndex])
      }
    }
    if (!numericId) {
      return res.status(400).json({
        result: 500,
        error: shouldLike ? 'QQ 音乐找不到要收藏的歌曲 ID' : 'QQ 音乐找不到要取消喜欢的歌曲 ID'
      })
    }

    // 重复收藏/重复取消按幂等成功处理，避免 QQ 用业务错误码拒绝重复写入。
    if (songMid) {
      try {
        const favoriteState = await getQQSongFavoriteState(songMid, cookie)
        if (favoriteState === shouldLike) {
          return res.json({
            result: 100,
            liked: shouldLike,
            unchanged: true,
            message: shouldLike ? '歌曲已在我喜欢中' : '歌曲已不在我喜欢中'
          })
        }
      } catch (stateError) {
        console.warn('[QQ音乐歌曲喜欢] 收藏状态检查失败，继续执行写入:', stateError?.message || stateError)
      }
    }

    // 当前 QQ 网页端使用 MusicU PlaylistDetailWrite。旧目录号 201 不能直接
    // 用作写入目标，需要先解析该账号“我喜欢”条目的实际 tid。
    const favoritePlaylistId = await resolveQQFavoritePlaylistId(cookie)
    const data = await mutateQQSonglistModern({
      dirid: favoritePlaylistId,
      songId: numericId,
      songType: resolvedSongType ?? 0,
      operation: shouldLike ? 'add' : 'remove'
    }, cookie)
    if (data?.result === 500 || data?.code === 500 || data?.errMsg || data?.msg === '操作失败') {
      return res.status(500).json({
        result: 500,
        data,
        error: data.errMsg || data.error || data.msg || 'QQ 音乐喜欢操作失败'
      })
    }
    res.json({ result: 100, data, liked: shouldLike, source: 'signed-musicu' })
  } catch (error) {
    console.error('[QQ音乐歌曲喜欢] 失败:', error)
    res.status(500).json({ result: 500, error: error?.message || '喜欢操作失败' })
  }
})

// QQ account-level recent songs. This reads the platform-synced MusicU history
// and never falls back to WaveForge's local playback queue/history.
app.post('/api/qq/record/recent/report', async (req, res) => {
  try {
    const { cookie, songId, id } = req.body || {}
    const activeCookie = requireQQLogin(res, cookie)
    if (!activeCookie) return
    const normalizedSongId = String(songId ?? id ?? '').trim()
    if (!/^\d+$/.test(normalizedSongId)) {
      return res.status(400).json({ result: 400, code: 400, synced: false, error: '缺少有效的 QQ 音乐歌曲 ID' })
    }
    await reportQQRecentSong(activeCookie, normalizedSongId)
    res.setHeader('Cache-Control', 'private, no-store')
    res.json({ result: 100, code: 0, synced: true })
  } catch (error) {
    const qqCode = Number(error?.qqCode)
    console.warn('[QQ recent report] Request failed:', {
      code: Number.isFinite(qqCode) ? qqCode : undefined,
      message: error?.message || String(error)
    })
    res.status(502).json({
      result: 500,
      code: Number.isFinite(qqCode) ? qqCode : 500,
      synced: false,
      error: error?.message || 'QQ 音乐最近播放上报失败'
    })
  }
})

app.get('/api/qq/record/recent/song', async (req, res) => {
  try {
    const { cookie, limit = 100, lastTime = 0 } = req.query
    const activeCookie = requireQQLogin(res, cookie)
    if (!activeCookie) return

    const result = await fetchQQRecentSongs(activeCookie, { lastTime })
    const safeLimit = Math.max(1, Math.min(Number(limit) || 100, 500))
    const records = result.records.slice(0, safeLimit)
    res.json({
      result: 100,
      code: 0,
      source: result.source,
      type: result.type,
      updateTime: result.updateTime,
      requestCnt: result.requestCnt,
      total: result.records.length,
      songnum: records.length,
      songlist: records.map(record => record.song),
      records
    })
  } catch (error) {
    const qqCode = Number(error?.qqCode)
    const status = qqCode === 1000 || qqCode === 2000 ? 401 : 502
    console.warn('[QQ recent songs] Request failed:', {
      code: Number.isFinite(qqCode) ? qqCode : undefined,
      message: error?.message || String(error)
    })
    res.status(status).json({
      result: 500,
      code: Number.isFinite(qqCode) ? qqCode : 500,
      error: error?.message || 'QQ 音乐最近播放加载失败',
      songlist: [],
      records: []
    })
  }
})
app.get('/api/qq/likelist', async (req, res) => {
  try {
    const { cookie, playlistId } = req.query
    if (!requireQQLogin(res, cookie)) return
    const data = await qqMusicApi.api('songlist/map', { dirid: '201' })
    const ids = Array.isArray(data?.id) ? data.id : []
    const mids = Array.isArray(data?.mid) ? data.mid : []
    const firstMid = mids.find(mid => String(mid || '').trim())
    let firstSong = null
    if (playlistId) {
      try {
        firstSong = await fetchQQPlaylistFirstSong(playlistId)
      } catch (playlistError) {
        console.warn('[QQ音乐喜欢列表] 从歌单读取首曲失败:', playlistError?.message || playlistError)
      }
    }
    if (firstMid) {
      if (!firstSong?.album?.picUrl && !firstSong?.picUrl && !firstSong?.albumpic) {
        try {
          firstSong = await qqSongDetail(String(firstMid), { mid: String(firstMid) })
        } catch (detailError) {
          console.warn('[QQ音乐喜欢列表] 获取首曲详情失败:', detailError?.message || detailError)
        }
      }
    }

    res.json({
      result: 100,
      ids,
      mids,
      firstSong,
      coverImgUrl: firstSong?.album?.picUrl || firstSong?.picUrl || firstSong?.albumpic || ''
    })
  } catch (error) {
    console.error('[QQ音乐喜欢列表] 获取失败:', error)
    res.status(500).json({
      result: 500,
      error: error?.message || '获取喜欢列表失败',
      ids: [],
      mids: [],
      firstSong: null,
      coverImgUrl: ''
    })
  }
})

// QQ 音乐歌单管理。qq-music-api 的 Node 调用会直接返回 data，下面统一包装成
// 与前端其余写操作一致的 { result: 100, data } 格式。
app.post('/api/qq/playlist/create', async (req, res) => {
  try {
    const { name, cookie } = req.body || {}
    if (!name?.trim()) return res.status(400).json({ result: 500, error: '歌单名称不能为空' })
    if (!requireQQLogin(res, cookie)) return

    const data = await qqMusicApi.api('songlist/create', { name: name.trim() })
    res.json({ result: 100, data, playlist: data?.dirid ? { id: data.dirid, name: name.trim() } : undefined })
  } catch (error) {
    console.error('[QQ音乐创建歌单] 失败:', error)
    res.status(500).json({ result: 500, error: error?.message || '创建歌单失败' })
  }
})

app.post('/api/qq/playlist/delete', async (req, res) => {
  try {
    const { id, cookie } = req.body || {}
    if (!id) return res.status(400).json({ result: 500, error: '歌单 ID 不能为空' })
    if (!requireQQLogin(res, cookie)) return

    const data = await qqMusicApi.api('songlist/delete', { dirid: String(id) })
    res.json({ result: 100, data, message: '歌单已删除' })
  } catch (error) {
    console.error('[QQ音乐删除歌单] 失败:', error)
    res.status(500).json({ result: 500, error: error?.message || '删除歌单失败' })
  }
})

app.post('/api/qq/playlist/tracks', async (req, res) => {
  try {
    const { op, pid, dirid, id, tracks, mid, songType, type, cookie } = req.body || {}
    const playlistDirId = dirid || pid || id
    const trackValue = tracks || mid
    if (!playlistDirId || !trackValue || !['add', 'del'].includes(op)) {
      return res.status(400).json({ result: 500, error: '请提供有效的 op、pid 和 tracks' })
    }
    if (!requireQQLogin(res, cookie)) return

    const trackList = Array.isArray(trackValue) ? trackValue.join(',') : String(trackValue)
    const requestedSongType = songType ?? type
    let resolvedSongType = Number.isFinite(Number(requestedSongType)) ? Number(requestedSongType) : null
    const singleMid = Array.isArray(mid) ? mid[0] : String(mid || '').split(',')[0]
    if (singleMid && resolvedSongType === null) {
      const songDetail = await qqSongDetail(singleMid, { mid: singleMid })
      if (Number.isFinite(Number(songDetail?.songType))) {
        resolvedSongType = Number(songDetail.songType)
      }
    }
    const data = await mutateQQSonglistModern({
      dirid: String(playlistDirId),
      songId: trackList,
      songType: resolvedSongType ?? 0,
      operation: op === 'add' ? 'add' : 'remove'
    }, cookie)
    if (data?.result === 500 || data?.code === 500 || data?.errMsg) {
      return res.status(500).json({ result: 500, data, error: data.errMsg || data.error || '修改歌单歌曲失败' })
    }
    res.json({ result: 100, data, message: op === 'add' ? '歌曲已添加' : '歌曲已移除' })
  } catch (error) {
    console.error('[QQ音乐修改歌单歌曲] 失败:', error)
    res.status(500).json({ result: 500, error: error?.message || '修改歌单歌曲失败' })
  }
})

app.post('/api/qq/playlist/subscribe', async (req, res) => {
  try {
    const { id, subscribe = true, cookie } = req.body || {}
    if (!id) return res.status(400).json({ result: 500, error: '歌单 ID 不能为空' })
    if (!requireQQLogin(res, cookie)) return

    // 现代 MusicU 签名接口：g_tk 从 qqmusic_key/qm_keyst 计算，
    // 旧 fcg_qm_order_diss 需要 skey/p_skey，现代登录不再提供，会导致 500。
    const data = await mutateQQPlaylistConcern({ dissid: String(id), concern: subscribe === true }, cookie)
    res.json({ result: 100, data, message: subscribe ? '已收藏歌单' : '已取消收藏' })
  } catch (error) {
    console.error('[QQ音乐收藏歌单] 失败:', error)
    res.status(500).json({ result: 500, error: error?.message || '歌单收藏操作失败' })
  }
})

// 从注册表读取 Steam 安装路径
async function getSteamInstallPath() {
  if (process.platform !== 'win32') {
    return null
  }

  try {
    // 读取 Steam 安装路径
    const { stdout } = await execFileAsync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        "Get-ItemPropertyValue -Path 'HKLM:\\SOFTWARE\\WOW6432Node\\Valve\\Steam' -Name InstallPath -ErrorAction SilentlyContinue",
      ],
      { encoding: 'utf8', windowsHide: true, timeout: 5000 }
    )
    
    const steamPath = stdout.trim()
    if (steamPath && existsSync(steamPath)) {
      return steamPath
    }
  } catch (error) {
  }

  return null
}

// 通过进程查找 Wallpaper Engine 安装路径
async function getWallpaperEnginePathFromProcess() {
  if (process.platform !== 'win32') {
    return null
  }

  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        '(Get-Process wallpaper32,wallpaper64 -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Path)',
      ],
      { encoding: 'utf8', maxBuffer: 1024 * 1024, windowsHide: true, timeout: 5000 }
    )

    const processPath = stdout.trim()
    if (processPath && existsSync(processPath)) {
      const installDir = dirname(processPath)
      return installDir
    }
  } catch (error) {
  }

  return null
}

// 获取所有可能的 Wallpaper Engine 路径
// 解析结果按 customPath 做进程级缓存：每次请求 spawn 两个 PowerShell（进程查询 +
// 注册表读取）开销大，且安装路径在运行期间不会变化；仅当 ?path= 参数变更时才重算。
const WALLPAPER_ENGINE_PATH_CACHE_MAX = 20
const wallpaperEnginePathCache = new Map()

async function resolveWallpaperEnginePaths(customPath = null) {
  const paths = []

  // 1. 用户自定义路径（优先级最高）
  if (customPath) {
    paths.push(customPath)
  }

  // 2. 通过进程查找 Wallpaper Engine（最可靠的方法）
  const processInstallDir = await getWallpaperEnginePathFromProcess()
  if (processInstallDir) {
    const projectsPath = join(processInstallDir, 'projects')
    paths.push(projectsPath)
    
    // 查找 workshop 目录
    // 从 D:\SteamLibrary\steamapps\common\wallpaper_engine 推导出 D:\SteamLibrary\steamapps\workshop\content\431960
    const steamappsDir = dirname(dirname(processInstallDir))
    const workshopPath = join(steamappsDir, 'workshop', 'content', '431960')
    if (existsSync(workshopPath)) {
      paths.push(workshopPath)
    }
  }

  // 3. 从注册表读取 Steam 路径
  const steamPath = await getSteamInstallPath()
  if (steamPath) {
    const weProjectsPath = join(steamPath, 'steamapps', 'common', 'wallpaper_engine', 'projects')
    paths.push(weProjectsPath)
    
    // 也检查 workshop 目录（Steam 创意工坊下载的壁纸）
    const workshopPath = join(steamPath, 'steamapps', 'workshop', 'content', '431960')
    paths.push(workshopPath)
  }

  // 4. 默认路径（回退选项）
  const defaultPaths = [
    'C:\\Program Files (x86)\\Steam\\steamapps\\common\\wallpaper_engine\\projects',
    'D:\\Steam\\steamapps\\common\\wallpaper_engine\\projects',
    'E:\\Steam\\steamapps\\common\\wallpaper_engine\\projects',
    'F:\\Steam\\steamapps\\common\\wallpaper_engine\\projects',
  ]
  paths.push(...defaultPaths)

  return paths
}

// 带进程级缓存的路径解析入口：缓存 Promise 本身，并发请求共享同一次解析；
// 缓存键包含 customPath，?path= 变更时自然重算。
function getWallpaperEnginePaths(customPath = null) {
  const cacheKey = String(customPath || '')
  const cached = wallpaperEnginePathCache.get(cacheKey)
  if (cached) return cached
  const resultPromise = resolveWallpaperEnginePaths(customPath)
  if (wallpaperEnginePathCache.size >= WALLPAPER_ENGINE_PATH_CACHE_MAX) {
    const oldestKey = wallpaperEnginePathCache.keys().next().value
    if (oldestKey !== undefined) wallpaperEnginePathCache.delete(oldestKey)
  }
  wallpaperEnginePathCache.set(cacheKey, resultPromise)
  return resultPromise
}

// WallpaperEngine 壁纸扫描 API
app.get('/api/wallpaper-engine/scan', async (req, res) => {
  try {
    // 获取所有可能的路径
    const customPath = req.query.path
    const possiblePaths = await getWallpaperEnginePaths(customPath)
    possiblePaths.forEach((p, i) => console.log(`   ${i + 1}. ${p}`))

    // 找到所有存在的目录
    const validPaths = []
    for (const path of possiblePaths) {
      if (existsSync(path)) {
        validPaths.push(path)
      }
    }

    if (validPaths.length === 0) {
      return res.json({
        success: false,
        message: '未找到 WallpaperEngine 安装目录。请确保已安装 Wallpaper Engine 或通过 ?path= 参数指定自定义路径。',
        searchedPaths: possiblePaths,
        wallpapers: []
      })
    }

    // 扫描所有找到的目录
    const wallpapers = []
    
    for (const wallpapersPath of validPaths) {
      try {
        const entries = await readdir(wallpapersPath, { withFileTypes: true })

    for (const entry of entries) {
      if (!entry.isDirectory()) continue

      const wallpaperPath = join(wallpapersPath, entry.name)
      const projectJsonPath = join(wallpaperPath, 'project.json')

      try {
        // 模式 1: 有 project.json 的壁纸（projects 目录）
        if (existsSync(projectJsonPath)) {
          const projectData = await readFile(projectJsonPath, 'utf-8')
          const project = JSON.parse(projectData)

          // 检查壁纸类型和文件
          const type = project.type || 'unknown'
          const file = project.file || ''

          // 只添加简单的视频和图片壁纸
          if (type === 'video' || type === 'image') {
            // 验证文件是否存在
            const mediaFilePath = join(wallpaperPath, file)
            if (existsSync(mediaFilePath)) {
              // 查找预览图
              let previewPath = null
              const possiblePreviews = ['preview.jpg', 'preview.png', 'preview.gif', 'preview.webp']
              for (const preview of possiblePreviews) {
                const fullPath = join(wallpaperPath, preview)
                if (existsSync(fullPath)) {
                  previewPath = preview
                  break
                }
              }
              wallpapers.push({
                id: entry.name,
                title: project.title || entry.name,
                description: project.description || '',
                type: type,
                file: file,
                preview: previewPath ? `/api/wallpaper-engine/preview?id=${encodeURIComponent(entry.name)}&file=${encodeURIComponent(previewPath)}` : null,
                tags: project.tags || [],
                workshop: project.workshopid || null,
                path: wallpaperPath
              })
            } else {
            }
          } else {
            console.log(`   ⏭️ 跳过复杂壁纸类型: ${entry.name} (${type})`)
          }
        } else {
          // 模式 2: 直接扫描媒体文件（workshop 目录）
          const files = await readdir(wallpaperPath, { withFileTypes: true })
          
          // 查找主媒体文件
          const videoExtensions = ['.mp4', '.webm']
          const imageExtensions = ['.png', '.jpg', '.jpeg', '.webp']
          let mainFile = null
          let previewFile = null
          let mediaType = 'unknown'

          for (const file of files) {
            if (file.isDirectory()) continue
            
            const ext = extname(file.name).toLowerCase()
            const fileName = file.name.toLowerCase()

            // 查找预览图（preview.* 文件）
            if (fileName.startsWith('preview.')) {
              if (['.jpg', '.png', '.gif', '.webp'].includes(ext)) {
                previewFile = file.name
              }
              continue // 跳过预览文件，不作为主文件
            }

            // 查找主文件（优先视频，排除 preview.*）
            if (!mainFile) {
              if (videoExtensions.includes(ext)) {
                mainFile = file.name
                mediaType = 'video'
              } else if (imageExtensions.includes(ext)) {
                mainFile = file.name
                mediaType = 'image'
              }
            }
          }

          // 如果找到媒体文件，添加到结果
          if (mainFile) {
            wallpapers.push({
              id: entry.name,
              title: entry.name,
              description: '',
              type: mediaType,
              file: mainFile,
              preview: previewFile ? `/api/wallpaper-engine/preview?id=${encodeURIComponent(entry.name)}&file=${encodeURIComponent(previewFile)}` : null,
              tags: [],
              workshop: entry.name, // workshop 目录名就是 workshop ID
              path: wallpaperPath
            })
          } else {
          }
        }
      } catch (error) {
        console.error(`解析壁纸 ${entry.name} 失败:`, error.message)
      }
    }
      } catch (error) {
        console.error(`扫描目录 ${wallpapersPath} 失败:`, error.message)
      }
    }
    res.json({
      success: true,
      count: wallpapers.length,
      wallpapers: wallpapers
    })
  } catch (error) {
    console.error('扫描 WallpaperEngine 壁纸失败:', error)
    res.status(500).json({
      success: false,
      message: error.message,
      wallpapers: []
    })
  }
})

// 获取壁纸预览图
app.get('/api/wallpaper-engine/preview', async (req, res) => {
  try {
    const { id, file } = req.query
    if (!id || !file) {
      return res.status(400).send('缺少参数')
    }

    // 获取所有可能的路径
    const possiblePaths = await getWallpaperEnginePaths()

    let previewPath = null
    for (const basePath of possiblePaths) {
      const fullPath = join(basePath, id, file)
      // 路径穿越防护：规范化后必须仍位于 basePath 内，否则跳过该候选路径
      const resolved = resolve(fullPath)
      const base = resolve(basePath)
      if (!resolved.startsWith(base + sep)) continue
      if (existsSync(fullPath)) {
        previewPath = fullPath
        break
      }
    }

    if (!previewPath) {
      return res.status(404).send('预览图未找到')
    }

    // 读取并返回图片
    const imageData = await readFile(previewPath)
    const ext = file.split('.').pop().toLowerCase()
    const contentType = {
      'jpg': 'image/jpeg',
      'jpeg': 'image/jpeg',
      'png': 'image/png',
      'gif': 'image/gif',
      'webp': 'image/webp'
    }[ext] || 'image/jpeg'

    res.setHeader('Content-Type', contentType)
    res.setHeader('Cache-Control', 'public, max-age=86400')
    res.send(imageData)
  } catch (error) {
    console.error('获取预览图失败:', error)
    res.status(500).send('获取预览图失败')
  }
})

// 获取壁纸视频/媒体文件（支持 Range 请求）
app.get('/api/wallpaper-engine/media', async (req, res) => {
  try {
    const { id, file } = req.query
    if (!id || !file) {
      return res.status(400).send('缺少参数')
    }

    // 获取所有可能的路径
    const possiblePaths = await getWallpaperEnginePaths()

    let mediaPath = null
    for (const basePath of possiblePaths) {
      const fullPath = join(basePath, id, file)
      // 路径穿越防护：规范化后必须仍位于 basePath 内，否则跳过该候选路径
      const resolved = resolve(fullPath)
      const base = resolve(basePath)
      if (!resolved.startsWith(base + sep)) continue
      if (existsSync(fullPath)) {
        mediaPath = fullPath
        break
      }
    }

    if (!mediaPath) {
      return res.status(404).send('媒体文件未找到')
    }

    const fileStat = await stat(mediaPath)
    const fileSize = fileStat.size
    const range = req.headers.range

    const ext = file.split('.').pop().toLowerCase()
    const contentType = {
      'mp4': 'video/mp4',
      'webm': 'video/webm',
      'jpg': 'image/jpeg',
      'jpeg': 'image/jpeg',
      'png': 'image/png',
      'webp': 'image/webp'
    }[ext] || 'application/octet-stream'

    if (range) {
      // 支持视频流的 Range 请求
      const parts = range.replace(/bytes=/, '').split('-')
      const start = parseInt(parts[0], 10)
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1
      const chunksize = (end - start) + 1
      const fileStream = createReadStream(mediaPath, { start, end })

      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunksize,
        'Content-Type': contentType
      })

      // 读取失败（文件被占用/移动/删除）时销毁响应，避免句柄泄漏与挂起；
      // 客户端提前断开时反向销毁读取流，避免底层文件句柄残留。
      fileStream.on('error', (error) => {
        console.error('[壁纸媒体流] 读取失败:', error?.message || error)
        res.destroy()
      })
      res.on('close', () => {
        fileStream.destroy()
      })
      fileStream.pipe(res)
    } else {
      // 完整文件
      res.writeHead(200, {
        'Content-Length': fileSize,
        'Content-Type': contentType,
        'Accept-Ranges': 'bytes'
      })

      const fullStream = createReadStream(mediaPath)
      fullStream.on('error', (error) => {
        console.error('[壁纸媒体流] 读取失败:', error?.message || error)
        res.destroy()
      })
      res.on('close', () => {
        fullStream.destroy()
      })
      fullStream.pipe(res)
    }
  } catch (error) {
    console.error('获取媒体文件失败:', error)
    res.status(500).send('获取媒体文件失败')
  }
})

// 网易云音乐评论接口
app.get('/api/netease/comment/music', async (req, res) => {
  try {
    const { id, limit = 20, offset = 0, sortType = 3, cursor, type = 0, cookie } = req.query
    if (!id) {
      return res.status(400).json({ error: '请提供歌曲ID' })
    }

    if (!NeteaseAPI || !NeteaseAPI.comment_new) {
      return res.status(500).json({ error: 'API 未初始化' })
    }

    // sortType: 99=推荐排序, 2=热度排序, 3=时间排序
    const parsedSortType = parseInt(sortType)
    // 网易云评论资源类型：0=歌曲 1=MV 2=歌单 3=专辑 4=电台 5=视频 6=动态
    const VALID_COMMENT_TYPES = [0, 1, 2, 3, 4, 5, 6]
    const resourceType = VALID_COMMENT_TYPES.includes(parseInt(type)) ? parseInt(type) : 0
    const pageSize = parseInt(limit)
    const pageNo = Math.floor(parseInt(offset) / pageSize) + 1
    
    // 添加重试机制
    let lastError = null
    for (let i = 0; i < 3; i++) {
      try {
        const params = {
          id,
          type: resourceType,
          cookie,
          pageSize: pageSize,
          pageNo: pageNo,
          sortType: parsedSortType
        }
        
        // sortType=3（时间排序）需要使用cursor参数
        if (parsedSortType === 3) {
          params.cursor = cursor || '-1'
        }
        
        const result = await NeteaseAPI.comment_new(params)

        if (result && result.body) {
          const body = result.body
          // 新版 comment_new 不再返回 hotComments；首页补一次 v1 精彩评论，
          // 与网易云客户端「精彩评论」置顶区对齐（失败不影响主列表）
          try {
            const hasHot = Array.isArray(body?.data?.hotComments) && body.data.hotComments.length > 0
            if (!hasHot && pageNo === 1 && resourceType === 0 && NeteaseAPI.comment_music) {
              const legacy = await NeteaseAPI.comment_music({ id, cookie, limit: 20, offset: 0 })
              const hot = legacy?.body?.hotComments || []
              if (Array.isArray(hot) && hot.length > 0) {
                body.data = { ...(body.data || {}), hotComments: hot }
              }
            }
          } catch (hotError) {
            console.warn('[网易云评论] 精彩评论补充失败（不影响主列表）:', hotError?.message)
          }
          return res.json(body)
        }
      } catch (error) {
        lastError = error
        console.warn(`[网易云评论] 第 ${i + 1} 次尝试失败:`, error.message)
        if (i < 2) {
          await new Promise(resolve => setTimeout(resolve, 500 * (i + 1)))
        }
      }
    }

    // 新版 /api/v2/resource/comments 偶发连续 ECONNRESET；退回稳定的 v1 评论接口。
    const legacyCommentApi = resourceType === 2 ? NeteaseAPI.comment_playlist : NeteaseAPI.comment_music
    if (legacyCommentApi) {
      try {
        const parsedCursor = Number(cursor)
        const legacyResult = await legacyCommentApi({
          id,
          cookie,
          limit: pageSize,
          offset: parsedSortType === 3 ? 0 : parseInt(offset),
          before: parsedSortType === 3 && parsedCursor > 0 ? parsedCursor : 0
        })
        const legacyBody = legacyResult?.body || {}
        const legacyComments = parsedSortType === 2 && Array.isArray(legacyBody.hotComments) && legacyBody.hotComments.length > 0
          ? legacyBody.hotComments
          : (legacyBody.comments || [])
        const nextCursor = legacyComments.length > 0
          ? String(legacyComments[legacyComments.length - 1]?.time || '')
          : ''
        return res.json({
          code: 200,
          data: {
            comments: legacyComments,
            totalCount: Number(legacyBody.total || legacyComments.length),
            hasMore: parsedSortType === 2 ? false : Boolean(legacyBody.more),
            cursor: nextCursor,
            fallback: true
          }
        })
      } catch (legacyError) {
        console.warn('[网易云评论] v1 降级接口也失败:', legacyError.message)
      }
    }

    throw lastError
  } catch (error) {
    console.error('[网易云评论] 获取失败:', error)
    res.status(500).json({ error: error.message || '获取评论失败' })
  }
})

async function resolveQQCommentTopId(id, biztype) {
  const rawId = String(id || '').trim()
  if (!rawId || Number(biztype) !== 1 || /^\d+$/.test(rawId)) return rawId

  // 个别 QQ 推荐列表只携带 MID；评论接口需要数字 songid。
  const song = await qqSongDetail(rawId, { mid: rawId })
  return String(song?.id || song?.songid || rawId)
}

// QQ音乐评论接口
app.get('/api/qq/comment', async (req, res) => {
  try {
    const { id, pagenum = 0, pagesize = 20, type = 'hot', biztype = 1, cookie } = req.query
    if (!id) {
      return res.status(400).json({ error: '请提供歌曲ID' })
    }

    const pageNum = parseInt(pagenum)
    const pageSize = parseInt(pagesize)

    console.log(`[QQ音乐评论] 请求参数: id=${id}, pagenum=${pageNum}, pagesize=${pageSize}, type=${type}`)

    // qq-music-api: type=0/cmd=8 是最新评论并附带首屏 hot_comment；
    // type=1/cmd=6 是独立的热度排序，但结果仍放在 comment 字段。
    const wantsHot = type === 'hot'
    const apiType = wantsHot ? 1 : 0
    
    const topId = await resolveQQCommentTopId(id, biztype)

    // 使用qq-music-api库获取评论（读取类：请求 cookie 仅本次使用，不回写全局）
    resolveRequestCookie(cookie)
    let result = await qqMusicApi.api('comment', {
      id: topId,
      pageNo: pageNum + 1, // API从1开始计数
      pageSize: pageSize,
      type: apiType,
      biztype: Number(biztype)
    })

    let hotFallback = false
    if (wantsHot && !(result.comment?.commentlist?.length || result.hotComment?.commentlist?.length)) {
      // 少量歌曲没有官方精选集合。回退最新评论，至少不把有评论的歌曲显示成“暂无评论”。
      result = await qqMusicApi.api('comment', {
        id: topId,
        pageNo: 1,
        pageSize,
        type: 0,
        biztype: Number(biztype)
      })
      hotFallback = true
    }

    // 最新评论也附带拉取热评，合并展示（类似QQ音乐客户端）
    let attachedHotComments = []
    if (!wantsHot && pageNum === 0) {
      try {
        const hotResult = await qqMusicApi.api('comment', {
          id: topId, pageNo: 1, pageSize: 10, type: 1, biztype: Number(biztype)
        })
        attachedHotComments = hotResult?.hotComment?.commentlist || []
        // 部分歌曲没有官方精选集合：用热度排序首页充当精彩评论（与热评模式同款兜底）
        if (attachedHotComments.length === 0) attachedHotComments = (hotResult?.comment?.commentlist || []).slice(0, 10)
      } catch { /* 热评拉取失败不影响最新评论 */ }
    }

    // qq-music-api直接返回 {comment: {...}, hotComment: {...}, name: '...'}
    if (result && (result.comment || result.hotComment)) {
      let comments = []
      let hotComments = []
      let totalCount = 0
      
      if (wantsHot) {
        // 热评模式：hotComment 是精选热评，comment 是全部评论（按热度排序）
        hotComments = result.hotComment?.commentlist || []
        comments = result.comment?.commentlist || []
        totalCount = result.comment?.commenttotal || comments.length || 0
        if (hotFallback && comments.length === 0) {
          comments = [...comments].sort((left, right) => Number(right.praisenum || 0) - Number(left.praisenum || 0))
          totalCount = comments.length
        }
      } else {
        // 最新评论
        comments = result.comment?.commentlist || []
        totalCount = result.comment?.commenttotal || 0
      }
      
      // 判断是否还有更多评论（热评模式同样按总数分页，与客户端一致）
      const isHot = wantsHot
      const hasMore = (pageNum + 1) * pageSize < totalCount
      
      res.json({
        result: 0,
        data: {
          hotComments: wantsHot ? hotComments : attachedHotComments, // 精选热评（最新模式下为附带的首屏热评）
          comments: comments, // 全部评论（热评模式下是全部评论，最新模式下是分页评论）
          total: totalCount,
          hasMore: hasMore,
          isHotComplete: isHot,
          fallback: hotFallback
        }
      })
    } else {
      console.error('[QQ音乐评论] API返回错误:', result)
      res.json({
        result: -1,
        message: '获取评论失败',
        data: { comments: [], total: 0, hasMore: false, hotComments: [] }
      })
    }
  } catch (error) {
    console.error('[QQ音乐评论] 获取失败:', error)
    res.status(500).json({
      result: -1,
      error: error.message || '获取评论失败',
      data: { comments: [], total: 0, hasMore: false, hotComments: [] }
    })
  }
})

// 网易云获取评论楼层（获取评论的所有回复）
app.get('/api/netease/comment/floor', async (req, res) => {
  try {
    const { id, parentCommentId, limit = 20, time = -1, type = 0, cookie } = req.query
    if (!id || !parentCommentId) {
      return res.status(400).json({ error: '请提供歌曲ID和父评论ID' })
    }

    if (!NeteaseAPI || !NeteaseAPI.comment_floor) {
      return res.status(500).json({ error: 'API 未初始化' })
    }

    const result = await NeteaseAPI.comment_floor({
      id,
      parentCommentId,
      type: [0, 1, 2, 3, 4, 5, 6].includes(parseInt(type)) ? parseInt(type) : 0,
      cookie,
      limit: parseInt(limit),
      time: parseInt(time)
    })

    if (result && result.body) {
      return res.json(result.body)
    } else {
      return res.status(500).json({ error: '获取评论楼层失败' })
    }
  } catch (error) {
    console.error('[网易云评论楼层] 获取失败:', error)
    res.status(500).json({ error: error.message || '获取评论楼层失败' })
  }
})

// QQ音乐发布评论
app.post('/api/qq/comment/send', async (req, res) => {
  try {
    const { id, content, cookie, biztype = 1, rootCommentId, parentCommentId } = req.body
    if (!id || !content) {
      return res.status(400).json({ error: '请提供歌曲ID和评论内容' })
    }
    if (!requireQQLogin(res, cookie)) return

    const topId = await resolveQQCommentTopId(id, biztype)
    // qq-music-api 1.1.2 把 g_tk 写死为固定值，会被 QQ 返回 invalid token。
    const result = await requestQQCommentMutation({
      cookie,
      data: {
        cmd: 1,
        biztype: Number(biztype),
        topid: topId,
        content,
        ...(rootCommentId ? { rootcommentid: String(rootCommentId) } : {}),
        ...(parentCommentId ? {
          parentcommentid: String(parentCommentId),
          replycommentid: String(parentCommentId)
        } : {})
      }
    })

    res.json({
      result: 100,
      data: result
    })
  } catch (error) {
    console.error('[QQ音乐发布评论] 失败:', error)
    res.status(500).json({ 
      result: -1,
      error: error.message || '发布评论失败' 
    })
  }
})

// QQ音乐删除评论
app.post('/api/qq/comment/del', async (req, res) => {
  try {
    const { commentId, cookie } = req.body
    if (!commentId) {
      return res.status(400).json({ error: '请提供评论ID' })
    }
    if (!requireQQLogin(res, cookie)) return

    const result = await requestQQCommentMutation({
      cookie,
      data: {
        cmd: 3,
        commentid: String(commentId)
      }
    })

    res.json({
      result: 100,
      data: result
    })
  } catch (error) {
    console.error('[QQ音乐删除评论] 失败:', error)
    res.status(500).json({ 
      result: -1,
      error: error.message || '删除评论失败' 
    })
  }
})

// 网易云发布评论
app.post('/api/netease/comment/add', async (req, res) => {
  try {
    const { id, content, cookie, type = 0 } = req.body
    if (!id || !content) {
      return res.status(400).json({ error: '请提供歌曲ID和评论内容' })
    }
    if (!cookie) {
      return res.status(401).json({ error: '需要登录才能发布评论' })
    }

    if (!NeteaseAPI || !NeteaseAPI.comment) {
      return res.status(500).json({ error: 'API 未初始化' })
    }

    const result = await NeteaseAPI.comment({
      id,
      content,
      t: 1, // 1=发布评论
      type: [0, 1, 2, 3, 4, 5, 6].includes(parseInt(type)) ? parseInt(type) : 0,
      cookie
    })

    if (result && result.body) {
      return res.json(result.body)
    } else {
      return res.status(500).json({ error: '发布评论失败' })
    }
  } catch (error) {
    console.error('[网易云发布评论] 失败:', error)
    res.status(500).json({ error: error.message || '发布评论失败' })
  }
})

// 网易云回复评论
app.post('/api/netease/comment/reply', async (req, res) => {
  try {
    const { id, content, commentId, cookie, type = 0 } = req.body
    if (!id || !content || !commentId) {
      return res.status(400).json({ error: '请提供歌曲ID、评论内容和被回复的评论ID' })
    }
    if (!cookie) {
      return res.status(401).json({ error: '需要登录才能回复评论' })
    }

    if (!NeteaseAPI || !NeteaseAPI.comment) {
      return res.status(500).json({ error: 'API 未初始化' })
    }

    const result = await NeteaseAPI.comment({
      id,
      content,
      commentId,
      t: 2, // 2=回复评论
      type: [0, 1, 2, 3, 4, 5, 6].includes(parseInt(type)) ? parseInt(type) : 0,
      cookie
    })

    if (result && result.body) {
      return res.json(result.body)
    } else {
      return res.status(500).json({ error: '回复评论失败' })
    }
  } catch (error) {
    console.error('[网易云回复评论] 失败:', error)
    res.status(500).json({ error: error.message || '回复评论失败' })
  }
})

// 网易云删除评论
app.post('/api/netease/comment/delete', async (req, res) => {
  try {
    const { id, commentId, cookie, type = 0 } = req.body
    if (!id || !commentId) {
      return res.status(400).json({ error: '请提供歌曲ID和评论ID' })
    }
    if (!cookie) {
      return res.status(401).json({ error: '需要登录才能删除评论' })
    }

    if (!NeteaseAPI || !NeteaseAPI.comment) {
      return res.status(500).json({ error: 'API 未初始化' })
    }

    const result = await NeteaseAPI.comment({
      id,
      commentId,
      t: 0, // 0=删除评论
      type: [0, 1, 2, 3, 4, 5, 6].includes(parseInt(type)) ? parseInt(type) : 0,
      cookie
    })

    if (result && result.body) {
      return res.json(result.body)
    } else {
      return res.status(500).json({ error: '删除评论失败' })
    }
  } catch (error) {
    console.error('[网易云删除评论] 失败:', error)
    res.status(500).json({ error: error.message || '删除评论失败' })
  }
})

// 网易云点赞评论
app.post('/api/netease/comment/like', async (req, res) => {
  try {
    const { id, commentId, like, cookie, type = 0 } = req.body
    if (!id || !commentId) {
      return res.status(400).json({ error: '请提供歌曲ID和评论ID' })
    }
    if (!cookie) {
      return res.status(401).json({ error: '需要登录才能点赞评论' })
    }

    if (!NeteaseAPI || !NeteaseAPI.comment_like) {
      return res.status(500).json({ error: 'API 未初始化' })
    }

    const result = await NeteaseAPI.comment_like({
      id,
      cid: commentId,
      t: like ? 1 : 0, // 1=点赞, 0=取消点赞
      type: [0, 1, 2, 3, 4, 5, 6].includes(parseInt(type)) ? parseInt(type) : 0,
      cookie
    })

    if (result && result.body) {
      return res.json(result.body)
    } else {
      return res.status(500).json({ error: '点赞操作失败' })
    }
  } catch (error) {
    console.error('[网易云点赞评论] 失败:', error)
    res.status(500).json({ error: error.message || '点赞操作失败' })
  }
})

// QQ音乐点赞评论
app.post('/api/qq/comment/like', async (req, res) => {
  try {
    const { commentId, like, cookie } = req.body
    if (!commentId) {
      return res.status(400).json({ error: '请提供评论ID' })
    }
    if (!requireQQLogin(res, cookie)) return

    // qq-music-api 的 comment/like 使用 QQ 音乐实际的评论点赞接口。
    // type=1 点赞，type=2 取消点赞。
    const result = await requestQQCommentMutation({
      cookie,
      endpoint: 'praise',
      data: {
        cmd: like ? 1 : 2,
        commentid: String(commentId)
      }
    })
    res.json({ result: 100, data: result })
  } catch (error) {
    console.error('[QQ音乐点赞评论] 失败:', error)
    res.status(500).json({ error: error.message || '点赞操作失败' })
  }
})

// ═══════════════════════════════════════════════════════════════
// API 功能补全 — 第一批：搜索热词/联想 + 专辑收藏 + 热门评论
// ═══════════════════════════════════════════════════════════════

// 网易云搜索热词
app.get('/api/netease/search/hot', async (req, res) => {
  try {
    if (!NeteaseAPI || !NeteaseAPI.search_hot) {
      return res.status(500).json({ error: 'API 未初始化' })
    }
    const result = await callNeteaseAPIWithRetry(NeteaseAPI.search_hot, {}, 2, 10000)
    const body = result.body || result
    res.json(body)
  } catch (error) {
    console.error('[网易云搜索热词] 获取失败:', error)
    res.status(502).json({ error: error.message || '获取搜索热词失败' })
  }
})

// QQ 搜索热词
app.get('/api/qq/search/hot', async (req, res) => {
  try {
    const result = await qqMusicApi.api('search/hot')
    res.json({ result: 100, data: result })
  } catch (error) {
    console.error('[QQ搜索热词] 获取失败:', error)
    res.status(502).json({ error: error.message || '获取搜索热词失败' })
  }
})

// QQ 搜索快速联想
app.get('/api/qq/search/quick', async (req, res) => {
  try {
    const { keywords } = req.query
    if (!keywords) return res.status(400).json({ error: '请提供搜索关键词' })
    const result = await qqMusicApi.api('search/quick', { keyword: keywords })
    res.json({ result: 100, data: result })
  } catch (error) {
    console.error('[QQ搜索联想] 获取失败:', error)
    res.status(502).json({ error: error.message || '获取搜索联想失败' })
  }
})

// 网易云收藏专辑
app.post('/api/netease/album/subscribe', async (req, res) => {
  try {
    const { id, t = 1, cookie } = { ...req.query, ...(req.body || {}) }
    if (!id) return res.status(400).json({ code: 400, error: '请提供专辑ID' })
    if (!cookie) return res.status(401).json({ code: 301, error: '请先登录网易云音乐' })
    if (!NeteaseAPI || !NeteaseAPI.album_sub) {
      return res.status(500).json({ code: 500, error: 'API 未初始化' })
    }
    const result = await callNeteaseAPIWithRetry(NeteaseAPI.album_sub, {
      id: String(id), t: Number(t) === 2 ? 2 : 1, cookie: String(cookie)
    })
    const body = result.body || result
    res.json(body)
  } catch (error) {
    console.error('[网易云收藏专辑] 失败:', error)
    res.status(502).json({ code: 502, error: error.message || '收藏专辑失败' })
  }
})

// 网易云已收藏专辑列表
app.get('/api/netease/album/sublist', async (req, res) => {
  try {
    const { cookie, limit = 50, offset = 0 } = req.query
    if (!cookie) return res.status(401).json({ code: 301, error: '请先登录网易云音乐' })
    if (!NeteaseAPI || !NeteaseAPI.album_sublist) {
      return res.status(500).json({ code: 500, error: 'API 未初始化' })
    }
    // 需要判断"是否已收藏某专辑"时一次拉全量（最多 1000），避免 25 条截断
    const result = await callNeteaseAPIWithRetry(NeteaseAPI.album_sublist, {
      limit: Math.max(Number(limit), 1000), offset: Number(offset), cookie: String(cookie)
    })
    const body = result.body || result
    res.json(body)
  } catch (error) {
    console.error('[网易云收藏专辑列表] 获取失败:', error)
    res.status(502).json({ code: 502, error: error.message || '获取收藏专辑列表失败' })
  }
})

// QQ 收藏专辑（使用 qq-music-api 的 user/collect/album）
app.post('/api/qq/album/subscribe', async (req, res) => {
  try {
    const { id, subscribe = true, cookie } = { ...req.query, ...(req.body || {}) }
    if (!id) return res.status(400).json({ result: 500, error: '请提供专辑ID' })
    if (!requireQQLogin(res, cookie)) return
    // qq-music-api 的 user/collect/album 接口：op=1 收藏, op=2 取消
    const result = await qqMusicApi.api('user/collect/album', {
      id: String(id), op: subscribe === true || subscribe === 'true' ? '1' : '2'
    })
    res.json({ result: 100, data: result, message: subscribe ? '已收藏专辑' : '已取消收藏' })
  } catch (error) {
    console.error('[QQ收藏专辑] 失败:', error)
    res.status(502).json({ result: 500, error: error.message || '收藏专辑失败' })
  }
})

// 网易云热门评论
app.get('/api/netease/comment/hot', async (req, res) => {
  try {
    const { id, type = 0, limit = 20, cookie } = req.query
    if (!id) return res.status(400).json({ error: '请提供资源ID' })
    if (!NeteaseAPI || !NeteaseAPI.comment_hot) {
      return res.status(500).json({ error: 'API 未初始化' })
    }
    const result = await callNeteaseAPIWithRetry(NeteaseAPI.comment_hot, {
      id, type: Number(type) || 0, limit: Number(limit) || 20, cookie: String(cookie || '')
    })
    const body = result.body || result
    res.json(body)
  } catch (error) {
    console.error('[网易云热门评论] 获取失败:', error)
    res.status(502).json({ error: error.message || '获取热门评论失败' })
  }
})

// ═══════════════════════════════════════════════════════════════
// 第二批：相似歌曲/歌手 + 歌手关注/取关 + 歌单编辑增强
// ═══════════════════════════════════════════════════════════════

// 网易云相似歌曲
app.get('/api/netease/song/similar', async (req, res) => {
  try {
    const { id, cookie } = req.query
    if (!id) return res.status(400).json({ error: '请提供歌曲ID' })
    if (!NeteaseAPI || !NeteaseAPI.simi_song) {
      return res.status(500).json({ error: 'API 未初始化' })
    }
    const result = await callNeteaseAPIWithRetry(NeteaseAPI.simi_song, {
      id: String(id), cookie: String(cookie || '')
    })
    const body = result.body || result
    res.json(body)
  } catch (error) {
    console.error('[网易云相似歌曲] 获取失败:', error)
    res.status(502).json({ error: error.message || '获取相似歌曲失败' })
  }
})

// QQ 相似歌曲
app.get('/api/qq/song/similar', async (req, res) => {
  try {
    const { id, mid } = req.query
    const songId = String(id || mid || '')
    if (!songId) return res.status(400).json({ error: '请提供歌曲ID' })
    console.log('[QQ相似歌曲] 请求参数:', { id, mid, songId })
    const result = await qqMusicApi.api('song/similar', { id: songId })
    console.log('[QQ相似歌曲] 返回结果:', JSON.stringify(result).slice(0, 500))
    res.json({ result: 100, data: result })
  } catch (error) {
    console.error('[QQ相似歌曲] 获取失败:', error)
    res.status(502).json({ error: error.message || '获取相似歌曲失败' })
  }
})

// 网易云相似歌手
app.get('/api/netease/artist/similar', async (req, res) => {
  try {
    const { id, cookie } = req.query
    if (!id) return res.status(400).json({ error: '请提供歌手ID' })
    if (!NeteaseAPI || !NeteaseAPI.simi_artist) {
      return res.status(500).json({ error: 'API 未初始化' })
    }
    const result = await callNeteaseAPIWithRetry(NeteaseAPI.simi_artist, {
      id: String(id), cookie: String(cookie || '')
    })
    const body = result.body || result
    res.json(body)
  } catch (error) {
    console.error('[网易云相似歌手] 获取失败:', error)
    res.status(502).json({ error: error.message || '获取相似歌手失败' })
  }
})

// QQ 相似歌手
app.get('/api/qq/artist/similar', async (req, res) => {
  try {
    const { mid } = req.query
    if (!mid) return res.status(400).json({ error: '请提供歌手MID' })
    const result = await qqMusicApi.api('singer/sim', { singermid: mid })
    res.json({ result: 100, data: result })
  } catch (error) {
    console.error('[QQ相似歌手] 获取失败:', error)
    res.status(502).json({ error: error.message || '获取相似歌手失败' })
  }
})

// 网易云关注/取关歌手
app.post('/api/netease/artist/subscribe', async (req, res) => {
  try {
    const { id, t = 1, cookie } = { ...req.query, ...(req.body || {}) }
    if (!id) return res.status(400).json({ code: 400, error: '请提供歌手ID' })
    if (!cookie) return res.status(401).json({ code: 301, error: '请先登录网易云音乐' })
    if (!NeteaseAPI || !NeteaseAPI.artist_sub) {
      return res.status(500).json({ code: 500, error: 'API 未初始化' })
    }
    const result = await callNeteaseAPIWithRetry(NeteaseAPI.artist_sub, {
      id: String(id), t: Number(t) === 2 ? 2 : 1, cookie: String(cookie)
    })
    const body = result.body || result
    res.json(body)
  } catch (error) {
    console.error('[网易云关注歌手] 失败:', error)
    res.status(502).json({ code: 502, error: error.message || '关注歌手失败' })
  }
})

// 网易云已关注歌手列表
app.get('/api/netease/artist/sublist', async (req, res) => {
  try {
    const { cookie, limit = 50, offset = 0 } = req.query
    if (!cookie) return res.status(401).json({ code: 301, error: '请先登录网易云音乐' })
    if (!NeteaseAPI || !NeteaseAPI.artist_sublist) {
      return res.status(500).json({ code: 500, error: 'API 未初始化' })
    }
    // 需要判断"是否已关注某个歌手"时一次拉全量（最多 1000），避免 25 条截断
    const result = await callNeteaseAPIWithRetry(NeteaseAPI.artist_sublist, {
      limit: Math.max(Number(limit), 1000), offset: Number(offset), cookie: String(cookie)
    })
    const body = result.body || result
    res.json(body)
  } catch (error) {
    console.error('[网易云关注歌手列表] 获取失败:', error)
    res.status(502).json({ code: 502, error: error.message || '获取关注歌手列表失败' })
  }
})

// QQ 关注/取关歌手
app.post('/api/qq/artist/subscribe', async (req, res) => {
  try {
    const { mid, subscribe = true, cookie } = { ...req.query, ...(req.body || {}) }
    if (!mid) return res.status(400).json({ result: 500, error: '请提供歌手MID' })
    if (!requireQQLogin(res, cookie)) return

    // 写操作只按本次请求使用请求自带的 cookie（优先）；请求未带时回退全局登录态，
    // 绝不回写全局，避免并发请求互相冲掉登录态。
    const activeCookie = cookie || qqMusicCookie
    const parsedCookie = parseQQCookie(activeCookie)
    const musicId = String(parsedCookie.uin || parsedCookie.qqmusic_uin || '').replace(/\D/g, '')
    const musicKey = parsedCookie.qm_keyst || parsedCookie.qqmusic_key || ''

    // 尝试 MusicU 方式（现代 TME 登录适用）
    // 网页版关注实现（singer.chunk 逆向）：ConcernSystemServer/cgi_concern_user_v2，
    // param: { opertype, source: 0, userinfo: { usertype: 1, userid: <singer_mid> }, encrypt_singerid: 1 }
    // opertype: 1=关注, 0=取关（注意不是 2）
    if (musicKey) {
      const followOpertype = subscribe === true || subscribe === 'true' ? 1 : 0
      const musicuAttempts = [
        { module: 'Concern.ConcernSystemServer', method: 'cgi_concern_user_v2', param: { opertype: followOpertype, source: 0, userinfo: { usertype: 1, userid: String(mid) }, encrypt_singerid: 1 } },
      ]
      // 尝试 unsigned MusicU（不签名+不加密）
      try {
        const unsigPayload = {
          comm: { ct: 24, cv: 4747474, platform: 'yqq.json', uin: musicId, qq: musicId, authst: musicKey,
            tmeLoginType: Number(parsedCookie.login_type) || undefined,
            g_tk: qqHash33(musicKey), format: 'json', inCharset: 'utf-8', outCharset: 'utf-8', notice: 0, need_new_code: 1 },
          req_0: musicuAttempts[0]
        }
        const unsigResp = await axios.post('https://u.y.qq.com/cgi-bin/musicu.fcg', unsigPayload, {
          headers: { ...QQ_HEADERS, Cookie: activeCookie, 'Content-Type': 'application/json' },
          timeout: 15000,
          validateStatus: () => true
        })
        const unsigCode = Number(unsigResp.data?.req_0?.code ?? unsigResp.data?.code)
        console.log('[QQ关注歌手] unsigned MusicU → code', unsigCode)
        if (unsigCode === 0) {
          return res.json({ result: 100, data: unsigResp.data, message: subscribe ? '已关注歌手' : '已取消关注', source: 'musicu-unsigned' })
        }
      } catch (uError) { console.log('[QQ关注歌手] unsigned MusicU 异常:', uError?.message || uError) }
      for (const attempt of musicuAttempts) {
        try {
          const payload = {
            comm: {
              ct: 24, cv: 4747474, platform: 'yqq.json',
              uin: musicId, qq: musicId, authst: musicKey,
              tmeLoginType: Number(parsedCookie.login_type) || undefined,
              g_tk: qqHash33(musicKey), g_tk_new_20200303: qqHash33(musicKey),
              format: 'json', inCharset: 'utf-8', outCharset: 'utf-8', notice: 0, need_new_code: 1
            },
            req_0: attempt
          }
          const requestBody = JSON.stringify(payload)
          const encryptedBody = await encodeAG1Request(requestBody)
          const sign = zzcSign(requestBody)
          const signedUrl = `https://u6.y.qq.com/cgi-bin/musics.fcg?_=${Date.now()}&encoding=ag-1&sign=${encodeURIComponent(sign)}`
          const musicuResponse = await axios.post(signedUrl, encryptedBody, {
            headers: { ...QQ_HEADERS, Cookie: activeCookie, 'Content-Type': 'text/plain' },
            responseType: 'arraybuffer', transformResponse: data => data, timeout: 15000, validateStatus: () => true
          })
          const musicuData = JSON.parse(decodeAG1Response(new Uint8Array(musicuResponse.data)))
          const code = Number(musicuData?.req_0?.code ?? musicuData?.code)
          console.log(`[QQ关注歌手] MusicU ${attempt.module}/${attempt.method} → code ${code}`)
          if (code === 0) {
            return res.json({ result: 100, data: musicuData, message: subscribe ? '已关注歌手' : '已取消关注', source: 'musicu' })
          }
        } catch (muError) {
          console.log(`[QQ关注歌手] MusicU ${attempt.module}/${attempt.method} 异常:`, muError?.message || muError)
        }
      }
    }

    // 兜底：旧版 fcg 接口
    const token = parsedCookie.skey || parsedCookie.p_skey || musicKey
    const gTk = qqHash33(token)
    const operation = subscribe === true || subscribe === 'true' ? 1 : 2
    const url = operation === 1
      ? 'https://c.y.qq.com/rsc/fcgi-bin/fcg_order_singer_add.fcg'
      : 'https://c.y.qq.com/rsc/fcgi-bin/fcg_order_singer_del.fcg'

    const response = await axios.get(url, {
      params: {
        g_tk: gTk, loginUin: musicId, format: 'json',
        inCharset: 'utf8', outCharset: 'utf-8', notice: 0,
        platform: 'yqq.json', needNewCode: 1, ct: 24, cv: 4747474,
        singermid: String(mid), uin: musicId
      },
      headers: { ...QQ_HEADERS, Cookie: activeCookie, Referer: 'https://y.qq.com/' },
      timeout: 15000,
      validateStatus: () => true
    })

    const result = response.data
    console.log('[QQ关注歌手] 旧接口响应:', JSON.stringify(result).slice(0, 300))

    if (Number(result.code) === 0) {
      return res.json({ result: 100, data: result, message: subscribe ? '已关注歌手' : '已取消关注' })
    } else if (Number(result.code) === 1000) {
      return res.status(502).json({ result: 500, error: 'QQ 登录凭证已过期，请重新登录' })
    } else {
      return res.status(502).json({
        result: 500, error: result.msg || `关注歌手失败（代码 ${result.code}）`,
        detail: 'QQ 关注歌手接口仅支持部分登录方式，请尝试使用网易云音乐关注歌手'
      })
    }
  } catch (error) {
    console.error('[QQ关注歌手] 失败:', error?.message || error)
    res.status(502).json({ result: 500, error: error?.message || '关注歌手失败' })
  }
})

// QQ 已关注歌手列表
app.get('/api/qq/artist/sublist', async (req, res) => {
  try {
    if (!requireQQLogin(res, req.query.cookie)) return
    const result = await qqMusicApi.api('user/follow/singers')
    res.json({ result: 100, data: result })
  } catch (error) {
    console.error('[QQ关注歌手列表] 获取失败:', error)
    res.status(502).json({ result: 500, error: error.message || '获取关注歌手列表失败' })
  }
})

// QQ 关注/粉丝列表（music.concern.RelationList，qm_keyst 现代登录可用）
async function callQQRelationList(method, start, num, cookie) {
  const parsedCookie = parseQQCookie(cookie)
  const musicId = String(parsedCookie.uin || parsedCookie.qqmusic_uin || '').replace(/\D/g, '')
  const musicKey = parsedCookie.qm_keyst || parsedCookie.qqmusic_key || ''
  if (!musicId || !musicKey) throw new Error('QQ 登录凭证缺少 uin 或 qm_keyst，请重新登录')

  const payload = {
    comm: {
      ct: 24, cv: 4747474, platform: 'yqq.json', uin: musicId, qq: musicId,
      authst: musicKey,
      tmeLoginType: Number(parsedCookie.tmeLoginType) || Number(parsedCookie.login_type) || undefined,
      g_tk: qqHash33(musicKey), format: 'json', inCharset: 'utf-8', outCharset: 'utf-8',
      notice: 0, need_new_code: 1
    },
    req_0: { module: 'music.concern.RelationList', method, param: { From: Number(start) || 0, Size: Number(num) || 20, HostUin: '' } }
  }
  const resp = await axios.post('https://u.y.qq.com/cgi-bin/musicu.fcg', payload, {
    headers: { ...QQ_HEADERS, Cookie: cookie, 'Content-Type': 'application/json' },
    timeout: 15000,
    validateStatus: () => true
  })
  return resp.data?.req_0 || resp.data
}

// QQ 关注用户列表
app.get('/api/qq/user/follows', async (req, res) => {
  try {
    const { start = 0, num = 20, cookie } = req.query
    if (!requireQQLogin(res, cookie)) return
    const result = await callQQRelationList('GetFollowList', Number(start), Number(num), cookie)
    if (Number(result.code) === 0) {
      res.json({ result: 100, data: { list: result.data?.List || [], hasMore: Boolean(result.data?.HasMore) } })
    } else {
      res.status(502).json({ result: 500, error: `获取关注列表失败（代码 ${result.code}）` })
    }
  } catch (error) {
    console.error('[QQ关注列表] 获取失败:', error)
    res.status(502).json({ result: 500, error: error?.message || '获取关注列表失败' })
  }
})

// QQ 粉丝列表
app.get('/api/qq/user/fans', async (req, res) => {
  try {
    const { start = 0, num = 20, cookie } = req.query
    if (!requireQQLogin(res, cookie)) return
    const result = await callQQRelationList('GetFansList', Number(start), Number(num), cookie)
    if (Number(result.code) === 0) {
      res.json({ result: 100, data: { list: result.data?.List || [], hasMore: Boolean(result.data?.HasMore) } })
    } else {
      res.status(502).json({ result: 500, error: `获取粉丝列表失败（代码 ${result.code}）` })
    }
  } catch (error) {
    console.error('[QQ粉丝列表] 获取失败:', error)
    res.status(502).json({ result: 500, error: error?.message || '获取粉丝列表失败' })
  }
})

// QQ 关注/取关用户（按 EncUin，usertype=0；opertype 1=关注 0=取关）
app.post('/api/qq/user/subscribe', async (req, res) => {
  try {
    const { encUin, subscribe = true, cookie } = { ...req.query, ...(req.body || {}) }
    if (!encUin) return res.status(400).json({ result: 500, error: '请提供用户 EncUin' })
    if (!requireQQLogin(res, cookie)) return

    const parsedCookie = parseQQCookie(cookie)
    const musicId = String(parsedCookie.uin || '').replace(/\D/g, '')
    const musicKey = parsedCookie.qm_keyst || parsedCookie.qqmusic_key || ''
    if (!musicId || !musicKey) throw new Error('QQ 登录凭证缺少 uin 或 qm_keyst，请重新登录')
    const followOpertype = subscribe === true || subscribe === 'true' ? 1 : 0
    const payload = {
      comm: {
        ct: 24, cv: 4747474, platform: 'yqq.json', uin: musicId, qq: musicId,
        authst: musicKey,
        tmeLoginType: Number(parsedCookie.tmeLoginType) || Number(parsedCookie.login_type) || undefined,
        g_tk: qqHash33(musicKey), format: 'json', inCharset: 'utf-8', outCharset: 'utf-8',
        notice: 0, need_new_code: 1
      },
      req_0: { module: 'Concern.ConcernSystemServer', method: 'cgi_concern_user_v2', param: { opertype: followOpertype, source: 0, userinfo: { usertype: 0, userid: String(encUin) } } }
    }
    const resp = await axios.post('https://u.y.qq.com/cgi-bin/musicu.fcg', payload, {
      headers: { ...QQ_HEADERS, Cookie: cookie, 'Content-Type': 'application/json' },
      timeout: 15000,
      validateStatus: () => true
    })
    const code = Number(resp.data?.req_0?.code ?? resp.data?.code)
    if (code === 0) {
      res.json({ result: 100, message: subscribe === true || subscribe === 'true' ? '已关注用户' : '已取消关注' })
    } else {
      res.status(502).json({ result: 500, error: `关注操作失败（代码 ${code}）` })
    }
  } catch (error) {
    console.error('[QQ关注用户] 失败:', error?.message || error)
    res.status(502).json({ result: 500, error: error?.message || '关注用户失败' })
  }
})

// QQ 收藏专辑列表（自己，user/collect/album）
app.get('/api/qq/album/sublist', async (req, res) => {
  try {
    const { cookie } = req.query
    if (!requireQQLogin(res, cookie)) return
    const parsedCookie = parseQQCookie(cookie)
    const musicId = String(parsedCookie.uin || parsedCookie.qqmusic_uin || '').replace(/\D/g, '')
    if (!musicId) throw new Error('缺少 uin')
    // 判断"是否已收藏某专辑"时需要全量，分页拉取最多 500 条
    const all = []
    for (let page = 1; page <= 10; page++) {
      const result = await qqMusicApi.api('user/collect/album', { id: musicId, pageNo: page, pageSize: 50 })
      const list = result?.list || []
      all.push(...list)
      if (list.length < 50) break
    }
    res.json({ result: 100, data: { list: all } })
  } catch (error) {
    console.error('[QQ收藏专辑列表] 获取失败:', error?.message || error)
    res.status(502).json({ result: 500, error: error?.message || '获取收藏专辑列表失败' })
  }
})

// QQ 关注歌手列表（RelationList GetFollowList 过滤歌手；fcg 老接口需 skey 不可用）
app.get('/api/qq/artist/sublist2', async (req, res) => {
  try {
    const { cookie } = req.query
    if (!requireQQLogin(res, cookie)) return
    // RelationList 单次最多约 100 条，分页拉取 500 个关注项再过滤歌手
    const all = []
    for (let start = 0; start < 500; start += 100) {
      const result = await callQQRelationList('GetFollowList', start, 100, cookie)
      const list = result?.data?.List || []
      all.push(...list)
      if (!result?.data?.HasMore || list.length < 100) break
    }
    const singers = all.filter((item) => item.MID).map((item) => ({
      id: item.MID,
      mid: item.MID,
      name: item.Name || '',
      picUrl: item.AvatarUrl || '',
    }))
    res.json({ result: 100, data: { list: singers } })
  } catch (error) {
    console.error('[QQ关注歌手列表] 获取失败:', error?.message || error)
    res.status(502).json({ result: 500, error: error?.message || '获取关注歌手列表失败' })
  }
})

// QQ 用户我喜欢列表（music.favor_system_read/get_favor_list_byid，EncUin 支持查看他人）
app.get('/api/qq/user/favs', async (req, res) => {
  try {
    const { encUin, favType = 1, cookie } = req.query
    if (!encUin) return res.status(400).json({ result: 500, error: '请提供用户 EncUin' })
    if (!requireQQLogin(res, cookie)) return

    const parsedCookie = parseQQCookie(cookie)
    const musicId = String(parsedCookie.uin || '').replace(/\D/g, '')
    const musicKey = parsedCookie.qm_keyst || parsedCookie.qqmusic_key || ''
    if (!musicId || !musicKey) throw new Error('QQ 登录凭证缺少 uin 或 qm_keyst，请重新登录')
    const payload = {
      comm: {
        ct: 24, cv: 4747474, platform: 'yqq.json', uin: musicId, qq: musicId,
        authst: musicKey,
        tmeLoginType: Number(parsedCookie.tmeLoginType) || Number(parsedCookie.login_type) || undefined,
        g_tk: qqHash33(musicKey), format: 'json', inCharset: 'utf-8', outCharset: 'utf-8',
        notice: 0, need_new_code: 1
      },
      req_0: { module: 'music.favor_system_read', method: 'get_favor_list_byid', param: { userid: String(encUin), fav_type: Number(favType) || 1 } }
    }
    const resp = await axios.post('https://u.y.qq.com/cgi-bin/musicu.fcg', payload, {
      headers: { ...QQ_HEADERS, Cookie: cookie, 'Content-Type': 'application/json' },
      timeout: 15000,
      validateStatus: () => true
    })
    const d = resp.data?.req_0 || resp.data
    if (Number(d.code) === 0) {
      res.json({ result: 100, data: { list: d.data?.vec_favor || [], favType: Number(favType) } })
    } else {
      res.status(502).json({ result: 500, error: `获取我喜欢失败（代码 ${d.code}）` })
    }
  } catch (error) {
    console.error('[QQ我喜欢] 获取失败:', error?.message || error)
    res.status(502).json({ result: 500, error: error?.message || '获取我喜欢失败' })
  }
})

// QQ 用户主页（按 EncUin 查资料/关注/粉丝数 + 关注/粉丝列表，支持查看他人）
app.get('/api/qq/user/profile', async (req, res) => {
  try {
    const { encUin, cookie } = req.query
    if (!encUin) return res.status(400).json({ result: 500, error: '请提供用户 EncUin' })
    if (!requireQQLogin(res, cookie)) return

    const parsedCookie = parseQQCookie(cookie)
    const musicId = String(parsedCookie.uin || '').replace(/\D/g, '')
    const musicKey = parsedCookie.qm_keyst || parsedCookie.qqmusic_key || ''
    if (!musicId || !musicKey) throw new Error('QQ 登录凭证缺少 uin 或 qm_keyst，请重新登录')
    // 每次进入用户主页需 3 次上游请求，按 EncUin + 登录账号缓存（防止跨账号数据互串）
    const cacheKey = recommendCacheKeyWithCookie('qq:user-profile', encUin, cookie)
    const cached = getRecommendCache(cacheKey)
    if (cached) return res.json(cached)
    const comm = {
      ct: 24, cv: 4747474, platform: 'yqq.json', uin: musicId, qq: musicId,
      authst: musicKey,
      tmeLoginType: Number(parsedCookie.tmeLoginType) || Number(parsedCookie.login_type) || undefined,
      g_tk: qqHash33(musicKey), format: 'json', inCharset: 'utf-8', outCharset: 'utf-8',
      notice: 0, need_new_code: 1
    }

    const call = async (req0) => {
      const resp = await axios.post('https://u.y.qq.com/cgi-bin/musicu.fcg', { comm, req_0: req0 }, {
        headers: { ...QQ_HEADERS, Cookie: cookie, 'Content-Type': 'application/json' },
        timeout: 15000,
        validateStatus: () => true
      })
      return resp.data?.req_0 || resp.data
    }

    // 关注/粉丝数（usertype=0 用户）
    const numResult = await call({ module: 'Concern.ConcernSystemServer', method: 'cgi_qry_concern_num', param: { vec_userinfo: [{ userid: encUin, usertype: 0 }] } })
    const numMap = numResult?.data?.map_user_num?.[encUin] || {}
    // 关注列表（他人）
    const followResult = await call({ module: 'music.concern.RelationList', method: 'GetFollowList', param: { From: 0, Size: 30, HostUin: encUin } })
    // 粉丝列表（他人）
    const fansResult = await call({ module: 'music.concern.RelationList', method: 'GetFansList', param: { From: 0, Size: 30, HostUin: encUin } })

    const payload = {
      result: 100,
      data: {
        encUin,
        followNum: numMap.user_follownum || 0,
        fansNum: numMap.user_fansnum || 0,
        follows: followResult?.data?.List || [],
        fans: fansResult?.data?.List || [],
      }
    }
    setRecommendCache(cacheKey, payload)
    res.json(payload)
  } catch (error) {
    console.error('[QQ用户主页] 获取失败:', error)
    res.status(502).json({ result: 500, error: error?.message || '获取用户主页失败' })
  }
})

// ═══════════════════════════════════════════════════════════════
// 补充：Banner/歌单分类/热门歌单/相似歌单/榜单/歌手分类（双平台）
// ═══════════════════════════════════════════════════════════════

// 歌曲详情侧栏/推荐类接口的进程级缓存：这些接口随每次打开歌曲详情弹窗被调用，
// 数据本身短期稳定（相似歌曲/相关歌单/歌曲百科/所在歌单），缓存 Map + TTL + 上限
// 防泄漏，参考既有 qqPlaybackMetadataCache / neteaseSongDetailCache 模式。
const RECOMMEND_CACHE_MAX = 300
const RECOMMEND_CACHE_TTL = 10 * 60 * 1000
const recommendCache = new Map()

function getRecommendCache(key) {
  const cached = recommendCache.get(key)
  if (!cached) return null
  if (cached.expiresAt <= Date.now()) {
    recommendCache.delete(key)
    return null
  }
  // 简单 LRU：命中移到末尾，淘汰时删除最久未用的条目
  recommendCache.delete(key)
  recommendCache.set(key, cached)
  return cached.value
}

function setRecommendCache(key, value) {
  if (!key || value === undefined || value === null) return
  recommendCache.set(key, { value, expiresAt: Date.now() + RECOMMEND_CACHE_TTL })
  while (recommendCache.size > RECOMMEND_CACHE_MAX) {
    const oldestKey = recommendCache.keys().next().value
    if (oldestKey === undefined) break
    recommendCache.delete(oldestKey)
  }
}

// 登录态相关的缓存键叠加 cookie 短哈希，避免不同账号数据互串
function recommendCacheKeyWithCookie(prefix, id, cookie) {
  let hash = 7
  const cookieStr = String(cookie || '')
  for (let i = 0; i < cookieStr.length; i++) {
    hash = (hash * 31 + cookieStr.charCodeAt(i)) | 0
  }
  return `${prefix}:${String(id)}:${hash}`
}


// 网易云首页 Banner
app.get('/api/netease/banner', async (req, res) => {
  try {
    if (!NeteaseAPI || !NeteaseAPI.banner) return res.status(500).json({ error: 'API 未初始化' })
    const cacheKey = 'ne:banner'
    const cached = getRecommendCache(cacheKey)
    if (cached) return res.json(cached)
    const result = await callNeteaseAPIWithRetry(NeteaseAPI.banner, { type: 2 })
    const body = result.body || result
    const payload = { banners: Array.isArray(body.banners) ? body.banners : [] }
    setRecommendCache(cacheKey, payload)
    res.json(payload)
  } catch (error) {
    console.error('[网易云Banner] 获取失败:', error)
    res.status(502).json({ error: error.message })
  }
})

// 网易云歌单分类
app.get('/api/netease/playlist/catlist', async (req, res) => {
  try {
    if (!NeteaseAPI || !NeteaseAPI.playlist_catlist) return res.status(500).json({ error: 'API 未初始化' })
    const result = await callNeteaseAPIWithRetry(NeteaseAPI.playlist_catlist, {})
    const body = result.body || result
    res.json(body)
  } catch (error) {
    console.error('[网易云歌单分类] 获取失败:', error)
    res.status(502).json({ error: error.message })
  }
})

// 网易云热门歌单
app.get('/api/netease/playlist/hot', async (req, res) => {
  try {
    const { cat = '全部', limit = 30, offset = 0 } = req.query
    if (!NeteaseAPI || !NeteaseAPI.top_playlist) return res.status(500).json({ error: 'API 未初始化' })
    const result = await callNeteaseAPIWithRetry(NeteaseAPI.top_playlist, {
      cat: String(cat), limit: Number(limit), offset: Number(offset)
    })
    const body = result.body || result
    res.json({ playlists: Array.isArray(body.playlists) ? body.playlists : [] })
  } catch (error) {
    console.error('[网易云热门歌单] 获取失败:', error)
    res.status(502).json({ error: error.message })
  }
})

// 网易云精品歌单
app.get('/api/netease/playlist/highquality', async (req, res) => {
  try {
    const { cat = '全部', limit = 30, before } = req.query
    if (!NeteaseAPI || !NeteaseAPI.top_playlist_highquality) return res.status(500).json({ error: 'API 未初始化' })
    const result = await callNeteaseAPIWithRetry(NeteaseAPI.top_playlist_highquality, {
      cat: String(cat), limit: Number(limit), before: before ? String(before) : undefined
    })
    const body = result.body || result
    res.json({ playlists: Array.isArray(body.playlists) ? body.playlists : [] })
  } catch (error) {
    console.error('[网易云精品歌单] 获取失败:', error)
    res.status(502).json({ error: error.message })
  }
})

// 网易云相似歌单
app.get('/api/netease/playlist/simi', async (req, res) => {
  try {
    const { id, limit = 30 } = req.query
    if (!id) return res.status(400).json({ error: '请提供歌单ID' })
    if (!NeteaseAPI || !NeteaseAPI.simi_playlist) return res.status(500).json({ error: 'API 未初始化' })
    const result = await callNeteaseAPIWithRetry(NeteaseAPI.simi_playlist, { id: String(id), limit: Number(limit) })
    const body = result.body || result
    res.json({ playlists: Array.isArray(body.playlists) ? body.playlists : [] })
  } catch (error) {
    console.error('[网易云相似歌单] 获取失败:', error)
    res.status(502).json({ error: error.message })
  }
})

// 网易云热门歌手
app.get('/api/netease/top/artists', async (req, res) => {
  try {
    const { limit = 30, offset = 0 } = req.query
    if (!NeteaseAPI || !NeteaseAPI.top_artists) return res.status(500).json({ error: 'API 未初始化' })
    const result = await callNeteaseAPIWithRetry(NeteaseAPI.top_artists, { limit: Number(limit), offset: Number(offset) })
    const body = result.body || result
    res.json({ artists: Array.isArray(body.artists) ? body.artists : [] })
  } catch (error) {
    console.error('[网易云热门歌手] 获取失败:', error)
    res.status(502).json({ error: error.message })
  }
})

// 网易云新碟榜
app.get('/api/netease/top/album', async (req, res) => {
  try {
    const { limit = 30, offset = 0 } = req.query
    if (!NeteaseAPI || !NeteaseAPI.top_album) return res.status(500).json({ error: 'API 未初始化' })
    const result = await callNeteaseAPIWithRetry(NeteaseAPI.top_album, { limit: Number(limit), offset: Number(offset) })
    const body = result.body || result
    res.json({ albums: Array.isArray(body.albums) ? body.albums : [] })
  } catch (error) {
    console.error('[网易云新碟榜] 获取失败:', error)
    res.status(502).json({ error: error.message })
  }
})

// 网易云 MV 榜
app.get('/api/netease/top/mv', async (req, res) => {
  try {
    const { limit = 30 } = req.query
    if (!NeteaseAPI || !NeteaseAPI.top_mv) return res.status(500).json({ error: 'API 未初始化' })
    const result = await callNeteaseAPIWithRetry(NeteaseAPI.top_mv, { limit: Number(limit) })
    const body = result.body || result
    res.json({ mvs: Array.isArray(body.data) ? body.data : [] })
  } catch (error) {
    console.error('[网易云MV榜] 获取失败:', error)
    res.status(502).json({ error: error.message })
  }
})

// 网易云歌手分类
app.get('/api/netease/artist/list', async (req, res) => {
  try {
    const { type = -1, area = -1, initial = '', limit = 30, offset = 0 } = req.query
    if (!NeteaseAPI || !NeteaseAPI.artist_list) return res.status(500).json({ error: 'API 未初始化' })
    const result = await callNeteaseAPIWithRetry(NeteaseAPI.artist_list, {
      type: Number(type), area: Number(area), initial: String(initial), limit: Number(limit), offset: Number(offset)
    })
    const body = result.body || result
    res.json({ artists: Array.isArray(body.artists) ? body.artists : [] })
  } catch (error) {
    console.error('[网易云歌手分类] 获取失败:', error)
    res.status(502).json({ error: error.message })
  }
})

// QQ 歌单分类
app.get('/api/qq/songlist/category', async (req, res) => {
  try {
    const result = await qqMusicApi.api('songlist/category')
    res.json({ result: 100, data: result })
  } catch (error) {
    console.error('[QQ歌单分类] 获取失败:', error)
    res.status(502).json({ error: error.message })
  }
})

// QQ 分类歌单
app.get('/api/qq/songlist/list', async (req, res) => {
  try {
    const { id, page = 1, pageSize = 20, sort = 5 } = req.query
    if (!id) return res.status(400).json({ error: '请提供分类ID' })
    const result = await qqMusicApi.api('songlist/list', { id: Number(id), page: Number(page), pageSize: Number(pageSize), sort: Number(sort) })
    res.json({ result: 100, data: result })
  } catch (error) {
    console.error('[QQ分类歌单] 获取失败:', error)
    res.status(502).json({ error: error.message })
  }
})

// 网易云「喜欢这首歌的人也爱听」（相似歌曲，公开无需登录）
app.get('/api/netease/song/simi', async (req, res) => {
  try {
    const { id, cookie, limit = 10 } = req.query
    if (!id) return res.status(400).json({ error: '请提供歌曲ID' })
    if (!NeteaseAPI || !NeteaseAPI.simi_song) return res.status(500).json({ error: 'API 未初始化' })
    const cacheKey = recommendCacheKeyWithCookie('ne:simi', id, cookie)
    const cached = getRecommendCache(cacheKey)
    if (cached) return res.json(cached)
    const result = await callNeteaseAPIWithRetry(NeteaseAPI.simi_song, { id: String(id), cookie: String(cookie || '') })
    const body = result.body || result
    const payload = { songs: (Array.isArray(body.songs) ? body.songs : []).slice(0, Number(limit)) }
    setRecommendCache(cacheKey, payload)
    res.json(payload)
  } catch (error) {
    console.error('[网易云也爱听] 获取失败:', error)
    res.status(502).json({ error: error.message })
  }
})

// 网易云「相关歌单」（包含此歌曲的歌单，simi_playlist 正规接口，公开无需登录）
app.get('/api/netease/song/related-playlist', async (req, res) => {
  try {
    const { id, cookie } = req.query
    if (!id) return res.status(400).json({ error: '请提供歌曲ID' })
    if (!NeteaseAPI || !NeteaseAPI.simi_playlist) return res.status(500).json({ error: 'API 未初始化' })
    const cacheKey = recommendCacheKeyWithCookie('ne:song-rel', id, cookie)
    const cached = getRecommendCache(cacheKey)
    if (cached) return res.json(cached)
    const result = await callNeteaseAPIWithRetry(NeteaseAPI.simi_playlist, {
      id: String(id), limit: 5, offset: 0, cookie: String(cookie || '')
    })
    const body = result.body || result
    const payload = { playlists: Array.isArray(body.playlists) ? body.playlists.slice(0, 5) : [] }
    setRecommendCache(cacheKey, payload)
    res.json(payload)
  } catch (error) {
    console.error('[网易云相关歌单] 获取失败:', error)
    res.status(502).json({ error: error.message })
  }
})

// ═══════════════════════════════════════════════════════════════
// 补充二：QQ Banner / 网易云电台 / 相关歌单 / 相似MV / 签到 / 歌曲百科 / 歌曲所在歌单 / MV收藏
// ═══════════════════════════════════════════════════════════════

// QQ 首页 Banner
app.get('/api/qq/banner', async (req, res) => {
  try {
    const cacheKey = 'qq:banner'
    const cached = getRecommendCache(cacheKey)
    if (cached) return res.json(cached)
    const result = await qqMusicApi.api('recommend/banner')
    const banners = Array.isArray(result) ? result : (Array.isArray(result?.banner) ? result.banner : [])
    // 过滤专辑推广轮播（recommend/banner 常返回整屏 album 广告，左下角标 album）
    const payload = { banners: banners
      .filter((b) => {
        const rawUrl = String(b.h5Url || b.url || '')
        const title = String(b.title || b.name || b.typeStr || '').toLowerCase()
        if (title === 'album') return false
        if (/album\/detail|albumid=|album\.html|albumid/i.test(rawUrl)) return false
        return true
      })
      .map((b) => ({
        imageUrl: b.picUrl || b.pic || b.bannerUrl || '',
        url: b.h5Url || b.url || '',
        title: b.title || b.name || b.typeStr || '',
      }))
      .filter(b => b.imageUrl) }
    setRecommendCache(cacheKey, payload)
    res.json(payload)
  } catch (error) {
    console.error('[QQ Banner] 获取失败:', error)
    res.status(502).json({ error: error.message })
  }
})

// 网易云电台推荐
app.get('/api/netease/dj/recommend', async (req, res) => {
  try {
    if (!NeteaseAPI || !NeteaseAPI.dj_recommend) return res.status(500).json({ error: 'API 未初始化' })
    const result = await callNeteaseAPIWithRetry(NeteaseAPI.dj_recommend, {})
    const body = result.body || result
    res.json({ programs: Array.isArray(body.programs) ? body.programs : [], djRadios: Array.isArray(body.djRadios) ? body.djRadios : [] })
  } catch (error) {
    console.error('[网易云电台推荐] 获取失败:', error)
    res.status(502).json({ error: error.message })
  }
})

// 网易云订阅/取消订阅电台（dj_sub：rid 电台id，t=1 订阅 t=0 取消）
app.post('/api/netease/dj/subscribe', async (req, res) => {
  try {
    const { rid, subscribe = true, cookie } = { ...req.query, ...(req.body || {}) }
    if (!rid) return res.status(400).json({ error: '请提供电台ID' })
    if (!cookie) return res.status(401).json({ code: 301, error: '请先登录网易云音乐' })
    if (!NeteaseAPI || !NeteaseAPI.dj_sub) return res.status(500).json({ error: 'API 未初始化' })
    const result = await callNeteaseAPIWithRetry(NeteaseAPI.dj_sub, {
      rid: String(rid), t: subscribe ? 1 : 0, cookie: String(cookie)
    })
    const body = result.body || result
    res.json(body)
  } catch (error) {
    console.error('[网易云电台订阅] 操作失败:', error)
    res.status(502).json({ error: error.message })
  }
})

// 网易云订阅电台列表
app.get('/api/netease/dj/sublist', async (req, res) => {
  try {
    const { cookie, limit = 30, offset = 0 } = req.query
    if (!cookie) return res.status(401).json({ code: 301, error: '请先登录网易云音乐' })
    if (!NeteaseAPI || !NeteaseAPI.dj_sublist) return res.status(500).json({ error: 'API 未初始化' })
    const result = await callNeteaseAPIWithRetry(NeteaseAPI.dj_sublist, {
      limit: Number(limit), offset: Number(offset), cookie: String(cookie)
    })
    const body = result.body || result
    res.json(body)
  } catch (error) {
    console.error('[网易云订阅电台列表] 获取失败:', error)
    res.status(502).json({ error: error.message })
  }
})

// 网易云电台分类
app.get('/api/netease/dj/catelist', async (req, res) => {
  try {
    if (!NeteaseAPI || !NeteaseAPI.dj_catelist) return res.status(500).json({ error: 'API 未初始化' })
    const result = await callNeteaseAPIWithRetry(NeteaseAPI.dj_catelist, {})
    const body = result.body || result
    res.json(body)
  } catch (error) {
    console.error('[网易云电台分类] 获取失败:', error)
    res.status(502).json({ error: error.message })
  }
})

// 网易云电台热门
app.get('/api/netease/dj/hot', async (req, res) => {
  try {
    const { limit = 30, offset = 0 } = req.query
    if (!NeteaseAPI || !NeteaseAPI.dj_hot) return res.status(500).json({ error: 'API 未初始化' })
    const result = await callNeteaseAPIWithRetry(NeteaseAPI.dj_hot, { limit: Number(limit), offset: Number(offset) })
    const body = result.body || result
    res.json({ djRadios: Array.isArray(body.djRadios) ? body.djRadios : [] })
  } catch (error) {
    console.error('[网易云电台热门] 获取失败:', error)
    res.status(502).json({ error: error.message })
  }
})

// 网易云相关歌单
app.get('/api/netease/playlist/related', async (req, res) => {
  try {
    const { id } = req.query
    if (!id) return res.status(400).json({ error: '请提供歌单ID' })
    if (!NeteaseAPI || !NeteaseAPI.related_playlist) return res.status(500).json({ error: 'API 未初始化' })
    const result = await callNeteaseAPIWithRetry(NeteaseAPI.related_playlist, { id: String(id) })
    const body = result.body || result
    res.json({ playlists: Array.isArray(body.playlists) ? body.playlists : [] })
  } catch (error) {
    console.error('[网易云相关歌单] 获取失败:', error)
    res.status(502).json({ error: error.message })
  }
})

// 网易云相似 MV
app.get('/api/netease/simi/mv', async (req, res) => {
  try {
    const { mvid } = req.query
    if (!mvid) return res.status(400).json({ error: '请提供MV ID' })
    if (!NeteaseAPI || !NeteaseAPI.simi_mv) return res.status(500).json({ error: 'API 未初始化' })
    const result = await callNeteaseAPIWithRetry(NeteaseAPI.simi_mv, { mvid: String(mvid) })
    const body = result.body || result
    res.json({ mvs: Array.isArray(body.mvs) ? body.mvs : [] })
  } catch (error) {
    console.error('[网易云相似MV] 获取失败:', error)
    res.status(502).json({ error: error.message })
  }
})

// 网易云每日签到已移除（自动签到类功能下线）

// 网易云相关博客（网易云 App 歌曲详情"相关博客"，原生 POST 表单 + cookie 过风控）
app.get('/api/netease/song/blog', async (req, res) => {
  try {
    const { albumId, page = 1, count = 5, cookie } = req.query
    if (!albumId) return res.status(400).json({ code: 400, error: '请提供专辑ID' })
    const body = new URLSearchParams({ albumId: String(albumId), page: String(page), count: String(count), csrf_token: '' })
    const resp = await fetch('https://music.163.com/api/album/blog', {
      method: 'POST',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Content-Type': 'application/x-www-form-urlencoded',
        'Referer': 'https://music.163.com/',
        ...(cookie ? { Cookie: String(cookie) } : {}),
      },
      body: body.toString(),
      signal: AbortSignal.timeout(15000),
    })
    const data = await resp.json()
    res.json(data)
  } catch (error) {
    console.error('[网易云相关博客] 获取失败:', error?.message || error)
    res.status(502).json({ code: 502, error: error?.message || '获取相关博客失败' })
  }
})

// 网易云关注动态（关注的人的最新动态）
app.get('/api/netease/event/following', async (req, res) => {
  try {
    const { pagesize = 20, lasttime = -1, cookie } = req.query
    if (!cookie) return res.status(401).json({ code: 301, error: '请先登录网易云音乐' })
    if (!NeteaseAPI || !NeteaseAPI.event) return res.status(500).json({ error: 'API 未初始化' })
    const result = await callNeteaseAPIWithRetry(NeteaseAPI.event, {
      pagesize: Number(pagesize), lasttime: Number(lasttime), cookie: String(cookie)
    })
    const body = result.body || result
    res.json(body)
  } catch (error) {
    console.error('[网易云关注动态] 获取失败:', error)
    res.status(502).json({ error: error.message })
  }
})

// 网易云用户动态
app.get('/api/netease/event/user', async (req, res) => {
  try {
    const { uid, lasttime = -1, limit = 30, cookie } = req.query
    if (!uid) return res.status(400).json({ error: '请提供用户ID' })
    if (!NeteaseAPI || !NeteaseAPI.user_event) return res.status(500).json({ error: 'API 未初始化' })
    const result = await callNeteaseAPIWithRetry(NeteaseAPI.user_event, {
      uid: String(uid), lasttime: Number(lasttime), limit: Number(limit), cookie: String(cookie || '')
    })
    const body = result.body || result
    res.json(body)
  } catch (error) {
    console.error('[网易云用户动态] 获取失败:', error)
    res.status(502).json({ error: error.message })
  }
})

// 网易云通知消息（@我 / 回复 / 通知）
app.get('/api/netease/msg/notices', async (req, res) => {
  try {
    const { limit = 30, lasttime = -1, cookie } = req.query
    if (!cookie) return res.status(401).json({ code: 301, error: '请先登录网易云音乐' })
    if (!NeteaseAPI || !NeteaseAPI.msg_notices) return res.status(500).json({ error: 'API 未初始化' })
    const result = await callNeteaseAPIWithRetry(NeteaseAPI.msg_notices, {
      limit: Number(limit), lasttime: Number(lasttime), cookie: String(cookie)
    })
    const body = result.body || result
    res.json(body)
  } catch (error) {
    console.error('[网易云通知消息] 获取失败:', error)
    res.status(502).json({ error: error.message })
  }
})

// 网易云评论消息（@ 我的评论回复）
app.get('/api/netease/msg/comments', async (req, res) => {
  try {
    const { uid, limit = 30, before = -1, cookie } = req.query
    if (!uid) return res.status(400).json({ error: '请提供用户ID' })
    if (!cookie) return res.status(401).json({ code: 301, error: '请先登录网易云音乐' })
    if (!NeteaseAPI || !NeteaseAPI.msg_comments) return res.status(500).json({ error: 'API 未初始化' })
    const result = await callNeteaseAPIWithRetry(NeteaseAPI.msg_comments, {
      uid: String(uid), limit: Number(limit), before: Number(before), cookie: String(cookie)
    })
    const body = result.body || result
    res.json(body)
  } catch (error) {
    console.error('[网易云评论消息] 获取失败:', error)
    res.status(502).json({ error: error.message })
  }
})

// 网易云歌曲百科
app.get('/api/netease/song/wiki', async (req, res) => {
  try {
    const { id } = req.query
    if (!id) return res.status(400).json({ error: '请提供歌曲ID' })
    if (!NeteaseAPI || !NeteaseAPI.song_wiki_summary) return res.status(500).json({ error: 'API 未初始化' })
    const cacheKey = `ne:wiki:${String(id)}`
    const cached = getRecommendCache(cacheKey)
    if (cached) return res.json(cached)
    const result = await callNeteaseAPIWithRetry(NeteaseAPI.song_wiki_summary, { id: String(id) })
    const body = result.body || result
    setRecommendCache(cacheKey, body)
    res.json(body)
  } catch (error) {
    console.error('[网易云歌曲百科] 获取失败:', error)
    res.status(502).json({ error: error.message })
  }
})

// QQ 歌曲所在歌单
app.get('/api/qq/song/playlist', async (req, res) => {
  try {
    const { mid, limit = 10 } = req.query
    if (!mid) return res.status(400).json({ error: '请提供歌曲mid' })
    const cacheKey = `qq:song-playlist:${String(mid)}:${Number(limit)}`
    const cached = getRecommendCache(cacheKey)
    if (cached) return res.json(cached)
    const result = await qqMusicApi.api('song/playlist', { mid: String(mid), limit: Number(limit) })
    const payload = { result: 100, data: result }
    setRecommendCache(cacheKey, payload)
    res.json(payload)
  } catch (error) {
    console.error('[QQ歌曲所在歌单] 获取失败:', error)
    res.status(502).json({ error: error.message })
  }
})

// QQ「听 [歌曲] 的也在听」——基于当前歌曲的跨歌手推荐（相似歌曲 + 相似歌的相似扩展，15 首）
app.get('/api/qq/song/listen-also', async (req, res) => {
  try {
    const { songid, singermid, cookie } = req.query
    if (!songid) return res.status(400).json({ error: '请提供歌曲ID' })
    useQQMusicCookie(cookie)
    const cacheKey = `qq:listen-also:${String(songid)}:${String(singermid || '')}`
    const cached = getRecommendCache(cacheKey)
    if (cached) return res.json(cached)
    const seen = new Set()
    const merged = []
    // 第一层：当前歌曲的相似歌曲
    const sims = await qqMusicApi.api('song/similar', { id: String(songid) })
    const simList = Array.isArray(sims) ? sims : (Array.isArray(sims?.songInfoList) ? sims.songInfoList : [])
    for (const s of simList) {
      const mid = s?.mid || s?.songmid || s?.songMid
      if (mid && !seen.has(mid)) { seen.add(mid); merged.push(s) }
    }
    // 第二层：对前几首相似歌再拉相似（跨歌手扩展，避免全是同歌手）
    for (const s of simList.slice(0, 4)) {
      if (merged.length >= 15) break
      const sid = s?.id || s?.songid
      if (!sid) continue
      try {
        const more = await qqMusicApi.api('song/similar', { id: String(sid) })
        const moreList = Array.isArray(more) ? more : (Array.isArray(more?.songInfoList) ? more.songInfoList : [])
        for (const m of moreList) {
          const mid = m?.mid || m?.songmid || m?.songMid
          if (mid && !seen.has(mid)) {
            seen.add(mid)
            merged.push(m)
            if (merged.length >= 15) break
          }
        }
      } catch { /* 单首扩展失败忽略 */ }
    }
    const songs = merged.slice(0, 15).map((s) => {
      const track = s?.songInfo || s
      const album = track?.album || {}
      const albumMid = album.mid || track.albummid || track.albumMid || ''
      const cover = album.picUrl || album.picurl || track.cover || (albumMid ? qqAlbumCover(String(albumMid).replace(/_\d+$/, ''), 500) : '')
      return {
        id: Number(track.id || track.songid || 0),
        mid: track.mid || track.songmid || track.songMid || '',
        name: track.name || track.title || track.songname || '',
        artists: Array.isArray(track.singer) ? track.singer.map((a) => ({ name: a.name || a.title || '', mid: a.mid })) : [],
        album: { name: album.name || '', picUrl: cover },
        duration: Number(track.interval || 0) * 1000,
        platform: 'qq'
      }
    }).filter(s => s.mid || s.id)
    const payload = { result: 100, data: { songs } }
    setRecommendCache(cacheKey, payload)
    res.json(payload)
  } catch (error) {
    console.error('[QQ也在听] 获取失败:', error?.message || error)
    res.status(502).json({ result: 500, error: error?.message || '获取失败' })
  }
})

// QQ「喜欢 [歌曲] 的人也爱它们」——相似歌曲的相关歌单合并（每批 6 个，offset 换一批）
app.get('/api/qq/song/like-also', async (req, res) => {
  try {
    const { songid, offset = 0 } = req.query
    if (!songid) return res.status(400).json({ error: '请提供歌曲ID' })
    // 每首歌 + offset 对应一批固定的歌单（换一批是切 offset，天然命中不同缓存项）
    const off = Number(offset) || 0
    const cacheKey = `qq:like-also:${String(songid)}:${off}`
    const cached = getRecommendCache(cacheKey)
    if (cached) return res.json(cached)
    // 相似歌曲（5 首）+ 当前歌，各自拉相关歌单合并；offset 换一批用不同种子顺序
    const sims = await qqMusicApi.api('song/similar', { id: String(songid) })
    const simList = Array.isArray(sims) ? sims : (Array.isArray(sims?.songInfoList) ? sims.songInfoList : [])
    const seedIds = [Number(songid), ...simList.map(s => Number(s?.id || s?.songid || 0))].filter(Boolean)
    // offset 轮转种子顺序（换一批）
    const rotated = off === 0 ? seedIds : [...seedIds.slice(off % Math.max(seedIds.length, 1)), ...seedIds.slice(0, off % Math.max(seedIds.length, 1))]
    const seen = new Set()
    const playlists = []
    for (const sid of rotated) {
      try {
        const related = await qqMusicApi.api('song/playlist', { id: sid })
        const list = Array.isArray(related) ? related : (related?.list || [])
        for (const p of list) {
          const tid = String(p?.tid || '')
          if (tid && !seen.has(tid)) {
            seen.add(tid)
            playlists.push({
              id: tid,
              name: p?.dissname || '未知歌单',
              coverImgUrl: p?.imgurl || '',
              trackCount: Number(p?.song_num || 0),
              playCount: Number(p?.listen_num || 0),
              creator: p?.creator || '',
              platform: 'qq'
            })
          }
          if (playlists.length >= 6) break
        }
      } catch { /* 单首相关歌单失败忽略 */ }
      if (playlists.length >= 6) break
    }
    const payload = { result: 100, data: { playlists: playlists.slice(0, 6) } }
    setRecommendCache(cacheKey, payload)
    res.json(payload)
  } catch (error) {
    console.error('[QQ也爱歌单] 获取失败:', error?.message || error)
    res.status(502).json({ result: 500, error: error?.message || '获取失败' })
  }
})

// 网易云云盘歌曲列表
app.get('/api/netease/cloud/list', async (req, res) => {
  try {
    const { cookie, limit = 30, offset = 0 } = req.query
    if (!cookie) return res.status(401).json({ code: 301, error: '请先登录网易云音乐' })
    if (!NeteaseAPI || !NeteaseAPI.user_cloud) return res.status(500).json({ error: 'API 未初始化' })
    const result = await callNeteaseAPIWithRetry(NeteaseAPI.user_cloud, {
      limit: Number(limit), offset: Number(offset), cookie: String(cookie)
    })
    const body = result.body || result
    res.json(body)
  } catch (error) {
    console.error('[网易云云盘列表] 获取失败:', error)
    res.status(502).json({ error: error.message })
  }
})

// 网易云云盘歌曲下载链接
app.get('/api/netease/cloud/url', async (req, res) => {
  try {
    const { id, cookie } = req.query
    if (!id) return res.status(400).json({ error: '请提供歌曲ID' })
    if (!cookie) return res.status(401).json({ code: 301, error: '请先登录网易云音乐' })
    if (!NeteaseAPI || !NeteaseAPI.song_cloud_download) return res.status(500).json({ error: 'API 未初始化' })
    const result = await callNeteaseAPIWithRetry(NeteaseAPI.song_cloud_download, {
      id: String(id), cookie: String(cookie)
    })
    const body = result.body || result
    // 云盘下载地址是 http，转 https 避免 file:// 下混合内容拦截
    if (body?.data?.url && body.data.url.startsWith('http://')) {
      body.data.url = body.data.url.replace(/^http:\/\//, 'https://')
    }
    res.json(body)
  } catch (error) {
    console.error('[网易云云盘下载] 获取失败:', error)
    res.status(502).json({ error: error.message })
  }
})

// 网易云云盘歌曲删除
app.post('/api/netease/cloud/delete', async (req, res) => {
  try {
    const { id, cookie } = { ...req.query, ...(req.body || {}) }
    if (!id) return res.status(400).json({ error: '请提供歌曲ID' })
    if (!cookie) return res.status(401).json({ code: 301, error: '请先登录网易云音乐' })
    if (!NeteaseAPI || !NeteaseAPI.user_cloud_del) return res.status(500).json({ error: 'API 未初始化' })
    const result = await callNeteaseAPIWithRetry(NeteaseAPI.user_cloud_del, {
      id: String(id), cookie: String(cookie)
    })
    const body = result.body || result
    res.json(body)
  } catch (error) {
    console.error('[网易云云盘删除] 操作失败:', error)
    res.status(502).json({ error: error.message })
  }
})

// 网易云收藏的 MV
app.get('/api/netease/mv/sublist', async (req, res) => {
  try {
    const { cookie, limit = 50, offset = 0 } = req.query
    if (!cookie) return res.status(401).json({ code: 301, error: '请先登录网易云音乐' })
    if (!NeteaseAPI || !NeteaseAPI.mv_sublist) return res.status(500).json({ error: 'API 未初始化' })
    const result = await callNeteaseAPIWithRetry(NeteaseAPI.mv_sublist, { limit: Number(limit), offset: Number(offset), cookie: String(cookie) })
    const body = result.body || result
    res.json(body)
  } catch (error) {
    console.error('[网易云收藏MV] 获取失败:', error)
    res.status(502).json({ error: error.message })
  }
})

// 网易云收藏/取消收藏 MV（mv_sub：t=1 收藏，t=0 取消）
app.post('/api/netease/mv/subscribe', async (req, res) => {
  try {
    const { mvid, subscribe = true, cookie } = { ...req.query, ...(req.body || {}) }
    if (!mvid) return res.status(400).json({ code: 400, error: '请提供MV ID' })
    if (!cookie) return res.status(401).json({ code: 301, error: '请先登录网易云音乐' })
    if (!NeteaseAPI || !NeteaseAPI.mv_sub) return res.status(500).json({ error: 'API 未初始化' })
    const result = await callNeteaseAPIWithRetry(NeteaseAPI.mv_sub, {
      mvid: String(mvid), t: subscribe ? 1 : 0, cookie: String(cookie)
    })
    const body = result.body || result
    res.json(body)
  } catch (error) {
    console.error('[网易云收藏MV] 操作失败:', error)
    res.status(502).json({ error: error.message })
  }
})

// 网易云完整排行榜列表（toplist_detail：所有榜单 + 每榜前几条）
app.get('/api/netease/toplist/detail', async (req, res) => {
  try {
    if (!NeteaseAPI || !NeteaseAPI.toplist_detail) return res.status(500).json({ error: 'API 未初始化' })
    const result = await callNeteaseAPIWithRetry(NeteaseAPI.toplist_detail, {})
    const body = result.body || result
    res.json(body)
  } catch (error) {
    console.error('[网易云排行榜列表] 获取失败:', error)
    res.status(502).json({ error: error.message })
  }
})

// 网易云指定榜单完整详情（榜单即歌单，用歌单详情取完整可播放列表）
app.get('/api/netease/toplist/songs', async (req, res) => {
  try {
    const { id, cookie } = req.query
    if (!id) return res.status(400).json({ error: '请提供榜单ID' })
    if (!NeteaseAPI || !NeteaseAPI.playlist_detail) return res.status(500).json({ error: 'API 未初始化' })
    const result = await callNeteaseAPIWithRetry(NeteaseAPI.playlist_detail, { id: String(id), cookie: String(cookie || '') })
    const body = result.body || result
    res.json(body)
  } catch (error) {
    console.error('[网易云榜单歌曲] 获取失败:', error)
    res.status(502).json({ error: error.message })
  }
})

// 网易云私人FM 不再播放（垃圾桶）
app.post('/api/netease/fm/trash', async (req, res) => {
  try {
    const { id, cookie } = { ...req.query, ...(req.body || {}) }
    if (!id) return res.status(400).json({ error: '请提供歌曲ID' })
    if (!cookie) return res.status(401).json({ code: 301, error: '请先登录网易云音乐' })
    if (!NeteaseAPI || !NeteaseAPI.fm_trash) return res.status(500).json({ error: 'API 未初始化' })
    const result = await callNeteaseAPIWithRetry(NeteaseAPI.fm_trash, { id: String(id), cookie: String(cookie) })
    const body = result.body || result
    res.json(body)
  } catch (error) {
    console.error('[网易云FM垃圾桶] 操作失败:', error)
    res.status(502).json({ error: error.message })
  }
})

// 网易云每日推荐不感兴趣
app.post('/api/netease/recommend/dislike', async (req, res) => {
  try {
    const { id, cookie } = { ...req.query, ...(req.body || {}) }
    if (!id) return res.status(400).json({ error: '请提供歌曲ID' })
    if (!cookie) return res.status(401).json({ code: 301, error: '请先登录网易云音乐' })
    if (!NeteaseAPI || !NeteaseAPI.recommend_songs_dislike) return res.status(500).json({ error: 'API 未初始化' })
    const result = await callNeteaseAPIWithRetry(NeteaseAPI.recommend_songs_dislike, { id: String(id), cookie: String(cookie) })
    const body = result.body || result
    res.json(body)
  } catch (error) {
    console.error('[网易云日推不感兴趣] 操作失败:', error)
    res.status(502).json({ error: error.message })
  }
})

// 网易云 VIP 信息
app.get('/api/netease/vip/info', async (req, res) => {
  try {
    const { cookie } = req.query
    if (!cookie) return res.status(401).json({ code: 301, error: '请先登录网易云音乐' })
    if (!NeteaseAPI || !NeteaseAPI.vip_info_v2) return res.status(500).json({ error: 'API 未初始化' })
    const result = await callNeteaseAPIWithRetry(NeteaseAPI.vip_info_v2, { cookie: String(cookie) })
    const body = result.body || result
    res.json(body)
  } catch (error) {
    console.error('[网易云VIP信息] 获取失败:', error)
    res.status(502).json({ error: error.message })
  }
})

// 网易云歌曲收藏状态批量查询（song_like_check：trackIds 用逗号分隔）
app.get('/api/netease/song/like-check', async (req, res) => {
  try {
    const { ids, cookie } = req.query
    if (!ids) return res.status(400).json({ error: '请提供歌曲ID' })
    if (!cookie) return res.status(401).json({ code: 301, error: '请先登录网易云音乐' })
    if (!NeteaseAPI || !NeteaseAPI.song_like_check) return res.status(500).json({ error: 'API 未初始化' })
    const result = await callNeteaseAPIWithRetry(NeteaseAPI.song_like_check, { ids: String(ids), cookie: String(cookie) })
    const body = result.body || result
    res.json(body)
  } catch (error) {
    console.error('[网易云收藏状态查询] 获取失败:', error)
    res.status(502).json({ error: error.message })
  }
})

// ═══════════════════════════════════════════════════════════════
// 第三批：MV分类浏览 + 用户关注/粉丝 + 听歌排行
// ═══════════════════════════════════════════════════════════════

// 网易云 MV 列表（全部 MV）
app.get('/api/netease/mv/all', async (req, res) => {
  try {
    const { limit = 30, offset = 0, area = '', type = '', order = '', cookie } = req.query
    if (!NeteaseAPI || !NeteaseAPI.mv_all) {
      return res.status(500).json({ error: 'API 未初始化' })
    }
    const result = await callNeteaseAPIWithRetry(NeteaseAPI.mv_all, {
      limit: Number(limit), offset: Number(offset),
      area: String(area), type: String(type), order: String(order),
      cookie: String(cookie || '')
    })
    const body = result.body || result
    res.json(body)
  } catch (error) {
    console.error('[网易云MV列表] 获取失败:', error)
    res.status(502).json({ error: error.message || '获取MV列表失败' })
  }
})

// QQ MV 分类列表
app.get('/api/qq/mv/category', async (req, res) => {
  try {
    const result = await qqMusicApi.api('mv/category')
    res.json({ result: 100, data: result })
  } catch (error) {
    console.error('[QQ MV分类] 获取失败:', error)
    res.status(502).json({ error: error.message || '获取MV分类失败' })
  }
})

// QQ MV 列表（按分类）
app.get('/api/qq/mv/list', async (req, res) => {
  try {
    // 库的 mv/list 路由读取 version（版本/类型）与 area（地区）两个分类维度，
    // 而不是 id——之前误传 id 导致分类切换永远返回默认（version=7 全部/area=15 全部）
    const { version = 7, area = 15, pageNo = 1, pageSize = 20 } = req.query
    const result = await qqMusicApi.api('mv/list', { version: Number(version), area: Number(area), pageNo: Number(pageNo), pageSize: Number(pageSize) })
    res.json({ result: 100, data: result })
  } catch (error) {
    console.error('[QQ MV列表] 获取失败:', error)
    res.status(502).json({ error: error.message || '获取MV列表失败' })
  }
})

// 网易云关注列表
app.get('/api/netease/user/follows', async (req, res) => {
  try {
    const { uid, limit = 30, offset = 0, cookie } = req.query
    if (!uid) return res.status(400).json({ error: '请提供用户ID' })
    if (!NeteaseAPI || !NeteaseAPI.user_follows) {
      return res.status(500).json({ error: 'API 未初始化' })
    }
    const result = await callNeteaseAPIWithRetry(NeteaseAPI.user_follows, {
      uid: String(uid), limit: Number(limit), offset: Number(offset), cookie: String(cookie || '')
    })
    const body = result.body || result
    res.json(body)
  } catch (error) {
    console.error('[网易云关注列表] 获取失败:', error)
    res.status(502).json({ error: error.message || '获取关注列表失败' })
  }
})

// 网易云粉丝列表
app.get('/api/netease/user/followeds', async (req, res) => {
  try {
    const { uid, limit = 30, offset = 0, cookie } = req.query
    if (!uid) return res.status(400).json({ error: '请提供用户ID' })
    if (!NeteaseAPI || !NeteaseAPI.user_followeds) {
      return res.status(500).json({ error: 'API 未初始化' })
    }
    const result = await callNeteaseAPIWithRetry(NeteaseAPI.user_followeds, {
      uid: String(uid), limit: Number(limit), offset: Number(offset), cookie: String(cookie || '')
    })
    const body = result.body || result
    res.json(body)
  } catch (error) {
    console.error('[网易云粉丝列表] 获取失败:', error)
    res.status(502).json({ error: error.message || '获取粉丝列表失败' })
  }
})

// 网易云关注/取关用户
app.post('/api/netease/user/subscribe', async (req, res) => {
  try {
    const { id, subscribe = true, cookie } = { ...req.query, ...(req.body || {}) }
    if (!id) return res.status(400).json({ error: '请提供用户ID' })
    if (!cookie) return res.status(401).json({ code: 301, error: '请先登录网易云音乐' })
    if (!NeteaseAPI || !NeteaseAPI.follow_user) {
      return res.status(500).json({ error: 'API 未初始化' })
    }
    const result = await callNeteaseAPIWithRetry(NeteaseAPI.follow_user, {
      id: String(id), t: subscribe === true || subscribe === 'true' ? 1 : 0, cookie: String(cookie)
    })
    const body = result.body || result
    res.json(body)
  } catch (error) {
    console.error('[网易云关注用户] 失败:', error)
    res.status(502).json({ error: error.message || '关注用户失败' })
  }
})

// 网易云听歌排行（type=0 所有, type=1 周排行）
app.get('/api/netease/record/rank/:type', async (req, res) => {
  try {
    const { type } = req.params
    const { uid, cookie } = req.query
    if (!uid) return res.status(400).json({ error: '请提供用户ID' })
    if (!cookie) return res.status(401).json({ code: 301, error: '请先登录网易云音乐' })
    if (!NeteaseAPI || !NeteaseAPI.user_record) {
      return res.status(500).json({ error: 'API 未初始化' })
    }
    const rankType = String(type) === '1' ? 1 : 0
    const result = await callNeteaseAPIWithRetry(NeteaseAPI.user_record, {
      uid: String(uid), type: rankType, cookie: String(cookie)
    })
    const body = result.body || result
    res.json(body)
  } catch (error) {
    console.error('[网易云听歌排行] 获取失败:', error)
    res.status(502).json({ error: error.message || '获取听歌排行失败' })
  }
})

// ── Apple Music 目录代理（营销工具 RSS 无 CORS 头，浏览器直连会被拦截）──
app.get('/api/apple/rss', async (req, res) => {
  const rawPath = String(req.query.path || '')
  const country = String(req.query.country || 'cn').toLowerCase()
  const safePath = rawPath.replace(/[^a-zA-Z0-9/._-]/g, '')
  if (!safePath) return res.status(400).json({ error: '缺少 path 参数' })
  const url = `https://rss.marketingtools.apple.com/api/v2/${encodeURIComponent(country)}/${safePath}`
  try {
    const response = await axios.get(url, {
      timeout: 15000,
      headers: { 'User-Agent': 'WaveForge/0.1 (compatible)', Accept: 'application/json' },
      responseType: 'json',
    })
    res.json(response.data)
  } catch (error) {
    console.error('[Apple RSS] 代理失败:', error.message || error)
    res.status(502).json({ error: error.message || 'Apple RSS 获取失败' })
  }
})

// ── Apple Music amp-api 通用代理（渲染进程直连 amp-api 被 CORS 拦截时的兜底通道）──
// 与 Electron 主进程 apple-api IPC 同语义：透传 Authorization / Media-User-Token，
// 支持 GET/POST/PATCH/DELETE，原样回传状态码与 JSON。仅监听 127.0.0.1，token 不出本机。
const APPLE_AMP_API_BASE = 'https://amp-api.music.apple.com'
async function proxyAppleAmpApi(req, res) {
  const rawPath = String(req.query.path || '')
  if (!rawPath.startsWith('/v1/')) {
    return res.status(400).json({ error: 'path 必须以 /v1/ 开头' })
  }
  const url = `${APPLE_AMP_API_BASE}${rawPath}`
  const headers = {
    Accept: 'application/json',
    Origin: 'https://music.apple.com',
    Referer: 'https://music.apple.com/',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  }
  const auth = req.headers['authorization']
  if (auth) headers.Authorization = auth
  const mut = req.headers['media-user-token']
  if (mut) headers['Media-User-Token'] = mut
  const method = (req.method || 'GET').toUpperCase()
  if (req.body !== undefined && req.body !== null && Object.keys(req.body).length > 0) {
    headers['Content-Type'] = 'application/json'
  }
  try {
    const response = await axios({
      method,
      url,
      timeout: 20000,
      headers,
      data: method === 'GET' ? undefined : (req.body || undefined),
      responseType: 'text',
      validateStatus: () => true,
    })
    res.status(response.status)
    const text = String(response.data || '')
    let data = null
    try { data = text ? JSON.parse(text) : null } catch { data = text }
    res.json(data ?? { ok: true })
  } catch (error) {
    console.error('[Apple AMP 代理] 失败:', error.message || error)
    res.status(502).json({ error: error.message || 'Apple AMP API 请求失败' })
  }
}
app.get('/api/apple/amp', proxyAppleAmpApi)
app.post('/api/apple/amp', proxyAppleAmpApi)
app.patch('/api/apple/amp', proxyAppleAmpApi)
app.delete('/api/apple/amp', proxyAppleAmpApi)

// ── Apple Music Widevine license 代理（acquireWebPlaybackLicense）───────────
// 渲染进程直连时 Origin 是本机页面（127.0.0.1:3000），Apple license 服务会做来源
// 校验并返回 200 + 错误 JSON（无 license 字段）。统一走本地代理，请求头与
// webPlayback 同款（Origin/Referer = music.apple.com）。
const APPLE_LICENSE_URL = 'https://play.itunes.apple.com/WebObjects/MZPlay.woa/wa/acquireWebPlaybackLicense'
// Apple 网页会话 Cookie（登录时由 main 进程落盘）：license 接口校验网页会话，
// 仅凭 media-user-token 会被拒（-1002 session ended）
function readAppleWebCookieHeader() {
  try {
    const base = process.env.WAVEFORGE_USERDATA
      || join(process.env.APPDATA || join(os.homedir(), 'AppData', 'Roaming'), 'Electron')
    const data = JSON.parse(readFileSync(join(base, 'apple-web-cookies.json'), 'utf8'))
    return typeof data?.cookie === 'string' && data.cookie ? data.cookie : ''
  } catch {
    return ''
  }
}
app.post('/api/apple/license', async (req, res) => {
  const headers = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    Origin: 'https://music.apple.com',
    Referer: 'https://music.apple.com/',
    'X-Apple-Renewal': 'true',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  }
  const auth = req.headers['authorization']
  if (auth) headers.Authorization = auth
  // 兼容渲染端历史头名，并统一转发 Apple 私有 license 接口需要的 Media-User-Token。
  // 此前只读 media-user-token，导致 X-Apple-Music-User-Token 在代理边界丢失。
  const mut = req.headers['media-user-token'] || req.headers['x-apple-music-user-token']
  if (mut) headers['Media-User-Token'] = String(mut)
  const cookieHeader = readAppleWebCookieHeader()
  if (cookieHeader) headers.Cookie = cookieHeader
  try {
    const response = await axios({
      method: 'POST',
      url: APPLE_LICENSE_URL,
      timeout: 20000,
      headers,
      data: req.body || undefined,
      responseType: 'text',
      validateStatus: () => true,
    })
    const text = String(response.data || '')
    console.log(`[Apple License 代理] HTTP ${response.status} len=${text.length}${text.length < 200 ? ' body=' + text : ''}${cookieHeader ? ' cookie=yes' : ' cookie=NO'}`)
    res.status(response.status)
    res.type('application/json').send(text)
  } catch (error) {
    console.error('[Apple License 代理] 失败:', error.message || error)
    res.status(502).json({ error: error.message || 'Apple license 请求失败' })
  }
})

// 健康检查
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    neteaseAPI: NeteaseAPI ? 'loaded' : 'not loaded'
  })
})

// 统一错误中间件：Express 4 不转发 async handler 的 rejection，凡是 async 路由
// 漏掉 try/catch 抛出的错误都会走到这里。绝不向上抛给进程，避免崩溃。
app.use((err, req, res, next) => {
  if (res.headersSent) {
    return next(err)
  }
  console.error('[错误中间件]', req.method, req.originalUrl, err?.stack || err)
  res.status(500).json({ error: err?.message || '服务器内部错误' })
})

// 冷启动恢复上次登录的 QQ cookie，保证「我喜欢」等需登录的读取接口直接可用。
restoreQQMusicCookie()

const server = app.listen(PORT, '127.0.0.1', () => {
})
server.on('error', (error) => {
  if (error?.code === 'EADDRINUSE') {
    console.error(`[服务器启动失败] 端口 ${PORT} 已被占用，请关闭占用该端口的程序后重试`)
  } else {
    console.error('[服务器启动失败]', error?.stack || error)
  }
  process.exit(1)
})

export default app


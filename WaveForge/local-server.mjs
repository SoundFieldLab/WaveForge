import express from 'express'
import { fileURLToPath } from 'url'
import { dirname } from 'path'
import qqMusicApi from 'qq-music-api'
import axios from 'axios'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const app = express()
const PORT = 3001

// QQ音乐API配置
const QQ_SMARTBOX_URL = 'https://c.y.qq.com/splcloud/fcgi-bin/smartbox_new.fcg'
const QQ_MUSICU_URL = 'https://u.y.qq.com/cgi-bin/musicu.fcg'
const QQ_HEADERS = {
  Referer: 'https://y.qq.com/',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36'
}

app.use(express.json())
app.use(express.urlencoded({ extended: true }))

// CORS 支持
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*')
  res.header('Access-Control-Allow-Headers', 'Content-Type')
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE')
  next()
})

// ========== TTML解析器 ==========
/**
 * 简单的TTML解析器（不依赖DOM）
 * 解析AMLL TTML DB格式并转换为LRC格式
 */
function parseTTMLSimple(ttmlText) {
  const result = {
    lyric: '',
    translation: ''
  }
  
  try {
    const lyricLines = []
    const translationLines = []
    
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


// 图片代理（解决防盗链和CORS）
app.get('/api/cover', async (req, res) => {
  try {
    const { url } = req.query
    
    // URL 校验
    if (!url || !/^https?:\/\//i.test(url)) {
      console.error('Invalid cover URL:', url)
      res.status(400).set('Access-Control-Allow-Origin', '*').send('Invalid cover url')
      return
    }

    console.log('Fetching cover:', url)

    // 转发请求，添加必要的 headers
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
        'Referer': 'https://music.163.com/',
        'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      }
    })

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

    const contentType = response.headers.get('content-type') || 'image/jpeg'
    const buffer = await response.arrayBuffer()
    
    console.log('Cover fetched successfully, size:', buffer.byteLength)
    
    res.set({
      'Content-Type': contentType,
      'Access-Control-Allow-Origin': '*',
      'Cross-Origin-Resource-Policy': 'cross-origin',
      'Cache-Control': 'public, max-age=86400',
    })
    
    res.send(Buffer.from(buffer))
  } catch (error) {
    console.error('封面代理错误:', error)
    res.status(500).set('Access-Control-Allow-Origin', '*').send('Failed to load cover')
  }
})

// 动态导入网易云音乐 API
let NeteaseAPI = null

async function initNeteaseAPI() {
  try {
    const module = await import('NeteaseCloudMusicApi')
    NeteaseAPI = module.default
    console.log('✅ 网易云音乐 API 加载成功')
  } catch (error) {
    console.error('❌ 网易云音乐 API 加载失败:', error)
  }
}

// 初始化
initNeteaseAPI()

// 网易云音乐 API 路由
app.get('/api/netease/search', async (req, res) => {
  try {
    const { keywords, limit = 30 } = req.query
    if (!keywords) {
      return res.status(400).json({ error: '请提供搜索关键词' })
    }
    
    if (!NeteaseAPI || !NeteaseAPI.search) {
      return res.status(500).json({ error: 'API 未初始化' })
    }

    const result = await NeteaseAPI.search({
      keywords,
      limit,
    })
    
    // 网易云搜索API返回的album.picId会被JavaScript截断
    // 只获取前30个专辑封面，其余的由前端按需加载
    if (result.body?.result?.songs) {
      // 批量获取专辑详情
      const albumIds = [...new Set(result.body.result.songs.map(s => s.album?.id).filter(Boolean))]
      const albumDetails = {}
      
      console.log(`需要获取 ${albumIds.length} 个专辑封面，先获取前15个`)
      
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
            console.error(`✗ 获取专辑 ${albumId} 详情失败:`, err.message)
          }
        }))
        // 批次之间延迟200ms
        if (i + batchSize < firstBatch.length) {
          await new Promise(resolve => setTimeout(resolve, 200))
        }
      }
      
      console.log(`成功获取 ${Object.keys(albumDetails).length} 个专辑封面`)
      
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
    res.status(500).json({ error: error.message })
  }
})

// 批量获取网易云专辑封面
app.get('/api/netease/albums/covers', async (req, res) => {
  try {
    const { ids } = req.query
    if (!ids) {
      return res.status(400).json({ error: '请提供专辑ID列表' })
    }

    if (!NeteaseAPI || !NeteaseAPI.album) {
      return res.status(500).json({ error: 'API 未初始化' })
    }

    const albumIds = ids.split(',').map(id => parseInt(id)).filter(Boolean)
    const albumCovers = {}
    
    console.log(`批量获取 ${albumIds.length} 个专辑封面`)
    
    // 串行获取，每次间隔300ms，避免被限流
    for (const albumId of albumIds) {
      try {
        await new Promise(resolve => setTimeout(resolve, 300)) // 延迟300ms
        const albumRes = await NeteaseAPI.album({ id: albumId })
        if (albumRes.body?.album?.picUrl) {
          albumCovers[albumId] = albumRes.body.album.picUrl
        }
      } catch (err) {
        console.error(`获取专辑 ${albumId} 封面失败:`, err.message)
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
          name: artist.name,
          keyword: artist.name
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

app.get('/api/netease/song/url', async (req, res) => {
  try {
    const { id, br = 320000 } = req.query
    if (!id) {
      return res.status(400).json({ error: '请提供歌曲ID' })
    }

    if (!NeteaseAPI || !NeteaseAPI.song_url_v1) {
      return res.status(500).json({ error: 'API 未初始化' })
    }

    const result = await NeteaseAPI.song_url_v1({
      id,
      level: 'exhigh',
    })
    
    res.json(result.body)
  } catch (error) {
    console.error('获取播放链接错误:', error)
    res.status(500).json({ error: error.message })
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

    // 使用新版歌词接口，包含逐字歌词
    const result = await NeteaseAPI.lyric_new({ id })
    
    res.json(result.body)
  } catch (error) {
    console.error('获取歌词错误:', error)
    res.status(500).json({ error: error.message })
  }
})

// 网易云热榜API
app.get('/api/netease/top/song', async (req, res) => {
  try {
    if (!NeteaseAPI || !NeteaseAPI.playlist_detail) {
      return res.status(500).json({ error: 'API 未初始化' })
    }

    // 获取飙升榜 (id: 19723756)
    const result = await NeteaseAPI.playlist_detail({ id: 19723756 })
    
    if (result.body?.playlist?.tracks) {
      res.json({ 
        code: 200,
        data: result.body.playlist.tracks 
      })
    } else {
      res.json({ code: 200, data: [] })
    }
  } catch (error) {
    console.error('获取热榜错误:', error)
    res.status(500).json({ error: error.message })
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
    const result = await NeteaseAPI.login_qr_key()
    res.json(result.body)
  } catch (error) {
    console.error('获取二维码key错误:', error)
    res.status(500).json({ error: error.message })
  }
})

app.get('/api/netease/login/qr/create', async (req, res) => {
  try {
    const { key } = req.query
    if (!key) {
      return res.status(400).json({ error: '请提供key' })
    }
    if (!NeteaseAPI || !NeteaseAPI.login_qr_create) {
      return res.status(500).json({ error: 'API 未初始化' })
    }
    const result = await NeteaseAPI.login_qr_create({ key, qrimg: true })
    res.json(result.body)
  } catch (error) {
    console.error('创建二维码错误:', error)
    res.status(500).json({ error: error.message })
  }
})

app.get('/api/netease/login/qr/check', async (req, res) => {
  try {
    const { key } = req.query
    if (!key) {
      return res.status(400).json({ error: '请提供key' })
    }
    if (!NeteaseAPI || !NeteaseAPI.login_qr_check) {
      return res.status(500).json({ error: 'API 未初始化' })
    }
    const result = await NeteaseAPI.login_qr_check({ key })
    res.json(result.body)
  } catch (error) {
    console.error('检查登录状态错误:', error)
    res.status(500).json({ error: error.message })
  }
})

app.get('/api/netease/login/status', async (req, res) => {
  try {
    const { cookie } = req.query
    if (!NeteaseAPI || !NeteaseAPI.login_status) {
      return res.status(500).json({ error: 'API 未初始化' })
    }
    const result = await NeteaseAPI.login_status({ cookie })
    res.json(result.body)
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
    const { id } = req.query
    if (!id) {
      return res.status(400).json({ error: '请提供歌单ID' })
    }
    if (!NeteaseAPI || !NeteaseAPI.playlist_detail) {
      return res.status(500).json({ error: 'API 未初始化' })
    }
    const result = await NeteaseAPI.playlist_detail({ id })
    res.json(result.body)
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
    
    res.json(result.body)
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

    console.log('[网易云每日推荐] 正在获取每日推荐歌曲')
    const result = await NeteaseAPI.recommend_songs({ cookie })
    
    console.log('[网易云每日推荐] 返回歌曲数:', result.body?.data?.dailySongs?.length || 0)
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

    console.log('[网易云私人雷达] 正在获取私人FM')
    const result = await NeteaseAPI.personal_fm({ cookie })
    
    console.log('[网易云私人雷达] 返回歌曲数:', result.body?.data?.length || 0)
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

    console.log('[网易云推荐歌单] 正在获取推荐歌单')
    const result = await NeteaseAPI.recommend_resource({ cookie })
    
    console.log('[网易云推荐歌单] 返回歌单数:', result.body?.recommend?.length || 0)
    res.json(result.body)
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

    console.log('[网易云雷达歌单] 正在获取雷达歌单, songId:', id)
    const result = await NeteaseAPI.playmode_intelligence_list({ 
      cookie,
      id: id || '33894312',  // 默认歌曲ID
      pid: pid || '24381616',  // 默认歌单ID
      count: 30
    })
    
    console.log('[网易云雷达歌单] 返回歌曲数:', result.body?.data?.length || 0)
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

async function qqMusicRequest(data) {
  const response = await fetch(QQ_MUSICU_URL, {
    method: 'POST',
    headers: {
      ...QQ_HEADERS,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(data)
  })
  return await response.json()
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
  
  console.log('[QQ搜索] smartbox返回歌曲数:', json?.data?.song?.itemlist?.length || 0)
  
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
async function qqWebSearch(keywords, limit = 30) {
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
    
    console.log('[QQ网页搜索] 请求URL:', url.toString())
    
    const response = await fetch(url.toString(), { 
      headers: {
        ...QQ_HEADERS,
        'Referer': 'https://y.qq.com/'
      }
    })
    const json = await response.json()
    
    console.log('[QQ网页搜索] 返回状态:', json.code)
    console.log('[QQ网页搜索] 返回歌曲数:', json?.data?.song?.list?.length || 0)
    
    if (json.code !== 0 || !json.data?.song?.list) {
      return []
    }
    
    const songs = json.data.song.list
    
    // 映射歌曲数据
    const mappedSongs = songs.map(item => {
      const albumMid = item.albummid || ''
      const artists = (item.singer || []).map(s => ({ name: s.name, mid: s.mid }))
      
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
      console.log(`[QQ音乐搜索] ${songsNeedingDetails.length} 首歌曲缺少封面，正在补充详情...`)
      
      // 并发获取详情（限制并发数为5）
      const detailPromises = songsNeedingDetails.slice(0, 5).map(song => 
        qqSongDetail(song.mid, song).catch(err => {
          console.error(`[QQ音乐详情] 获取失败 ${song.name}:`, err.message)
          return song // 失败时返回原数据
        })
      )
      
      const detailedSongs = await Promise.all(detailPromises)
      
      // 更新歌曲列表
      detailedSongs.forEach(detailedSong => {
        const index = mappedSongs.findIndex(s => s.mid === detailedSong.mid)
        if (index !== -1) {
          mappedSongs[index] = detailedSong
          if (detailedSong.album?.picUrl) {
            console.log(`[QQ音乐详情] ✅ 已补充封面: ${detailedSong.name}`)
          }
        }
      })
    }
    
    // 移除临时标记
    return mappedSongs.map(({needsDetail, ...song}) => song)
  } catch (error) {
    console.error('[QQ网页搜索] 失败:', error.message)
    return []
  }
}

// 新增：使用musicu API进行更完整的搜索
async function qqMusicSearch(keywords, limit = 30) {
  try {
    // 先尝试网页搜索接口
    const webResults = await qqWebSearch(keywords, limit)
    if (webResults.length > 0) {
      console.log('[QQ音乐搜索] 网页搜索成功，返回', webResults.length, '首')
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
      console.log('[QQ音乐搜索] musicu无结果，降级到smartbox搜索')
      return await qqSmartboxSearch(keywords, limit)
    }
    
    return songs.map(item => {
      const albumMid = item.album?.mid || ''
      const artists = (item.singer || []).map(s => ({ name: s.name, mid: s.mid }))
      
      return {
        id: item.id || 0,
        mid: item.mid || '',
        name: item.name || '',
        artists,
        album: {
          name: item.album?.name || '',
          picUrl: qqAlbumCover(albumMid, 500)
        },
        duration: item.interval || 0,
        platform: 'qq'
      }
    })
  } catch (error) {
    console.error('[QQ音乐搜索] 失败:', error.message)
    // 降级到smartbox搜索
    return await qqSmartboxSearch(keywords, limit)
  }
}

async function qqSongDetail(mid, fallback = {}) {
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
    
    if (track && track.album?.mid) {
      const albumMid = track.album.mid
      const artists = (track.singer || []).map(s => ({ name: s.name, mid: s.mid }))
      
      console.log(`[QQ音乐详情] pf_song_detail_svr 成功 | albumMid: ${albumMid}`)

      return {
        id: track.id || fallback.id || 0,
        mid: track.mid || mid,
        name: track.title || track.name || fallback.name || '',
        artists: artists.length ? artists : (fallback.artists || []),
        album: {
          name: track.album?.name || (fallback.album?.name || fallback.album || ''),
          picUrl: qqAlbumCover(albumMid, 500)
        },
        duration: (track.interval || 0) * 1000 || fallback.duration || 0,
        platform: 'qq',
        vip: fallback.vip || false, // 保留原始VIP信息
        noCopyright: fallback.noCopyright || false // 保留原始版权信息
      }
    }
    
    // 方法2: 尝试vkey API (这个API通常返回更完整的信息)
    console.log(`[QQ音乐详情] pf_song_detail_svr 无结果，尝试 song.info 接口`)
    json = await qqMusicRequest({
      comm: { ct: 24, cv: 0 },
      req_1: {
        module: 'music.musicasset.song_info',
        method: 'get_song_info_all',
        param: { song_mid: mid }
      }
    })
    
    track = json?.req_1?.data?.info
    if (track && track.album?.mid) {
      const albumMid = track.album.mid
      const artists = (track.singer || []).map(s => ({ name: s.name, mid: s.mid }))
      
      console.log(`[QQ音乐详情] song.info 成功 | albumMid: ${albumMid}`)

      return {
        id: track.id || fallback.id || 0,
        mid: track.mid || mid,
        name: track.title || track.name || fallback.name || '',
        artists: artists.length ? artists : (fallback.artists || []),
        album: {
          name: track.album?.name || (fallback.album?.name || fallback.album || ''),
          picUrl: qqAlbumCover(albumMid, 500)
        },
        duration: (track.interval || 0) * 1000 || fallback.duration || 0,
        platform: 'qq',
        vip: fallback.vip || false, // 保留原始VIP信息
        noCopyright: fallback.noCopyright || false // 保留原始版权信息
      }
    }
    
    console.log(`[QQ音乐详情] 所有API都未返回封面信息`)
    return fallback
    
  } catch (error) {
    console.error(`[QQ音乐详情] 请求失败 ${mid}:`, error.message)
    return fallback
  }
}

// QQ 音乐 API 路由
app.get('/api/qq/search', async (req, res) => {
  try {
    const { keywords, limit = 30 } = req.query
    if (!keywords) {
      return res.status(400).json({ error: '请提供搜索关键词' })
    }

    console.log('[QQ音乐搜索]', keywords, 'limit:', limit)
    
    const base = await qqMusicSearch(keywords, parseInt(limit))
    
    console.log('[QQ音乐搜索] 基础搜索返回:', base.length, '首')
    
    // 获取每首歌的详细信息（包含封面）
    const detailed = await Promise.all(base.map(async item => {
      try {
        return await qqSongDetail(item.mid, item)
      } catch (e) {
        console.warn('[QQ音乐] 获取详情失败:', item.mid, e.message)
        return item
      }
    }))
    
    console.log('[QQ音乐搜索] 返回歌曲数:', detailed.filter(s => s && s.name).length)

    res.json({ 
      provider: 'qq',
      songs: detailed.filter(song => song && song.name)
    })
  } catch (error) {
    console.error('QQ音乐搜索错误:', error)
    res.status(500).json({ error: error.message, songs: [] })
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

app.get('/api/qq/song/url', async (req, res) => {
  try {
    const { mid, id, cookie } = req.query
    if (!mid && !id) {
      return res.status(400).json({ error: '请提供歌曲mid或id' })
    }

    const songMid = mid || id
    
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`)
    console.log(`[QQ音乐URL] 获取播放链接`)
    console.log(`  歌曲MID: ${songMid}`)
    console.log(`  Cookie: ${cookie ? `已提供 (长度:${cookie.length})` : '未提供'}`)
    
    // 如果提供了cookie，先设置到qq-music-api
    if (cookie) {
      try {
        // 移除可能的引号
        const cleanCookie = cookie.replace(/^['"]|['"]$/g, '')
        qqMusicApi.setCookie(cleanCookie)
        console.log(`[QQ音乐URL] ✅ Cookie已设置`)
      } catch (err) {
        console.error(`[QQ音乐URL] ❌ 设置Cookie失败:`, err.message)
      }
    }
    
    // 方法1: 使用qq-music-api库（支持会员歌曲）
    try {
      console.log(`[QQ音乐URL] 尝试方法1: qq-music-api.getSongUrl`)
      const apiResult = await qqMusicApi.api('song/url', { id: songMid })
      
      console.log(`[QQ音乐URL] qq-music-api返回:`, JSON.stringify(apiResult, null, 2))
      console.log(`[QQ音乐URL] 返回类型:`, typeof apiResult)
      
      // qq-music-api可能直接返回字符串URL，也可能返回对象
      let url = null
      if (typeof apiResult === 'string') {
        url = apiResult
      } else if (apiResult?.data) {
        url = apiResult.data
      }
      
      if (url && typeof url === 'string' && url.startsWith('http')) {
        console.log(`[QQ音乐URL] ✅ 方法1成功，返回播放链接: ${url.substring(0, 50)}...`)
        console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`)
        return res.json({ url })
      }
      
      console.log(`[QQ音乐URL] ⚠️ 方法1返回空URL或无效URL，尝试方法2`)
    } catch (apiErr) {
      console.error(`[QQ音乐URL] ❌ 方法1失败:`, apiErr.message)
    }
    
    // 方法2: 直接调用QQ音乐API（VIP歌曲可能需要cookie）
    console.log(`[QQ音乐URL] 尝试方法2: 直接调用vkey.GetVkeyServer`)
    const json = await qqMusicRequest({
      comm: { ct: 24, cv: 0 },
      req_1: {
        module: 'vkey.GetVkeyServer',
        method: 'CgiGetVkey',
        param: {
          guid: '10000',
          songmid: [songMid],
          songtype: [0],
          uin: '0',
          loginflag: 1,
          platform: '20'
        }
      }
    })

    console.log(`[QQ音乐URL] vkey.GetVkeyServer返回:`, JSON.stringify(json?.req_1?.data, null, 2))

    const vkey = json?.req_1?.data?.midurlinfo?.[0]?.vkey
    const purl = json?.req_1?.data?.midurlinfo?.[0]?.purl
    
    console.log(`[QQ音乐URL] 方法2结果 | vkey: ${vkey ? '有' : '无'} | purl: ${purl || '无'}`)
    
    if (!vkey || !purl) {
      console.log(`[QQ音乐URL] 方法2失败，尝试方法3: 获取试听链接`)
      
      // 方法3: 尝试获取试听链接
      const previewJson = await qqMusicRequest({
        comm: { ct: 24, cv: 0 },
        req_1: {
          module: 'vkey.GetVkeyServer',
          method: 'CgiGetVkey',
          param: {
            guid: '10000',
            songmid: [songMid],
            songtype: [0],
            uin: '0',
            loginflag: 0,
            platform: '20',
            filename: [`C400${songMid}.m4a`]
          }
        }
      })
      
      const previewVkey = previewJson?.req_1?.data?.midurlinfo?.[0]?.vkey
      const previewPurl = previewJson?.req_1?.data?.midurlinfo?.[0]?.purl
      
      console.log(`[QQ音乐URL] 方法3结果 | vkey: ${previewVkey ? '有' : '无'} | purl: ${previewPurl || '无'}`)
      
      if (previewVkey && previewPurl) {
        const url = `https://dl.stream.qqmusic.qq.com/${previewPurl}`
        console.log(`[QQ音乐URL] ✅ 方法3成功，返回试听链接`)
        console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`)
        return res.json({ url, isPreview: true })
      }
      
      console.log(`[QQ音乐URL] ❌ 所有方法都失败，无法获取播放链接`)
      console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`)
      return res.json({ url: null })
    }

    const url = `https://dl.stream.qqmusic.qq.com/${purl}`
    console.log(`[QQ音乐URL] ✅ 方法2成功，返回完整播放链接`)
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`)
    
    res.json({ url })
  } catch (error) {
    console.error('[QQ音乐URL] ❌ 发生异常:', error)
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`)
    res.status(500).json({ error: error.message, url: null })
  }
})

app.get('/api/qq/lyric', async (req, res) => {
  try {
    const { id, mid, cookie } = req.query
    if (!id && !mid) {
      return res.status(400).json({ error: '请提供歌曲id或mid' })
    }

    const songMid = mid || id
    
    console.log(`[QQ音乐歌词] 获取歌词，MID: ${songMid}`)
    console.log(`[QQ音乐歌词] Cookie: ${cookie ? `已提供 (长度:${cookie.length})` : '未提供'}`)
    
    // 方法1: 使用musicu API (Mineradio的主要方法，支持qrc、roma等)
    let lyricText = ''
    let transText = ''
    
    try {
      console.log(`[QQ音乐歌词] 尝试方法1: musicu API`)
      const param = {}
      if (songMid) param.songMID = songMid
      if (id) param.songID = parseInt(id)
      
      const json = await qqMusicRequest({
        comm: { ct: 24, cv: 0 },
        lyric: {
          module: 'music.musichallSong.PlayLyricInfo',
          method: 'GetPlayLyricInfo',
          param,
        }
      })
      
      const data = json?.lyric?.data
      console.log(`[QQ音乐歌词] musicu返回字段:`, Object.keys(data || {}))
      
      if (data?.lyric) lyricText = Buffer.from(data.lyric, 'base64').toString('utf-8')
      if (data?.trans) transText = Buffer.from(data.trans, 'base64').toString('utf-8')
      
      console.log(`[QQ音乐歌词] 方法1 | 原文: ${lyricText.length} | 翻译: ${transText.length}`)
      
      // 如果官方已有完整歌词，直接返回（优化速度）
      if (lyricText && transText) {
        console.log(`[QQ音乐歌词] ✅ 官方歌词完整，直接返回`)
        res.json({ 
          lrc: { lyric: lyricText },
          trans: { lyric: transText }
        })
        return
      }
    } catch (e) {
      console.warn(`[QQ音乐歌词] 方法1失败:`, e.message)
    }
    
    // 方法2: fcg_query_lyric_new (备用方法)
    // 如果没有歌词，尝试方法2（已有翻译则跳过）
    if (!lyricText && songMid) {
      try {
        console.log(`[QQ音乐歌词] 尝试方法2: fcg_query_lyric_new`)
        const lyricUrl = new URL('https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg')
        lyricUrl.searchParams.set('songmid', songMid)
        lyricUrl.searchParams.set('songtype', '0')
        lyricUrl.searchParams.set('format', 'json')
        lyricUrl.searchParams.set('nobase64', '1')
        lyricUrl.searchParams.set('g_tk', '5381')
        lyricUrl.searchParams.set('loginUin', '0')
        lyricUrl.searchParams.set('hostUin', '0')
        lyricUrl.searchParams.set('inCharset', 'utf8')
        lyricUrl.searchParams.set('outCharset', 'utf-8')
        lyricUrl.searchParams.set('notice', '0')
        lyricUrl.searchParams.set('platform', 'yqq.json')
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
        
        lyricText = data.lyric || lyricText
        
        console.log(`[QQ音乐歌词] 方法2 | 原文: ${lyricText.length}`)
      } catch (e) {
        console.warn(`[QQ音乐歌词] 方法2失败:`, e.message)
      }
    }
    
    // 方法3: AMLL TTML DB (仅在需要翻译时调用)
    if (!transText && songMid) {
      try {
        console.log(`[QQ音乐歌词] 尝试方法3: AMLL TTML DB`)
        
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
          console.log(`[QQ音乐歌词] AMLL TTML获取成功，长度: ${ttmlText.length}`)
          
          // 解析TTML格式
          const ttmlLyric = parseTTMLSimple(ttmlText)
          
          if (ttmlLyric.translation) {
            transText = ttmlLyric.translation
            console.log(`[QQ音乐歌词] ✅ AMLL提供翻译歌词，长度: ${transText.length}`)
          }
          
          if (ttmlLyric.lyric && !lyricText) {
            lyricText = ttmlLyric.lyric
            console.log(`[QQ音乐歌词] ✅ AMLL提供原文歌词，长度: ${lyricText.length}`)
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
      console.log(`[QQ音乐歌词] ✅ 找到翻译歌词！`)
    } else {
      console.log(`[QQ音乐歌词] ⚠️ 无翻译歌词`)
    }
    
    res.json({ 
      lrc: { lyric: lyricText },
      trans: { lyric: transText }
    })
  } catch (error) {
    console.error('[QQ音乐歌词] ❌ 获取错误:', error)
    res.status(500).json({ error: error.message, lrc: { lyric: '' }, trans: { lyric: '' } })
  }
})

// QQ音乐热榜API
app.get('/api/qq/top', async (req, res) => {
  try {
    const { id = 26 } = req.query // 26: 热歌榜, 4: 流行榜
    
    console.log('[QQ音乐热榜] 正在获取热榜，ID:', id)
    
    // 使用qq-music-api获取热榜
    const result = await qqMusicApi.api('top', { id: parseInt(id) })
    
    console.log('[QQ音乐热榜] API返回结果:', result ? '成功' : '失败')
    
    if (result && result.data) {
      res.json(result)
    } else {
      console.warn('[QQ音乐热榜] API返回数据为空')
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

// QQ音乐新歌首发API
app.get('/api/qq/new/songs', async (req, res) => {
  try {
    console.log('[QQ音乐新歌] 正在获取新歌列表...')
    
    // 使用qq-music-api获取新歌
    const result = await qqMusicApi.api('new/songs', { type: 0 })
    
    console.log('[QQ音乐新歌] API返回结果:', result ? '成功' : '失败')
    
    if (result && result.data) {
      res.json(result)
    } else {
      // 如果qq-music-api失败，返回空列表
      console.warn('[QQ音乐新歌] API返回数据为空，返回空列表')
      res.json({
        result: 100,
        data: {
          song_list: []
        }
      })
    }
  } catch (error) {
    console.error('[QQ音乐新歌] 获取错误:', error.message)
    res.status(200).json({
      result: 100,
      data: {
        song_list: []
      }
    })
  }
})

// QQ音乐每日推荐（需要登录）
app.get('/api/qq/recommend/daily', async (req, res) => {
  try {
    const { cookie } = req.query
    
    if (!cookie) {
      return res.status(401).json({ result: 301, errMsg: '需要登录' })
    }
    
    console.log('[QQ音乐每日推荐] 正在获取每日推荐...')
    
    // 设置Cookie
    qqMusicApi.setCookie(cookie)
    
    const result = await qqMusicApi.api('recommend/daily')
    
    console.log('[QQ音乐每日推荐] API返回结果:', JSON.stringify(result, null, 2))
    console.log('[QQ音乐每日推荐] result.result:', result?.result)
    console.log('[QQ音乐每日推荐] result.data:', result?.data ? '存在' : '不存在')
    console.log('[QQ音乐每日推荐] result.data字段:', result?.data ? Object.keys(result.data) : [])
    
    // recommend/daily 返回的是歌单详情，直接返回
    if (result && result.result === 100 && result.data) {
      console.log('[QQ音乐每日推荐] 成功获取数据，返回给前端')
      res.json(result)
    } else if (result && result.result === 301) {
      // 未登录或Cookie失效
      console.warn('[QQ音乐每日推荐] 未登录或Cookie已过期')
      res.json({
        result: 301,
        errMsg: '未登录或Cookie已过期'
      })
    } else {
      console.warn('[QQ音乐每日推荐] API返回数据为空或格式异常')
      console.warn('[QQ音乐每日推荐] 完整返回:', result)
      res.json({
        result: 100,
        data: {
          song_list: [],
          songlist: [],
          list: []
        }
      })
    }
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
    console.log('[QQ音乐推荐歌单] 正在获取推荐歌单...')
    
    const result = await qqMusicApi.api('recommend/playlist/u')
    
    console.log('[QQ音乐推荐歌单] API返回完整数据:', JSON.stringify(result, null, 2))
    
    // qq-music-api 直接返回 { result: 100, data: { list, count } }
    if (result && result.result === 100 && result.data) {
      console.log('[QQ音乐推荐歌单] 返回歌单数:', result.data.list?.length || 0)
      res.json(result)
    } else {
      console.warn('[QQ音乐推荐歌单] API返回数据为空')
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

// QQ音乐登录相关 API
app.post('/api/qq/user/setCookie', async (req, res) => {
  try {
    const { data } = req.body
    if (!data) {
      return res.status(400).json({ result: 500, errMsg: '请提供Cookie' })
    }

    // 设置Cookie到qq-music-api
    qqMusicApi.setCookie(data)
    
    // 解析Cookie获取用户信息
    const cookieObj = {}
    data.split('; ').forEach((c) => {
      const arr = c.split('=')
      if (arr[0] && arr[1]) {
        cookieObj[arr[0]] = arr[1]
      }
    })

    // 提取uin（用户ID）
    let uin = cookieObj.uin || cookieObj.wxuin || ''
    uin = uin.replace(/\D/g, '')

    console.log('✅ QQ音乐Cookie已设置，用户ID:', uin)

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
    const { id } = req.query
    if (!id) {
      return res.status(400).json({ result: 500, errMsg: '请提供用户ID' })
    }

    console.log('[QQ音乐用户详情] 正在获取用户ID:', id)
    
    // 使用qq-music-api获取用户信息
    const result = await qqMusicApi.api('user/detail', { id })
    
    console.log('[QQ音乐用户详情] API返回结果:', JSON.stringify(result, null, 2))
    
    res.json(result)
  } catch (error) {
    console.error('[QQ音乐用户详情] 获取错误:', error)
    res.status(500).json({ result: 500, errMsg: error.message })
  }
})

// 获取QQ音乐用户歌单
app.get('/api/qq/user/playlist', async (req, res) => {
  try {
    const { id } = req.query
    if (!id) {
      return res.status(400).json({ result: 500, errMsg: '请提供用户ID' })
    }

    console.log('[QQ音乐用户歌单] 正在获取用户ID:', id)
    
    // 使用qq-music-api获取用户歌单
    const result = await qqMusicApi.api('user/songlist', { id })
    
    console.log('[QQ音乐用户歌单] API返回结果:', JSON.stringify(result, null, 2))
    
    res.json(result)
  } catch (error) {
    console.error('[QQ音乐用户歌单] 获取错误:', error)
    res.status(500).json({ result: 500, errMsg: error.message, data: { list: [] } })
  }
})

// 获取QQ音乐收藏歌单
app.get('/api/qq/user/collect', async (req, res) => {
  try {
    const { id } = req.query
    if (!id) {
      return res.status(400).json({ result: 500, errMsg: '请提供用户ID' })
    }

    console.log('[QQ音乐收藏歌单] 正在获取用户ID:', id)
    
    // 使用 Mineradio 的方法：直接调用腾讯的收藏歌单 API
    // 关键：需要带上 Cookie！
    try {
      // 从 qq-music-api 获取 Cookie
      const qqCookie = qqMusicApi.getCookie?.() || ''
      console.log('[QQ音乐收藏歌单] Cookie状态:', qqCookie ? `已设置(长度:${qqCookie.length})` : '未设置')
      
      const response = await axios.get('https://c.y.qq.com/fav/fcgi-bin/fcg_get_profile_order_asset.fcg', {
        params: {
          ct: 20,
          cid: 205360956,
          userid: id,
          reqtype: 3,
          sin: 0,
          ein: 80
        },
        headers: {
          'Referer': 'https://y.qq.com/portal/profile.html',
          'Cookie': qqCookie,
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36'
        }
      })
      
      console.log('[QQ音乐收藏歌单] API返回结果:', JSON.stringify(response.data, null, 2))
      
      // 转换为统一格式
      const cdlist = response.data?.data?.cdlist || []
      console.log('[QQ音乐收藏歌单] 收藏歌单数量:', cdlist.length)
      
      const result = {
        result: 100,
        data: {
          list: cdlist
        }
      }
      
      res.json(result)
    } catch (apiError) {
      console.warn('[QQ音乐收藏歌单] API请求失败:', apiError.message)
      res.json({ result: 100, data: { list: [] } })
    }
  } catch (error) {
    console.error('[QQ音乐收藏歌单] 获取错误:', error)
    res.status(500).json({ result: 500, errMsg: error.message, data: { list: [] } })
  }
})

// 获取QQ音乐歌单详情
app.get('/api/qq/playlist/detail', async (req, res) => {
  try {
    const { id } = req.query
    if (!id) {
      return res.status(400).json({ result: 500, errMsg: '请提供歌单ID' })
    }

    console.log('[QQ音乐歌单详情] 正在获取歌单ID:', id)
    
    // 使用qq-music-api获取歌单详情
    const result = await qqMusicApi.api('songlist', { id })
    
    console.log('[QQ音乐歌单详情] API返回结果 (歌曲数):', result.data?.songlist?.length || 0)
    
    res.json(result)
  } catch (error) {
    console.error('[QQ音乐歌单详情] 获取错误:', error)
    res.status(500).json({ result: 500, errMsg: error.message })
  }
})

// 健康检查
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    neteaseAPI: NeteaseAPI ? 'loaded' : 'not loaded' 
  })
})

app.listen(PORT, () => {
  console.log(`🎵 WaveForge API Server running on http://localhost:${PORT}`)
})

export default app

const API_BASE = 'http://localhost:3001/api'

export interface Song {
  id: number
  mid?: string // QQ音乐需要mid
  name: string
  artists: { name: string; mid?: string }[]
  album: {
    id?: number // 网易云专辑ID，用于懒加载封面
    name: string
    picUrl: string
  }
  duration: number
  platform?: 'netease' | 'qq' // 标识来源平台
  vip?: boolean // 是否为VIP歌曲
  noCopyright?: boolean // 是否无版权
  fee?: number // 付费类型（网易云）0免费 1VIP 4付费专辑 8低音质免费
}

export interface Artist {
  id: number
  mid?: string // QQ音乐需要mid
  name: string
  picUrl: string
  albumSize?: number // 专辑数量
  musicSize?: number // 歌曲数量
  description?: string // 艺人介绍
  platform?: 'netease' | 'qq'
}

export interface Album {
  id: number
  mid?: string // QQ音乐需要mid
  name: string
  picUrl: string
  artist: { name: string; id?: number; mid?: string }
  publishTime?: number
  size?: number // 歌曲数量
  description?: string // 专辑描述
  platform?: 'netease' | 'qq'
}

export interface SearchSuggestion {
  keyword: string
  type: 'song' | 'artist' | 'album' // 搜索类型
}

export interface SearchResult {
  songs: Song[]
  songCount: number
  artists?: Artist[] // 歌手搜索结果
  albums?: Album[] // 专辑搜索结果
}

export interface LyricLine {
  time: number
  text: string
  words?: LyricWord[] // 逐字歌词
  translation?: string // 翻译
}

export interface LyricWord {
  word: string
  startTime: number // 相对于歌词行开始的时间（毫秒）
  duration: number // 持续时间（毫秒）
}

// 添加尺寸参数（网易云 CDN 支持）
function addCoverSizeParam(url: string, size: number = 500): string {
  if (!url || !/^https?:\/\//i.test(url)) return url
  const param = `param=${size}y${size}`
  if (/[?&]param=\d+y\d+/i.test(url)) {
    return url.replace(/([?&])param=\d+y\d+/i, `$1${param}`)
  }
  return url + (url.indexOf('?') >= 0 ? '&' : '?') + param
}

// 图片代理（解决防盗链和CORS）
export function getProxiedImageUrl(originalUrl: string, size: number = 500): string {
  if (!originalUrl || !/^https?:\/\//i.test(originalUrl)) return ''
  
  // QQ音乐和网易云都需要代理
  const urlWithSize = addCoverSizeParam(originalUrl, size)
  return `${API_BASE}/cover?url=${encodeURIComponent(urlWithSize)}`
}

// 搜索歌曲（支持平台选择）
export async function searchSongs(keywords: string, limit = 30, platform: 'netease' | 'qq' = 'netease'): Promise<SearchResult> {
  try {
    const endpoint = platform === 'qq' ? '/qq/search' : '/netease/search'
    const response = await fetch(`${API_BASE}${endpoint}?keywords=${encodeURIComponent(keywords)}&limit=${limit}`)
    const data = await response.json()
    
    if (platform === 'qq') {
      // QQ音乐返回格式
      const songs = (data.songs || []).map((song: any) => {
        return {
          id: song.id || 0,
          mid: song.mid || '', // QQ音乐需要mid
          name: song.name || '',
          artists: song.artists || [],
          album: {
            name: song.album?.name || song.album || '',
            picUrl: song.album?.picUrl || song.cover || ''
          },
          duration: song.duration || 0,
          platform: 'qq',
          vip: song.vip || false, // VIP标识
          noCopyright: song.noCopyright || false // 无版权标识
        }
      })
      
      return {
        songs,
        songCount: songs.length
      }
    } else {
      // 网易云音乐返回格式
      const songs = (data.result?.songs || []).map((song: any) => ({
        id: song.id,
        name: song.name,
        artists: song.artists || [],
        album: {
          id: song.album?.id, // 保存专辑ID用于懒加载
          name: song.album?.name || '',
          picUrl: song.album?.picUrl || 
                  song.album?.artist?.img1v1Url || 
                  song.album?.blurPicUrl ||
                  song.artists?.[0]?.img1v1Url ||
                  ''
        },
        duration: song.duration || 0,
        platform: 'netease',
        vip: song.vip || false, // VIP标识
        noCopyright: song.noCopyright || false, // 无版权标识
        fee: song.fee // 付费类型
      }))
      
      return {
        songs,
        songCount: data.result?.songCount || 0
      }
    }
  } catch (error) {
    console.error('搜索失败:', error)
    throw error
  }
}

// 搜索建议
export async function searchSuggest(keywords: string, platform: 'netease' | 'qq' = 'netease'): Promise<SearchSuggestion[]> {
  try {
    console.log('🌐 [API] searchSuggest 请求:', { keywords, platform })
    
    if (platform === 'qq') {
      const response = await fetch(`${API_BASE}/qq/suggest?keywords=${encodeURIComponent(keywords)}`)
      const data = await response.json()
      console.log('📦 [API] QQ音乐原始数据:', data)
      
      const suggestions: SearchSuggestion[] = []
      
      // QQ音乐的suggest接口通常返回一个suggestions数组，每个元素包含keyword和type
      if (data.suggestions && Array.isArray(data.suggestions)) {
        data.suggestions.forEach((item: any) => {
          if (item.keyword || item.value) {
            suggestions.push({ 
              keyword: item.keyword || item.value, 
              type: 'song' // 默认单曲，如果有type字段可以映射
            })
          }
        })
      }
      
      console.log('✅ [API] QQ音乐搜索建议:', suggestions)
      return suggestions
    }
    
    // 网易云音乐
    const response = await fetch(`${API_BASE}/netease/search/suggest?keywords=${encodeURIComponent(keywords)}`)
    const data = await response.json()
    console.log('📦 [API] 网易云原始数据:', data)
    
    const suggestions: SearchSuggestion[] = []
    
    // 网易云通常返回 result.allMatch 或直接 suggestions
    const result = data.result || data
    
    // 尝试从不同字段提取建议
    if (result.allMatch && Array.isArray(result.allMatch)) {
      result.allMatch.forEach((item: any) => {
        if (item.keyword) {
          const type = item.type === 100 ? 'artist' : item.type === 10 ? 'album' : 'song'
          suggestions.push({ keyword: item.keyword, type })
        }
      })
    } else if (result.order && result.order.length > 0) {
      // 按照order的顺序提取
      result.order.forEach((key: string) => {
        if (result[key] && Array.isArray(result[key])) {
          const type = key === 'artists' ? 'artist' : key === 'albums' ? 'album' : 'song'
          result[key].slice(0, 3).forEach((item: any) => {
            suggestions.push({ 
              keyword: item.name || item.keyword, 
              type 
            })
          })
        }
      })
    } else if (data.suggestions && Array.isArray(data.suggestions)) {
      // 简单的suggestions数组
      data.suggestions.forEach((item: any) => {
        suggestions.push({ 
          keyword: typeof item === 'string' ? item : (item.keyword || item.name || item.value), 
          type: 'song' 
        })
      })
    }
    
    console.log('✅ [API] 网易云搜索建议:', suggestions)
    return suggestions
  } catch (error) {
    console.error('❌ [API] 搜索建议失败:', error)
    return []
  }
}

// 搜索歌手
export async function searchArtists(keywords: string, platform: 'netease' | 'qq' = 'netease'): Promise<Artist[]> {
  try {
    console.log('🎤 [API] searchArtists 请求:', { keywords, platform })
    
    if (platform === 'qq') {
      const response = await fetch(`${API_BASE}/qq/search?keywords=${encodeURIComponent(keywords)}&type=singer`)
      const data = await response.json()
      console.log('📦 [API] QQ歌手搜索原始数据:', data)
      
      const artists = (data.singers || []).map((item: any) => ({
        id: item.singer_id,
        mid: item.singer_mid,
        name: item.singer_name,
        picUrl: item.singer_pic ? `https://y.gtimg.cn/music/photo_new/T001R300x300M000${item.singer_mid}.jpg` : '',
        albumSize: item.albumNum,
        musicSize: item.songNum,
        platform: 'qq' as const
      }))
      
      console.log('✅ [API] QQ歌手搜索结果:', artists.length, '个')
      return artists
    }
    
    const response = await fetch(`${API_BASE}/netease/search?keywords=${encodeURIComponent(keywords)}&type=100`)
    const data = await response.json()
    console.log('📦 [API] 网易云歌手搜索原始数据:', data)
    
    const artists = (data.result?.artists || []).map((item: any) => ({
      id: item.id,
      name: item.name,
      picUrl: item.picUrl || item.img1v1Url,
      albumSize: item.albumSize,
      musicSize: item.musicSize,
      platform: 'netease' as const
    }))
    
    console.log('✅ [API] 网易云歌手搜索结果:', artists.length, '个')
    return artists
  } catch (error) {
    console.error('搜索歌手失败:', error)
    return []
  }
}

// 搜索专辑
export async function searchAlbums(keywords: string, platform: 'netease' | 'qq' = 'netease'): Promise<Album[]> {
  try {
    console.log('💿 [API] searchAlbums 请求:', { keywords, platform })
    
    if (platform === 'qq') {
      const response = await fetch(`${API_BASE}/qq/search?keywords=${encodeURIComponent(keywords)}&type=album`)
      const data = await response.json()
      console.log('📦 [API] QQ专辑搜索原始数据:', data)
      
      const albums = (data.albums || []).map((item: any) => ({
        id: item.albumID,
        mid: item.albumMID,
        name: item.albumName,
        picUrl: item.albumPic ? `https://y.gtimg.cn/music/photo_new/T002R300x300M000${item.albumMID}.jpg` : '',
        artist: { name: item.singer_name, mid: item.singer_mid },
        publishTime: item.pub_time,
        platform: 'qq' as const
      }))
      
      console.log('✅ [API] QQ专辑搜索结果:', albums.length, '个')
      return albums
    }
    
    const response = await fetch(`${API_BASE}/netease/search?keywords=${encodeURIComponent(keywords)}&type=10`)
    const data = await response.json()
    console.log('📦 [API] 网易云专辑搜索原始数据:', data)
    
    const albums = (data.result?.albums || []).map((item: any) => ({
      id: item.id,
      name: item.name,
      picUrl: item.picUrl,
      artist: { name: item.artist?.name, id: item.artist?.id },
      publishTime: item.publishTime,
      size: item.size,
      platform: 'netease' as const
    }))
    
    console.log('✅ [API] 网易云专辑搜索结果:', albums.length, '个')
    return albums
  } catch (error) {
    console.error('搜索专辑失败:', error)
    return []
  }
}

// 获取歌曲播放URL（支持平台）
export async function getSongUrl(id: number | string, platform: 'netease' | 'qq' = 'netease'): Promise<string | null> {
  try {
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
    console.log('🌐 [API] getSongUrl 开始')
    console.log(`  平台: ${platform}`)
    console.log(`  歌曲ID: ${id}`)
    
    if (platform === 'qq') {
      const cookie = localStorage.getItem('qq_cookie') || ''
      console.log(`  Cookie: ${cookie ? '已提供 (长度:' + cookie.length + ')' : '未提供'}`)
      
      const apiUrl = `${API_BASE}/qq/song/url?mid=${id}&cookie=${encodeURIComponent(cookie)}`
      console.log(`  请求URL: ${apiUrl.substring(0, 100)}...`)
      console.log('  发送请求中...')
      
      const response = await fetch(apiUrl)
      console.log(`  响应状态: ${response.status} ${response.statusText}`)
      
      const data = await response.json()
      console.log('  响应数据:', data)
      
      if (data.url) {
        console.log(`✅ [API] 成功获取播放URL`)
        console.log(`  URL: ${data.url.substring(0, 100)}...`)
      } else {
        console.error('❌ [API] 响应中没有URL字段')
        console.error('  完整响应:', JSON.stringify(data, null, 2))
      }
      
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
      return data.url || null
    } else {
      // 网易云音乐
      const cookie = localStorage.getItem('netease_cookie') || ''
      console.log(`  Cookie: ${cookie ? '已提供 (长度:' + cookie.length + ')' : '未提供'}`)
      
      const apiUrl = `${API_BASE}/netease/song/url?id=${id}${cookie ? '&cookie=' + encodeURIComponent(cookie) : ''}`
      console.log(`  请求URL: ${apiUrl.substring(0, 100)}...`)
      
      const response = await fetch(apiUrl)
      console.log(`  响应状态: ${response.status} ${response.statusText}`)
      
      const data = await response.json()
      console.log('  响应数据:', data)
      
      const url = data.data?.[0]?.url || null
      if (url) {
        console.log(`✅ [API] 成功获取播放URL`)
      } else {
        console.error('❌ [API] 响应中没有URL')
      }
      
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
      return url
    }
  } catch (error) {
    console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
    console.error('❌ [API] getSongUrl 发生错误')
    console.error('  错误信息:', error)
    console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
    return null
  }
}

// 获取歌曲详情
export async function getSongDetail(id: number): Promise<Song | null> {
  try {
    const response = await fetch(`${API_BASE}/netease/song/detail?ids=${id}`)
    const data = await response.json()
    
    return data.songs?.[0] || null
  } catch (error) {
    console.error('获取歌曲详情失败:', error)
    return null
  }
}

// 解析逐字歌词
// 格式: [16210,3460](16210,670,0)还(16880,410,0)没...
function parseYrc(yrcText: string): LyricLine[] {
  if (!yrcText) return []
  
  const lines = yrcText.split('\n')
  const result: LyricLine[] = []
  
  for (const line of lines) {
    // 跳过JSON元数据行
    if (line.trim().startsWith('{')) continue
    if (!line.trim()) continue
    
    // 匹配格式: [开始时间,总时长](字1时间,字1时长,0)字1(字2时间,字2时长,0)字2...
    const headerMatch = /^\[(\d+),(\d+)\]/.exec(line)
    if (!headerMatch) continue
    
    const lineStartTime = parseInt(headerMatch[1]) / 1000 // 转换为秒
    const lineDuration = parseInt(headerMatch[2]) / 1000
    
    // 提取所有逐字信息
    const words: LyricWord[] = []
    let fullText = ''
    
    // 匹配所有 (时间,时长,0)字 的模式
    const wordRegex = /\((\d+),(\d+),\d+\)([^(]+?)(?=\(|$)/g
    let wordMatch
    
    while ((wordMatch = wordRegex.exec(line)) !== null) {
      const wordStartTime = parseInt(wordMatch[1]) // 毫秒
      const wordDuration = parseInt(wordMatch[2]) * 10 // 厘秒转毫秒
      const word = wordMatch[3]
      
      fullText += word
      words.push({
        word,
        startTime: wordStartTime,
        duration: wordDuration
      })
    }
    
    if (fullText) {
      result.push({
        time: lineStartTime,
        text: fullText,
        words: words.length > 0 ? words : undefined
      })
    }
  }
  
  return result.sort((a, b) => a.time - b.time)
}

// 解析普通歌词
function parseLyric(lyricText: string): LyricLine[] {
  if (!lyricText) return []
  
  const lines = lyricText.split('\n')
  const result: LyricLine[] = []
  
  const timeRegex = /\[(\d{2}):(\d{2})\.(\d{2,3})\]/
  
  for (const line of lines) {
    const match = timeRegex.exec(line)
    if (match) {
      const minutes = parseInt(match[1])
      const seconds = parseInt(match[2])
      const milliseconds = parseInt(match[3].padEnd(3, '0'))
      
      const time = minutes * 60 + seconds + milliseconds / 1000
      const text = line.replace(timeRegex, '').trim()
      
      if (text) {
        result.push({ time, text })
      }
    }
  }
  
  return result.sort((a, b) => a.time - b.time)
}

// 获取歌词（支持平台）
export async function getLyrics(id: number | string, platform: 'netease' | 'qq' = 'netease'): Promise<LyricLine[]> {
  try {
    // 降级到平台原生歌词
    if (platform === 'qq') {
      // 获取QQ音乐Cookie（注意键名是 qq_cookie 不是 qqCookie）
      const qqCookie = localStorage.getItem('qq_cookie') || ''
      const url = new URL(`${API_BASE}/qq/lyric`)
      url.searchParams.set('mid', String(id))
      if (qqCookie) {
        url.searchParams.set('cookie', qqCookie)
      }
      
      console.log('🎵 [getLyrics] QQ音乐歌词请求')
      console.log('  MID:', id)
      console.log('  Cookie:', qqCookie ? `已获取 (长度:${qqCookie.length})` : '未获取')
      
      const response = await fetch(url.toString())
      const data = await response.json()
      const lyricText = data.lrc?.lyric || ''
      const translationText = data.trans?.lyric || ''
      
      console.log('  原文长度:', lyricText.length)
      console.log('  翻译长度:', translationText.length)
      
      const lyrics = parseLyric(lyricText)
      const translations = parseLyric(translationText)
      return mergeLyricsWithTranslation(lyrics, translations)
    } else {
      const response = await fetch(`${API_BASE}/netease/lyric?id=${id}`)
      const data = await response.json()
      
      console.log('🎵 [getLyrics] 网易云歌词数据:')
      console.log('  歌曲ID:', id)
      console.log('  原文歌词:', data.lrc?.lyric ? `存在 (${data.lrc.lyric.length}字符)` : '不存在')
      console.log('  翻译歌词:', data.tlyric?.lyric ? `存在 (${data.tlyric.lyric.length}字符)` : '不存在')
      console.log('  逐字歌词:', data.yrc?.lyric ? `存在 (${data.yrc.lyric.length}字符)` : '不存在')
      
      // 获取翻译歌词
      const translationText = data.tlyric?.lyric || ''
      const translations = parseLyric(translationText)
      
      console.log('  解析后翻译行数:', translations.length)
      
      // 如果有逐字歌词(yrc)，优先使用
      if (data.yrc?.lyric) {
        const lyrics = parseYrc(data.yrc.lyric)
        const merged = mergeLyricsWithTranslation(lyrics, translations)
        console.log('  最终歌词行数:', merged.length, '(使用逐字歌词)')
        return merged
      }
      
      // 否则使用普通歌词
      const lyricText = data.lrc?.lyric || ''
      const lyrics = parseLyric(lyricText)
      const merged = mergeLyricsWithTranslation(lyrics, translations)
      console.log('  最终歌词行数:', merged.length, '(使用普通歌词)')
      return merged
    }
  } catch (error) {
    console.error('获取歌词失败:', error)
    return []
  }
}

// 合并歌词和翻译
function mergeLyricsWithTranslation(lyrics: LyricLine[], translations: LyricLine[]): LyricLine[] {
  if (translations.length === 0) return lyrics
  
  // 使用贪婪算法：为每句歌词找最接近的翻译
  const usedTranslations = new Set<number>()
  
  return lyrics.map((lyric) => {
    let bestMatch: LyricLine | undefined
    let minDiff = Infinity
    
    // 找到时间最接近且未使用的翻译
    translations.forEach((t, index) => {
      if (usedTranslations.has(index)) return
      
      const diff = Math.abs(t.time - lyric.time)
      // 放宽阈值到 1 秒，因为逐字歌词的时间戳可能与翻译有较大偏差
      if (diff < 1.0 && diff < minDiff) {
        minDiff = diff
        bestMatch = t
      }
    })
    
    // 标记已使用的翻译
    if (bestMatch) {
      const matchIndex = translations.indexOf(bestMatch)
      if (matchIndex !== -1) {
        usedTranslations.add(matchIndex)
      }
    }
    
    return {
      ...lyric,
      translation: bestMatch?.text || ''
    }
  })
}


// 从AMLL TTML DB获取逐字歌词
async function getTTMLLyrics(id: number | string, platform: 'netease' | 'qq'): Promise<LyricLine[]> {
  try {
    const folder = platform === 'qq' ? 'qq-lyrics' : 'ncm-lyrics'
    const url = `https://raw.githubusercontent.com/amll-dev/amll-ttml-db/refs/heads/main/${folder}/${id}.lrc`
    
    const response = await fetch(url)
    if (!response.ok) {
      return []
    }
    
    const lyricText = await response.text()
    // AMLL的LRC格式包含增强的逐字信息
    return parseLyric(lyricText)
  } catch (error) {
    // 未找到TTML歌词，静默失败
    return []
  }
}

// 批量获取网易云专辑封面
export async function loadAlbumCovers(songs: Song[]): Promise<Song[]> {
  try {
    // 提取需要加载封面的专辑ID
    const albumIds = [...new Set(songs.map(s => s.album?.id).filter(Boolean))] as number[]
    
    if (albumIds.length === 0) return songs
    
    console.log(`批量加载 ${albumIds.length} 个专辑封面`)
    
    const response = await fetch(`${API_BASE}/netease/albums/covers?ids=${albumIds.join(',')}`)
    const data = await response.json()
    
    if (data.covers) {
      // 更新歌曲的封面URL
      return songs.map(song => {
        if (song.album?.id && data.covers[song.album.id]) {
          return {
            ...song,
            album: {
              ...song.album,
              picUrl: data.covers[song.album.id]
            }
          }
        }
        return song
      })
    }
    
    return songs
  } catch (error) {
    console.error('批量加载封面失败:', error)
    return songs
  }
}

// 获取歌手详情
export async function getArtistDetail(id: number | string, platform: 'netease' | 'qq' = 'netease'): Promise<Artist | null> {
  try {
    if (platform === 'qq') {
      const response = await fetch(`${API_BASE}/qq/artist?mid=${id}`)
      const data = await response.json()
      return {
        id: data.singer_id,
        mid: data.singer_mid,
        name: data.singer_name,
        picUrl: `https://y.gtimg.cn/music/photo_new/T001R800x800M000${id}.jpg`,
        albumSize: data.albumNum,
        musicSize: data.songNum,
        description: data.desc,
        platform: 'qq'
      }
    }
    
    const response = await fetch(`${API_BASE}/netease/artist?id=${id}`)
    const data = await response.json()
    return {
      id: data.artist.id,
      name: data.artist.name,
      picUrl: data.artist.picUrl || data.artist.img1v1Url,
      albumSize: data.artist.albumSize,
      musicSize: data.artist.musicSize,
      description: data.artist.briefDesc,
      platform: 'netease'
    }
  } catch (error) {
    console.error('获取歌手详情失败:', error)
    return null
  }
}

// 获取歌手热门歌曲
export async function getArtistTopSongs(id: number | string, platform: 'netease' | 'qq' = 'netease'): Promise<Song[]> {
  try {
    if (platform === 'qq') {
      const response = await fetch(`${API_BASE}/qq/artist/songs?mid=${id}`)
      const data = await response.json()
      return (data.songs || []).slice(0, 50).map((item: any) => ({
        id: item.songid,
        mid: item.songmid,
        name: item.songname,
        artists: item.singer?.map((s: any) => ({ name: s.name, mid: s.mid })) || [],
        album: {
          id: item.albumid,
          name: item.albumname,
          picUrl: `https://y.gtimg.cn/music/photo_new/T002R300x300M000${item.albummid}.jpg`
        },
        duration: item.interval * 1000,
        platform: 'qq' as const,
        vip: item.pay?.payplay === 1
      }))
    }
    
    const response = await fetch(`${API_BASE}/netease/artist/top?id=${id}`)
    const data = await response.json()
    return (data.songs || []).slice(0, 50).map((item: any) => ({
      id: item.id,
      name: item.name,
      artists: item.ar?.map((a: any) => ({ name: a.name })) || [],
      album: {
        id: item.al?.id,
        name: item.al?.name || '',
        picUrl: getProxiedImageUrl(item.al?.picUrl || '')
      },
      duration: item.dt,
      platform: 'netease' as const,
      vip: item.fee === 1,
      noCopyright: item.noCopyrightRcmd !== null,
      fee: item.fee
    }))
  } catch (error) {
    console.error('获取歌手热门歌曲失败:', error)
    return []
  }
}

// 获取专辑详情
export async function getAlbumDetail(id: number | string, platform: 'netease' | 'qq' = 'netease'): Promise<Album | null> {
  try {
    if (platform === 'qq') {
      const response = await fetch(`${API_BASE}/qq/album?mid=${id}`)
      const data = await response.json()
      return {
        id: data.albumID,
        mid: data.albumMID,
        name: data.albumName,
        picUrl: `https://y.gtimg.cn/music/photo_new/T002R800x800M000${id}.jpg`,
        artist: { name: data.singer_name, mid: data.singer_mid },
        publishTime: data.pub_time,
        description: data.desc,
        platform: 'qq'
      }
    }
    
    const response = await fetch(`${API_BASE}/netease/album?id=${id}`)
    const data = await response.json()
    return {
      id: data.album.id,
      name: data.album.name,
      picUrl: getProxiedImageUrl(data.album.picUrl),
      artist: { name: data.album.artist?.name, id: data.album.artist?.id },
      publishTime: data.album.publishTime,
      size: data.album.size,
      description: data.album.description,
      platform: 'netease'
    }
  } catch (error) {
    console.error('获取专辑详情失败:', error)
    return null
  }
}

// 获取专辑歌曲列表
export async function getAlbumSongs(id: number | string, platform: 'netease' | 'qq' = 'netease'): Promise<Song[]> {
  try {
    if (platform === 'qq') {
      const response = await fetch(`${API_BASE}/qq/album?mid=${id}`)
      const data = await response.json()
      return (data.songs || []).map((item: any) => ({
        id: item.songid,
        mid: item.songmid,
        name: item.songname,
        artists: item.singer?.map((s: any) => ({ name: s.name, mid: s.mid })) || [],
        album: {
          id: data.albumID,
          name: data.albumName,
          picUrl: `https://y.gtimg.cn/music/photo_new/T002R300x300M000${id}.jpg`
        },
        duration: item.interval * 1000,
        platform: 'qq' as const,
        vip: item.pay?.payplay === 1
      }))
    }
    
    const response = await fetch(`${API_BASE}/netease/album?id=${id}`)
    const data = await response.json()
    return (data.songs || []).map((item: any) => ({
      id: item.id,
      name: item.name,
      artists: item.ar?.map((a: any) => ({ name: a.name })) || [],
      album: {
        id: data.album.id,
        name: data.album.name,
        picUrl: getProxiedImageUrl(data.album.picUrl)
      },
      duration: item.dt,
      platform: 'netease' as const,
      vip: item.fee === 1,
      noCopyright: item.noCopyrightRcmd !== null,
      fee: item.fee
    }))
  } catch (error) {
    console.error('获取专辑歌曲列表失败:', error)
    return []
  }
}

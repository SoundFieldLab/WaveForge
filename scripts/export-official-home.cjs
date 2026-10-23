#!/usr/bin/env node
// 从运行中的官方 Spotify 客户端导出官方首页 feed 数据。
// 前置：官方客户端以 --remote-debugging-port=9225 启动（数据经原生层拉取，
// xpui renderer 无 home HTTP 请求；官方 home 响应存在于 renderer 的 react-query 缓存）。
// 导出的 JSON 落到 desktop/spotify-home-snapshot.json（全部页签）与
// desktop/spotify-home-music-snapshot.json（音乐页签），供 WaveForge 桥 home_snapshot 操作读取。
// 用法：node scripts/export-official-home.cjs [cdpPort=9225]
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')

const PORT = Number(process.argv[2] || 9225)

const cdpEval = ws => expression => new Promise((resolve, reject) => {
  const id = Math.floor(Math.random() * 1e9)
  const onMsg = raw => {
    const m = JSON.parse(raw)
    if (m.id === id) {
      ws.off('message', onMsg)
      if (m.error) reject(new Error(m.error.message))
      else resolve(m.result?.result)
    }
  }
  ws.on('message', onMsg)
  ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }))
})

;(async () => {
  // 1. 找 xpui 页面
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
  const page = targets.find(t => t.type === 'page' && t.url.includes('xpui'))
  if (!page) { console.error('官方 xpui 页面未找到（先以 --remote-debugging-port 启动官方客户端）'); process.exit(1) }

  // 2. WebSocket
  const WebSocket = (await import('ws')).default
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject) })
  const evaluate = cdpEval(ws)

  // 3. 从 react fiber 找 QueryClient（官方首页数据在其缓存中）
  const grab = await evaluate(`(() => {
    const root = document.getElementById('main')
    if (!root) return JSON.stringify({ err: 'no #main' })
    const key = Object.keys(root).find(k => k.startsWith('__reactContainer'))
    let fiber = root[key]
    const seen = new Set()
    let found = null
    const visit = (node, depth) => {
      if (!node || depth > 200 || seen.has(node) || found) return
      seen.add(node)
      const v = node.memoizedProps?.value
      if (v && typeof v === 'object' && typeof v.getQueryData === 'function') { found = v; return }
      visit(node.child, depth + 1)
      visit(node.sibling, depth + 1)
    }
    visit(fiber, 0)
    if (!found) return JSON.stringify({ err: 'no queryClient（官方客户端需已打开过首页）' })
    const cache = found.getQueryCache()
    const entries = cache.getAll().filter(q => JSON.stringify(q.queryKey).includes('"home"') && q.state?.data?.data?.home?.sectionContainer)
    const exported = entries.map(q => {
      let facet = 'all'
      try { facet = JSON.parse(q.queryKey)[1]?.facet ?? 'all' } catch {}
      const sections = q.state.data.data?.home?.sectionContainer?.sections?.items ?? []
      return { facet: sections.length >= 8 ? 'all' : 'music', payload: q.state.data.data }
    })
    // 8 分区的是全部页签，其余取最多 items 的当 music
    return JSON.stringify(exported)
  })()`)
  const raw = grab.value ?? grab.description
  if (!raw || String(raw).includes('"err"')) { console.error('导出失败:', String(raw).slice(0, 200)); ws.close(); process.exit(1) }
  let entries
  try { entries = JSON.parse(raw) } catch {
    // 可能拼接了多次执行结果，取第一个完整数组
    let depth = 0, end = -1
    for (let i = 0; i < raw.length; i++) {
      if (raw[i] === '[') depth++
      else if (raw[i] === ']') { depth--; if (depth === 0) { end = i; break } }
    }
    entries = JSON.parse(raw.slice(0, end + 1))
  }
  const all = entries.find(e => (e.payload?.home?.sectionContainer?.sections?.items ?? []).length >= 8) ?? entries[0]
  const music = entries.find(e => e !== all && (e.payload?.home?.sectionContainer?.sections?.items ?? []).length > 0)
  const outDir = path.join(__dirname, '..', 'desktop')
  if (all) {
    fs.writeFileSync(path.join(outDir, 'spotify-home-snapshot.json'), JSON.stringify(all.payload, null, 1))
    console.log('已导出全部页签 snapshot（', (all.payload.home.sectionContainer.sections.items ?? []).length, '个分区）')
  }
  if (music) {
    fs.writeFileSync(path.join(outDir, 'spotify-home-music-snapshot.json'), JSON.stringify(music.payload, null, 1))
    console.log('已导出音乐页签 snapshot')
  }
  // 问候语等元信息
  const greeting = all?.payload?.home?.greeting?.transformedLabel
  if (greeting) console.log('官方问候语:', greeting)
  ws.close()
  process.exit(0)
})().catch(e => { console.error('ERR', e.message); process.exit(1) })

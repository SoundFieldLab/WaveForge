// CDP 截图工具：连接 9223，可选执行 JS、reload、截图。
// 用法：node scripts/cdp_shot.cjs <out.png> [evalFile] [--noload] [--settle ms]
const WebSocket = require('ws')
const fs = require('fs')

const args = process.argv.slice(2)
const outPng = args[0] || '.tmp-shots/shot.png'
const evalFile = args[1] && !args[1].startsWith('--') ? args[1] : null
const noload = args.includes('--noload')
const settleIdx = args.indexOf('--settle')
const settleMs = settleIdx >= 0 ? Number(args[settleIdx + 1]) : 4000

;(async () => {
  const list = await (await fetch('http://127.0.0.1:9223/json')).json()
  const page = list.find(t => t.type === 'page' && t.url.includes('127.0.0.1:3000'))
  if (!page) { console.error('no page target'); process.exit(1) }
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise(r => ws.on('open', r))
  let id = 0
  const pending = new Map()
  ws.on('message', raw => {
    const m = JSON.parse(raw)
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
  })
  const send = (method, params) => new Promise(r => {
    const mid = ++id
    pending.set(mid, r)
    ws.send(JSON.stringify({ id: mid, method, params: params || {} }))
  })
  if (evalFile) {
    const expr = fs.readFileSync(evalFile, 'utf8')
    const ev = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
    console.log('EVAL:', JSON.stringify(ev.result?.result?.value ?? ev.result?.result?.description ?? ev.result?.exceptionDetails?.exception?.description ?? '').slice(0, 1600))
  }
  if (!noload) {
    await send('Page.enable')
    await send('Page.reload', { ignoreCache: true })
    await new Promise(r => setTimeout(r, 5000))
  }
  await new Promise(r => setTimeout(r, settleMs))
  const shot = await send('Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync(outPng, Buffer.from(shot.result.data, 'base64'))
  console.log('SAVED', outPng)
  ws.close()
  process.exit(0)
})().catch(e => { console.error('ERR', e.message); process.exit(1) })

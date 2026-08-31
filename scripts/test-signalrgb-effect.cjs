'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const effectPath = path.join(__dirname, '..', 'desktop', 'assets', 'signalrgb', 'WaveForge.html')
const html = fs.readFileSync(effectPath, 'utf8')
const styles = ['spectrum-cycle','gradient-spectrum','wave','ripple','fire','rain','vu-meter','aurora','galaxy','bass-reactor','ambient','static']

assert.match(html, /<meta\s+name="title"\s+content="WaveForge"/i)
assert.match(html, /<meta\s+name="description"/i)
assert.match(html, /<meta\s+name="publisher"\s+content="WaveForge"/i)
assert.match(html, /<meta\s+name="version"/i)
for (const setting of ['style','background','sensitivity','decay','size','peakHold','gamma','brightness','speed','mirror','direction','color1','color2','color3']) {
  assert.match(html, new RegExp(`<meta\\s+property="${setting}"`, 'i'), `missing ${setting} setting`)
}
for (const style of styles) assert.ok(html.includes(style), `missing style ${style}`)
assert.doesNotMatch(html, /<script\b[^>]+src\s*=/i)
assert.doesNotMatch(html, /\b(?:fetch|WebSocket|XMLHttpRequest)\s*\(/)
assert.equal((html.match(/<canvas\b/gi) || []).length, 1)
assert.match(html, /<canvas[^>]+width="320"[^>]+height="200"/i)

const scriptMatch = /<script>([\s\S]*?)<\/script>/i.exec(html)
assert.ok(scriptMatch, 'inline effect script not found')
let drawOperations = 0
const callbacks = []
const gradient = { addColorStop() {} }
const context2d = new Proxy({}, {
  get(target, property) {
    if (property in target) return target[property]
    if (['fillRect','strokeRect','arc','lineTo','moveTo','stroke','fill','beginPath','closePath','translate','rotate','save','restore','clearRect'].includes(property)) {
      return function () { if (property === 'fillRect' || property === 'stroke' || property === 'fill') drawOperations += 1 }
    }
    if (property === 'createLinearGradient' || property === 'createRadialGradient') return () => gradient
    if (property === 'measureText') return () => ({ width: 10 })
    return 0
  },
  set(target, property, value) { target[property] = value; return true },
})
const canvas = { width: 320, height: 200, getContext: (type) => { assert.equal(type, '2d'); return context2d } }
const windowObject = {}
const sandbox = {
  window: windowObject,
  document: { getElementById: (id) => { assert.equal(id, 'waveforge'); return canvas } },
  requestAnimationFrame: (callback) => { callbacks.push(callback); return callbacks.length },
  Math,
  Number,
  String,
  Array,
  Object,
  RegExp,
}
windowObject.window = windowObject
windowObject.engine = {
  audio: {
    freq: (count) => Array.from({ length: count }, (_, index) => (Math.sin(index / 8) + 1) / 2),
    level: 0.65,
    density: 0.55,
    width: 0.75,
  },
}
sandbox.engine = windowObject.engine
vm.createContext(sandbox)
vm.runInContext(scriptMatch[1], sandbox, { filename: effectPath, timeout: 1000 })
assert.deepEqual(Array.from(windowObject.__waveforgeEffect.styles), styles)
assert.equal(typeof windowObject.onCanvasApiEvent, 'function')

for (const style of styles) {
  const before = drawOperations
  assert.equal(windowObject.onCanvasApiEvent(`style:${style}`), true)
  for (let frame = 0; frame < 4; frame += 1) {
    const callback = callbacks.shift()
    assert.equal(typeof callback, 'function', `missing animation callback for ${style}`)
    assert.doesNotThrow(callback, `style ${style} should draw without error`)
  }
  assert.ok(drawOperations > before, `style ${style} should issue drawing operations`)
}

assert.equal(windowObject.onCanvasApiEvent({ sender: 'waveforge', event: 'play' }), true)
assert.equal(windowObject.onCanvasApiEvent({ sender: 'other-app', event: 'play' }), false)
assert.equal(windowObject.onCanvasApiEvent('play'), true)
assert.equal(windowObject.onCanvasApiEvent('pause'), true)
assert.equal(windowObject.onCanvasApiEvent('stop'), true)
assert.equal(windowObject.onCanvasApiEvent('accent'), true)
assert.equal(windowObject.onCanvasApiEvent('accent:67'), true)
assert.equal(windowObject.onCanvasApiEvent('accent:101'), false)
assert.equal(windowObject.onCanvasApiEvent('beat:0'), true)
assert.equal(windowObject.onCanvasApiEvent('beat:100'), true)
assert.equal(windowObject.onCanvasApiEvent('beat:101'), false)
assert.equal(windowObject.onCanvasApiEvent('beat:-1'), false)
assert.equal(windowObject.onCanvasApiEvent('theme:00ffAA:123456'), true)
assert.equal(windowObject.onCanvasApiEvent('theme:xyz:123456'), false)
assert.equal(windowObject.onCanvasApiEvent('style:not-real'), false)
assert.equal(windowObject.onCanvasApiEvent('section:chorus'), true)
assert.equal(windowObject.onCanvasApiEvent('section:drop'), true)
assert.equal(windowObject.onCanvasApiEvent('section:../../bad'), false)
assert.equal(windowObject.onCanvasApiEvent('x'.repeat(97)), false)
assert.equal(windowObject.onCanvasApiEvent(null), false)

windowObject.engine = undefined
sandbox.engine = undefined
for (let frame = 0; frame < 3; frame += 1) {
  const callback = callbacks.shift()
  assert.doesNotThrow(callback, 'fallback audio should draw without engine')
}
assert.ok(drawOperations > 0)
console.log(`SignalRGB effect tests passed: ${styles.length} styles rendered across multiple frames with engine and fallback audio; event boundaries and self-containment validated.`)

'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const read = relative => readFileSync(path.join(root, relative), 'utf8')

test('production startup waits briefly for the compatible local API health contract', () => {
  const main = read('desktop/main.cjs')
  const health = read('server/local-api-health.mjs')
  const service = health.match(/LOCAL_API_SERVICE = '([^']+)'/)?.[1]
  const version = health.match(/LOCAL_API_PROTOCOL_VERSION = (\d+)/)?.[1]

  assert.ok(service && version)
  assert.ok(main.includes(`const LOCAL_API_SERVICE = '${service}'`))
  assert.ok(main.includes(`const LOCAL_API_PROTOCOL_VERSION = ${version}`))
  assert.match(main, /async function waitForLocalApiReady\(timeoutMs = 2500\)/)
  assert.match(main, /headers: \{ 'X-WaveForge-Local-Token': LOCAL_SERVICE_TOKEN \}/)
  assert.match(main, /await startLocalBackend\(\)/)
})

test('local-service token is injected only for WaveForge-owned window ids', () => {
  const main = read('desktop/main.cjs')

  assert.match(main, /const getTrustedWaveForgeWindowIds = \(\) => new Set\(/)
  assert.match(main, /\[mainWindow, desktopPlayerWindow, desktopLyricsWindow, taskbarWidgetWindow\]/)
  assert.match(main, /getTrustedWaveForgeWindowIds\(\)\.has\(details\.webContentsId\)/)
  assert.doesNotMatch(main, /details\.webContentsId === mainWindow\.webContents\.id/)
})

test('independent player and lyrics windows keep Chromium cache enabled', () => {
  const main = read('desktop/main.cjs')

  assert.doesNotMatch(main, /desktop-player-preload\.cjs',[\s\S]{0,160}cache:\s*false/)
  assert.doesNotMatch(main, /desktop-lyrics-preload\.cjs',[\s\S]{0,160}cache:\s*false/)
})

test('taskbar keys updates by cover identity and replaces its image only after decode', () => {
  const main = read('desktop/main.cjs')
  const widget = read('desktop/taskbar-widget.html')

  assert.match(main, /const coverUrl = song\.coverUrl \|\| ''/)
  assert.match(main, /const coverRevision = song\.coverRevision \?\? song\.coverRev \?\? song\.revision \?\? ''/)
  assert.ok(main.includes('const contentKey = `${song.name}|${coverUrl}|${coverRevision}|'))
  assert.match(widget, /if \(key === requestedCoverKey\) return/)
  assert.match(widget, /image\.decode\(\)\.then\(\(\) => \{/)
  assert.ok(widget.includes("$('cover').replaceChildren(image)"))
  assert.ok(widget.includes("updateCover(hasSong ? state.cover : '', state.coverRevision)"))
  assert.ok(!widget.includes("const coverEl = $('cover'); coverEl.innerHTML = ''"))
})

test('independent player loads canonical artwork through the shared loader', () => {
  const player = read('src/desktop-player/DesktopPlayerApp.tsx')

  assert.match(player, /function DecodedCover\(\{ url, className \}/)
  assert.match(player, /preloadArtwork\(resolvedUrl, \{ role: 'player', size: 512, priority: 'critical', retries: 1 \}\)/)
  assert.ok(player.includes("onError={() => setDisplayUrl('')}"))
  assert.ok(player.includes('<DecodedCover className="dp-bar-cover" url={cover} />'))
  assert.ok(player.includes('<DecodedCover className="dp-card-cover" url={cover} />'))
})

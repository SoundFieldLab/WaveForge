import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

describe('desktop live playback protocol', () => {
  it('propagates live state and rejects seek or queue navigation for radio', () => {
    const app = read('src/App.tsx')
    const main = read('desktop/main.cjs')
    const types = read('src/electron.d.ts')

    expect(types).toContain('live: boolean')
    expect(app).toContain("live: isLive || currentAppleRadio?.timeline === 'live'")
    expect(main).toContain("if (desktopPlayerState.live === true && (action === 'prev' || action === 'next' || action === 'seek')) return")
    expect(main).toContain("desktopPlayerState.live === true ? 0 : Number(desktopPlayerState.duration) || 0")
    expect(main).toContain("if (!hasSong || desktopPlayerState.live === true)")
  })

  it('hides taskbar and desktop-player finite controls during live playback', () => {
    const widget = read('desktop/taskbar-widget.html')
    const desktopPlayer = read('src/desktop-player/DesktopPlayerApp.tsx')

    expect(widget).toContain('body.live #prev, body.live #next, body.live #progress { display: none; }')
    expect(widget).toContain("if (state.live) return; barAction('prev')(e)")
    expect(widget).toContain("if (state.live) return; e.stopPropagation()")
    expect(desktopPlayer).toContain("state.live ? '正在直播'")
    // 直播与电台/播客（nonSkippable）都隐藏切歌：断言两者都在判断里
    expect(desktopPlayer).toContain('!state.live && !state.nonSkippable ? <button className="dp-ctrl-btn" aria-label="上一曲"')
  })
})

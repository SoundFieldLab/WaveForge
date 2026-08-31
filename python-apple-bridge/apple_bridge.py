"""
[WaveForge Apple 播放面] pywebview + WebView2 桥接服务 v2
架构：WaveForge (Electron) → HTTP → 本服务 → evaluate_js → music.apple.com MusicKit JS
音频在 WebView2 内经 MF Widevine 解密播放（Apple 接受 Edge 运行时的 CDM 证书）。

启动：python apple_bridge.py [端口] --token <随机会话令牌> [--profile <dir>] [--show]
  --token    主进程生成的会话令牌；所有 HTTP 请求必须携带
  --profile  WebView2 用户数据目录（持久化登录态；不传则用 %LOCALAPPDATA% 默认目录）
  --show     窗口可见启动（默认隐藏；登录引导由 WaveForge 设置页手动打开）

HTTP 协议（127.0.0.1，仅本机）：
  GET  /ping                 → {ok, ready}
  GET  /state                → {ready, authorized, playing, position, duration, title, artist, ended}
  GET  /spectrum             → {bins: [0..255]×64, ts}（WASAPI loopback 频谱；未启用时全零）
  POST /play   {catalogId}   → {ok, error}   setQueue + play（失败可感知）
  POST /pause /resume /stop  → {ok}
  POST /seek   {position}    → {ok}
  POST /volume {volume}      → {ok}
  POST /fade   {to, durationMs} → {ok}   音量斜坡（基础交叉淡化；绝对命令自动撞销）
  POST /show /hide           → {ok}   播放面窗口显示/隐藏
"""
import webview
import threading
import json
import time
import sys
import os
from http.server import HTTPServer, BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = 18790
PROFILE_DIR = ''
SESSION_TOKEN = ''
START_VISIBLE = False
args = sys.argv[1:]
index = 0
while index < len(args):
    arg = args[index]
    if arg.isdigit():
        PORT = int(arg)
    elif arg == '--show':
        START_VISIBLE = True
    elif arg in ('--profile', '--token') and index + 1 < len(args):
        index += 1
        if arg == '--profile':
            PROFILE_DIR = args[index]
        else:
            SESSION_TOKEN = args[index]
    index += 1
if not SESSION_TOKEN:
    raise SystemExit('missing required --token')
if not PROFILE_DIR:
    PROFILE_DIR = os.path.join(os.environ.get('LOCALAPPDATA', os.path.expanduser('~')), 'WaveForge', 'apple-bridge-profile')

APPLE_URL = 'https://music.apple.com/cn/new'
ALLOWED_ORIGINS = {
    'http://127.0.0.1:3000',
    'http://localhost:3000',
    'null',  # packaged Electron file:// renderer
}
PUBLIC_STATE_KEYS = ('ready', 'authorized', 'playing', 'status', 'position', 'duration', 'title', 'artist', 'ended')

window = None
app_state = {
    'ready': False,        # MusicKit JS 是否已初始化
    'playing': False,
    'position': 0.0,
    'duration': 0.0,
    'title': '',
    'artist': '',
    'authorized': False,
    'ended': False,        # MusicKit playbackStatus === 5（歌曲播完）
    'error': '',
}

# ── WASAPI loopback 频谱（可选：pyaudiowpatch + numpy 未装时静默禁用） ──
SPECTRUM_BINS = 64
spectrum_lock = threading.Lock()
spectrum_bins = [0] * SPECTRUM_BINS
spectrum_ts = 0.0

# 音量斜坡（交叉淡化）：fade_generation 递增使旧斜坡线程自取消；
# /volume /seek /play /stop 等绝对定位命令会 bump 代数撞销在途斜坡
fade_generation = 0
fade_generation_lock = threading.Lock()


def bump_fade_generation():
    global fade_generation
    with fade_generation_lock:
        fade_generation += 1
        return fade_generation


def fade_worker(target, duration_ms, gen):
    """MusicKit 音量线性斜坡线程（50ms 步进；代数不匹配即退出）"""
    try:
        raw = js_eval('MusicKit.getInstance().volume')
        start = float(raw) if isinstance(raw, (int, float)) else 1.0
    except Exception:
        start = 1.0
    start = min(1.0, max(0.0, start))
    target = min(1.0, max(0.0, float(target)))
    duration_ms = min(30000, max(0, int(duration_ms)))
    steps = max(1, int(duration_ms / 50))
    interval = (duration_ms / 1000.0) / steps
    for i in range(1, steps + 1):
        with fade_generation_lock:
            if gen != fade_generation:
                return
        v = start + (target - start) * i / steps
        js_eval('MusicKit.getInstance().volume = %f' % v)
        time.sleep(interval)
    print(f'[Bridge] fade {start:.2f}->{target:.2f} over {duration_ms}ms done')

try:
    import pyaudiowpatch as pyaudio
    import numpy as np
    HAS_CAPTURE = True
except Exception:
    HAS_CAPTURE = False


def js_eval(code):
    """在 WebView2 里执行 JS 并返回结果（WebView2 的 ExecuteScript 会等待 Promise）"""
    if window is None:
        return None
    try:
        return window.evaluate_js(code)
    except Exception as e:
        print(f'[Bridge] JS eval error: {e}')
        return None


def poll_state():
    """定期从 WebView2 读取 MusicKit 播放状态（0.3s，渲染端 200ms 轮询在此之上取缓存）"""
    evt_idx = 0
    prev_pos = 0.0
    still = 0
    while True:
        time.sleep(0.3)
        # 增量打捞页面事件（授权变化/播放错误等）到事件缓冲（GET /events 可读）
        try:
            raw = js_eval('JSON.stringify((window.__wfEvt || []).length)')
            n = int(raw) if isinstance(raw, (int, str)) and str(raw).isdigit() else 0
            while evt_idx < n:
                line = js_eval(f'window.__wfEvt[{evt_idx}] || ""')
                if line:
                    app_state.setdefault('events', []).append(line)
                    if len(app_state['events']) > 200:
                        del app_state['events'][:-200]
                    evt_idx = len(app_state['events'])
                else:
                    evt_idx += 1
        except Exception:
            pass
        if window is None:
            continue
        try:
            state = js_eval('''JSON.stringify((function () {
                try {
                    // 禁用 WebAuthn（通行密钥）：Apple 登录页自动触发 Win11 系统通行密钥弹窗，
                    // 幂等注入 stub 立即 NotAllowedError，页面回落密码登录（轮询自愈覆盖页内导航）
                    var wc = window.navigator && window.navigator.credentials;
                    if (wc && !wc.__wfWebAuthnBlocked) {
                        var reject = function () { return Promise.reject(new DOMException('WebAuthn disabled', 'NotAllowedError')); };
                        Object.defineProperty(window.navigator, 'credentials', {
                            value: { __wfWebAuthnBlocked: true, get: reject, create: reject },
                            configurable: true,
                        });
                    }
                } catch (e) {}
                try {
                    if (typeof MusicKit === 'undefined') return {ready:false};
                    const inst = MusicKit.getInstance();
                    const item = inst.nowPlayingItem;
                    return {
                        ready: true,
                        authorized: inst.isAuthorized,
                        status: inst.playbackStatus,
                        position: inst.currentPlaybackTime || 0,
                        duration: item && item.playbackDuration ? item.playbackDuration/1000 : 0,
                        title: item ? (item.title || item.attributes && item.attributes.name || '') : '',
                        artist: item ? (item.artistName || item.attributes && item.attributes.artistName || '') : '',
                    };
                } catch(e) { return {ready:false, error:String(e)}; }
            })())''')
            if state:
                s = json.loads(state)
                if s.get('ready'):
                    status = int(s.get('status', 0) or 0)
                    pos = float(s.get('position', 0) or 0)
                    # 位置位移兜底：实测 MusicKit 实例在 stop/play 异常时序后 playbackStatus
                    # 会与真实播放脱钩（恒读 0 而音频在走）。位置量化为整秒会抖动，
                    # 用「静止计数器」平滑：连续 4 次采样（~1.5s）位置不动才算暂停
                    if pos != prev_pos:
                        still = 0
                    else:
                        still += 1
                    prev_pos = pos
                    playing_est = (status == 2) or (status in (1, 6, 8)) or (
                        status not in (3, 4, 5) and still < 4 and pos > 0
                    )
                    with_state = {
                        'ready': True,
                        'authorized': bool(s.get('authorized', False)),
                        'playing': bool(playing_est),
                        # 原始状态码（渲染端映射瞬态：1 loading / 6 seeking / 8 waiting 视为播放中）
                        'status': status,
                        'position': pos,
                        'duration': float(s.get('duration', 0) or 0),
                        'title': s.get('title', '') or '',
                        'artist': s.get('artist', '') or '',
                        # 5 = ended；seek/play 后由 MusicKit 状态自然切走
                        'ended': status == 5,
                        'error': '',
                    }
                    app_state.update(with_state)
        except Exception:
            pass


def capture_spectrum():
    """WASAPI loopback 采集系统混音 → FFT → 64 bin 对数频谱（0-255，含平滑）"""
    global spectrum_ts
    try:
        p = pyaudio.PyAudio()
    except Exception as e:
        print(f'[Bridge] PyAudio 初始化失败，频谱禁用: {e}')
        return
    try:
        try:
            device = p.get_default_wasapi_loopback()
        except Exception:
            device = None
            for loopback in p.get_loopback_device_info_generator():
                device = loopback  # 取最后一个可用 loopback 兜底
                break
        if device is None:
            print('[Bridge] 未找到 WASAPI loopback 设备，频谱禁用')
            return

        channels = int(device.get('maxInputChannels') or 2)
        rate = int(device.get('defaultSampleRate') or 48000)
        N = 4096
        HOP = 2048
        F_MIN, F_MAX = 40.0, 16000.0
        # 对数分 bin 的边缘（频率 → FFT bin 下标）
        freqs = np.fft.rfftfreq(N, 1.0 / rate)
        edges = np.searchsorted(freqs, np.geomspace(F_MIN, F_MAX, SPECTRUM_BINS + 1))
        edges = np.clip(edges, 0, len(freqs) - 1)
        win = np.hanning(N)
        last = {'buf': np.zeros(0, dtype=np.float32), 'prev': np.zeros(SPECTRUM_BINS)}

        def compute(mono_block):
            spec = np.abs(np.fft.rfft(mono_block * win)) / (N / 4)
            raw = np.zeros(SPECTRUM_BINS)
            for b in range(SPECTRUM_BINS):
                lo, hi = edges[b], max(edges[b] + 1, edges[b + 1])
                if lo < len(spec):
                    raw[b] = float(np.sqrt(np.mean(spec[lo:hi] ** 2)) if hi > lo else 0.0)
            raw = np.clip(raw * 6.0, 0, 1) ** 0.6          # 压缩动态范围
            prev = last['prev']
            # 快攻击慢释放，视觉平滑
            smoothed = np.where(raw > prev, prev + (raw - prev) * 0.7, prev + (raw - prev) * 0.22)
            last['prev'] = smoothed
            return (smoothed * 255).astype(int).tolist()

        def callback(in_data, frame_count, time_info, status_flags):
            samples = np.frombuffer(in_data, dtype=np.int16).reshape(-1, channels)
            mono = samples.astype(np.float32).mean(axis=1) / 32768.0
            buf = np.concatenate([last['buf'], mono])
            while len(buf) >= N:
                bins = compute(buf[:N])
                with spectrum_lock:
                    spectrum_bins[:] = bins
                    globals()['spectrum_ts'] = time.time()
                buf = buf[HOP:]
            last['buf'] = buf[-N:]
            return (None, pyaudio.paContinue)

        print(f'[Bridge] WASAPI 频谱采集启动: {device.get("name")} ({rate}Hz x{channels})')
        stream = p.open(
            format=pyaudio.paInt16, channels=channels, rate=rate,
            input=True, input_device_index=int(device['index']),
            frames_per_buffer=1024, stream_callback=callback,
        )
        while stream.is_active():
            time.sleep(0.2)
    except Exception as e:
        print(f'[Bridge] 频谱采集退出: {e}')
    finally:
        try:
            p.terminate()
        except Exception:
            pass


class BridgeHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        pass  # 静默日志

    def _request_allowed(self):
        origin = self.headers.get('Origin')
        if origin and origin not in ALLOWED_ORIGINS:
            return False
        return self.headers.get('X-WaveForge-Bridge-Token', '') == SESSION_TOKEN

    def _json(self, data, status=200):
        try:
            self.send_response(status)
            self.send_header('Content-Type', 'application/json')
            origin = self.headers.get('Origin')
            if origin in ALLOWED_ORIGINS:
                self.send_header('Access-Control-Allow-Origin', origin)
                self.send_header('Vary', 'Origin')
            self.send_header('Access-Control-Allow-Headers', 'Content-Type, X-WaveForge-Bridge-Token')
            self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
            self.end_headers()
            self.wfile.write(json.dumps(data).encode('utf-8'))
        except (ConnectionAbortedError, ConnectionResetError, BrokenPipeError):
            try:
                self.wfile.close()
            except Exception:
                pass

    def do_OPTIONS(self):
        origin = self.headers.get('Origin')
        if origin and origin not in ALLOWED_ORIGINS:
            self._json({'error': 'origin not allowed'}, 403)
            return
        self._json({})

    def do_GET(self):
        if not self._request_allowed():
            self._json({'error': 'unauthorized'}, 403)
            return
        if self.path == '/state':
            self._json({key: app_state.get(key) for key in PUBLIC_STATE_KEYS})
        elif self.path == '/ping':
            self._json({'ok': True, 'ready': app_state['ready']})
        elif self.path == '/spectrum':
            with spectrum_lock:
                self._json({'bins': list(spectrum_bins), 'ts': spectrum_ts, 'enabled': HAS_CAPTURE})
        else:
            self._json({'error': 'not found'}, 404)

    def do_POST(self):
        if not self._request_allowed():
            self._json({'error': 'unauthorized'}, 403)
            return
        content_len = int(self.headers.get('Content-Length', 0))
        body = {}
        if content_len:
            try:
                body = json.loads(self.rfile.read(content_len))
            except Exception:
                pass

        if self.path == '/play':
            song_id = str(body.get('catalogId', '') or '')
            if not song_id or not song_id.isdigit():
                self._json({'ok': False, 'error': 'missing or invalid catalogId'}, 400)
                return
            bump_fade_generation()  # 换歌撞销上一首的在途斜坡
            # 注意：WebView2 ExecuteScript 不等待 Promise——async IIFE 的返回值恒为空 {}，
            # 成败不能用返回载荷判定（v2 初版在此误判成功为失败）。改为「发起后轮询
            # MusicKit 播放状态」：status 进入 loading/playing 或拿到时长 = 成功；
            # setQueue/play 抛错写入 window.__wfPlayError = 快速失败。
            js_eval('window.__wfPlayError = null')
            js = '''
                (async () => {
                    try {
                        if (typeof MusicKit === 'undefined') { window.__wfPlayError = 'no musickit'; return; }
                        const inst = MusicKit.getInstance();
                        await inst.setQueue({ songs: [%s] });
                        await inst.play();
                    } catch (e) { window.__wfPlayError = String(e && (e.message || e)); }
                })()
            ''' % json.dumps(song_id)
            js_eval(js)
            ok, detail = False, 'timeout'
            for _ in range(14):  # 最多 ~7 秒
                time.sleep(0.5)
                raw = js_eval('''JSON.stringify((function () {
                    try {
                        var inst = MusicKit.getInstance();
                        var item = inst.nowPlayingItem;
                        return { status: inst.playbackStatus, dur: (item && item.playbackDuration ? item.playbackDuration / 1000 : 0), err: window.__wfPlayError };
                    } catch (e) { return { status: -1, err: String(e) }; }
                })())''')
                s = None
                try:
                    s = json.loads(raw) if isinstance(raw, str) else (raw if isinstance(raw, dict) else None)
                except Exception:
                    s = None
                if not s:
                    continue
                if s.get('err'):
                    ok, detail = False, str(s['err'])[:160]
                    break
                if s.get('status') in (1, 2) or (s.get('dur') or 0) > 0:
                    ok, detail = True, ''
                    break
            app_state['error'] = detail
            if ok:
                app_state.update({'ended': False, 'position': 0.0})
            print(f'[Bridge] play {song_id} → {"ok" if ok else "failed"}')
            self._json({'ok': ok, 'error': '' if ok else 'playback failed'})

        elif self.path == '/pause':
            js_eval('MusicKit.getInstance().pause()')
            self._json({'ok': True})

        elif self.path == '/resume':
            js_eval('MusicKit.getInstance().play()')
            self._json({'ok': True})

        elif self.path == '/stop':
            bump_fade_generation()
            js_eval('MusicKit.getInstance().stop()')
            self._json({'ok': True})

        elif self.path == '/seek':
            try:
                pos = float(body.get('position', 0))
            except Exception:
                pos = 0.0
            bump_fade_generation()  # 绝对定位撞销在途斜坡
            js_eval('MusicKit.getInstance().seekToTime(%f)' % max(0.0, pos))
            app_state['ended'] = False
            self._json({'ok': True})

        elif self.path == '/volume':
            try:
                vol = min(1.0, max(0.0, float(body.get('volume', 1.0))))
            except Exception:
                vol = 1.0
            bump_fade_generation()  # 绝对音量撞销在途斜坡
            js_eval('MusicKit.getInstance().volume = %f' % vol)
            self._json({'ok': True})

        elif self.path == '/fade':
            # 音量斜坡（基础交叉淡化）：{to, durationMs}
            try:
                to = min(1.0, max(0.0, float(body.get('to', body.get('volume', 1.0)))))
                duration_ms = int(float(body.get('durationMs', 0)))
            except Exception:
                self._json({'ok': False, 'error': 'invalid fade params'}, 400)
                return
            gen = bump_fade_generation()
            threading.Thread(target=fade_worker, args=(to, duration_ms, gen), daemon=True).start()
            self._json({'ok': True})

        elif self.path == '/show':
            try:
                if window is not None:
                    window.show()
            except Exception as e:
                print(f'[Bridge] show failed: {e}')
            self._json({'ok': True})

        elif self.path == '/hide':
            try:
                if window is not None:
                    window.hide()
            except Exception as e:
                print(f'[Bridge] hide failed: {e}')
            self._json({'ok': True})

        else:
            self._json({'error': 'not found'}, 404)


def on_window_loaded():
    """窗口加载完成后的回调"""
    print('[Bridge] Apple Music 页面已加载')
    time.sleep(3)
    ready = js_eval('typeof MusicKit !== "undefined"')
    print(f'[Bridge] MusicKit JS available: {ready}')
    app_state['ready'] = bool(ready)
    # 事件监听：授权变化/播放状态/播放错误 → window.__wfEvt（poll_state 增量打捞到日志）
    js_eval('''(function () {
        try {
            if (typeof MusicKit === 'undefined' || window.__wfEvtInstalled) return;
            window.__wfEvt = [];
            window.__wfEvtInstalled = true;
            var inst = MusicKit.getInstance();
            var push = function (m) { try { window.__wfEvt.push(m + ' @' + new Date().toISOString().slice(11, 19)); } catch (e) {} };
            inst.addEventListener('playbackStateDidChange', function (e) { push('state=' + e.state); });
            inst.addEventListener('authorizationStatusDidChange', function (e) { push('auth=' + (e.authorizationStatus !== undefined ? e.authorizationStatus : 'change')); });
            inst.addEventListener('playbackError', function (e) { push('playbackError=' + JSON.stringify(e).slice(0, 140)); });
            inst.addEventListener('mediaElementError', function (e) { push('mediaError=' + JSON.stringify(e).slice(0, 140)); });
        } catch (e) {}
    })()''')


def start_http_server():
    # ThreadingHTTPServer：渲染端 200ms 轮询 + 频谱轮询并发，单线程会排队阻塞
    server = ThreadingHTTPServer(('127.0.0.1', PORT), BridgeHandler)
    print(f'[Bridge] HTTP 控制服务已启动: http://127.0.0.1:{PORT}')
    server.serve_forever()


if __name__ == '__main__':
    print(f'[Bridge] Apple 播放面桥接服务 v2 启动 (port={PORT}, visible={START_VISIBLE})')
    print(f'[Bridge] profile: {PROFILE_DIR}')
    print(f'[Bridge] 频谱采集: {"启用" if HAS_CAPTURE else "未安装 pyaudiowpatch/numpy，禁用"}')

    # Apple 全域走直连（系统代理对 Apple CDN 的 TLS 干扰实测会卡死播放）：
    # WebView2 读取该环境变量追加浏览器参数；setdefault 尊重外部已有配置
    os.environ.setdefault(
        'WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS',
        '--proxy-bypass-list="<-loopback>;*.apple.com;*.mzstatic.com;*.itunes.apple.com;*.cdn-apple.com;*.icloud.com"',
    )

    http_thread = threading.Thread(target=start_http_server, daemon=True)
    http_thread.start()

    if HAS_CAPTURE:
        threading.Thread(target=capture_spectrum, daemon=True).start()

    window = webview.create_window(
        title='WaveForge Apple 播放面',
        url=APPLE_URL,
        width=420,
        height=700,
        js_api=None,
        hidden=not START_VISIBLE,
    )
    window.events.loaded += on_window_loaded

    poll_thread = threading.Thread(target=poll_state, daemon=True)
    poll_thread.start()

    try:
        webview.start(private_mode=False, storage_path=PROFILE_DIR)
    except TypeError:
        # 旧版 pywebview 无这些参数
        webview.start()
    print('[Bridge] WebView 已退出，进程结束')

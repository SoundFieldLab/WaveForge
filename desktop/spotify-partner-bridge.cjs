'use strict';

// desktop/spotify-partner-bridge.cjs
// WaveForge 原创实现 —— Spotify 桌面端内部数据接口（api-partner.spotify.com）桥。
//
// 实现依据的是 Spotify 桌面客户端自身使用的**公开可观测网络协议**（接口地址、
// 预注册 GraphQL persisted-query 哈希、请求/响应字段形态均为接口事实，非任何
// 第三方项目的创作表达）。本文件为独立编写，结构与命名均为本项目原创；
// 未复制、翻译或改编任何第三方项目的源代码。
//
// 为什么不用官方 Web API（api.spotify.com）：WaveForge 借用 Spotify Web Player 的
// 公共 client_id 调 Web API，该 id 的限流池由所有借用者共享，近期被 429 占满
// （真机 2026-10-20 实测 browse/search/me 全 429，首页与歌单全空）。桌面端内部
// 接口不在 Web API 限流体系内。
//
// 能力：PKCE loopback 登录、token 自动续期、safeStorage 加密会话仓、
// GraphQL persisted-query 调用（白名单见 GRAPH_QUERY_HASHES）、行级歌词
// （spclient color-lyrics）、OAuth 会话播种（seed_session）。
// 上游接口随 Spotify 客户端版本演进，哈希失效时按报错里的名称更新本表即可。

const crypto = require('node:crypto');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

// ── 接口常量（均为 Spotify 服务端事实）───────────────────────────
const QUERY_ENDPOINT = 'https://api-partner.spotify.com/pathfinder/v2/query';
const LYRICS_ENDPOINT = 'https://spclient.wg.spotify.com';
const SPOTIFY_OAUTH_CLIENT_ID = '65b708073fc0480ea92a077233ca87bd'; // Spotify Web Player 公共 client
const OAUTH_AUTHORIZE_URL = 'https://accounts.spotify.com/authorize';
const OAUTH_TOKEN_URL = 'https://accounts.spotify.com/api/token';
// spotifyd 公开 client 在 Dashboard 注册的回调固定为 127.0.0.1:8000/login
const LOOPBACK_PORT = 5678; // folia 共存安装用 5588，本项目错开
const LOOPBACK_PATH = '/login';
const LOOPBACK_REDIRECT = `http://127.0.0.1:${LOOPBACK_PORT}${LOOPBACK_PATH}`;

// 预注册查询哈希表（Spotify 服务端按名寻址；上游换版时报错会点名，按名更新）
const GRAPH_QUERY_HASHES = Object.freeze({
  // home/homeSection/homePinnedSections 三操作共用一个 persisted hash（官方桌面 xpui 模块 65250，
  // 从官方客户端 xpui.spa 解包逆向得到；2026-10-23 实测）
  home: '5fb7da7a03ee2776c0670856609cb85a189a3cecc36cc160b91cde79063b9cf1',
  homeSection: '5fb7da7a03ee2776c0670856609cb85a189a3cecc36cc160b91cde79063b9cf1',
  homePinnedSections: '5fb7da7a03ee2776c0670856609cb85a189a3cecc36cc160b91cde79063b9cf1',
  // 官方 xpui 逆向的扩展查询（搜索分区/浏览页/艺人目录/制作人员等）
  searchDesktop: 'eef7cc54888d91bdd6802623477873caa3948ae173a0c34fd86827b267e94c03',
  searchTopResultsList: 'dd78eaff943eba629ed70ee25517b9cea0dcaa41193e2592ae2727660b21892c',
  searchPlaylists: 'd520014e748f9ea44f7707d8df1819867ac1205e8b7f3e28f22fe5fc858921b1',
  searchAlbums: '202cb3305e31e5a0767ba7925f28bd728cf8f8b0217e6da43909056071cd70e9',
  searchArtists: '7bf95d754fdbe32c8b161fbbe54d1ae50974900df4dce4c8f1afcbcad153224d',
  browseAll: 'dbd8b55e09a58afc52eab438bc228ba28fd72ac2f2148c6c26354980e4579001',
  browseSection: 'b13c1cccbfcb6947753c2613411b3566485c21fd5f36d80a80bb64be61ba2d51',
  playlistSection: '2615df403a9043c1d7d3094fbeb4c9653b07b11a33d8081fbd31f0f7959ff4a1',
  queryArtistDiscographyOverview: '5e07d323febb57b4a56a42abbf781490e58764aa45feb6e3dc0591564fc56599',
  queryArtistDiscographyAlbums: '5e07d323febb57b4a56a42abbf781490e58764aa45feb6e3dc0591564fc56599',
  queryArtistDiscographySingles: '5e07d323febb57b4a56a42abbf781490e58764aa45feb6e3dc0591564fc56599',
  queryTrackCreditsGroupedModal: 'f135fb9be58a72d041ab5d214d817021a272405d883860468e2627afb01a3ca9',
  queryArtistPlaylists: '54f7e5a5a2af05b7dc98526df376a46c6b15c05440c8dfdc8f6cecb1a807eca7',
  queryArtistDiscoveredOn: '71c2392e4cecf6b48b9ad1311ae08838cbdabcfd189c6bf0c66c2430b8dcfdb1',
  queryArtistFeaturing: '20842d6d9d2d28ef945984b68cb927bb33edd00eab84a8da1667def21f1f2c54',
  queryArtistAboutModal: '702e29a866e0b4b4fabdf974454512a2c32d93643b1969b7a3a0dd92084f05f6',
  queryArtistRelated: '3d031d6cb22a2aa7c8d203d49b49df731f58b1e2799cc38d9876d58771aa66f3',
  getAlbumNameAndTracks: '8628ad33de3267d7bef516c76a746979a5f98891a2c9eaff3dfec828abdcd983',
  getArtistNameAndTracks: '0adaf1a1a8a94c7ed095639c4d9456d2b1cfac16ac511d5dd2b01b6dd89f748a',
  browsePage: 'f5c4e6d668f5716464a231c1cc8b22c1cbf6ad68b09929fd7de813a30581298b',
  queryWhatsNewFeed: '3b53dede3c6054e8b7c962dd280eb6761c5d1c82b06b039f4110d76a62b4966b',
  profileAttributes: '53bcb064f6cd18c23f752bc324a791194d20df612d8e1239c735144ab0399ced',
  libraryV3: '390c78e5b951029bad359785e69b07b536a509c581cbcd0aded5e5067f187455',
  fetchLibraryTracks: '087278b20b743578a6262c2b0b4bcd20d879c503cc359a2285baf083ef944240',
  fetchPlaylist: 'cd2275433b29f7316176e7b5b5e098ae7744724e1a52d63549c76636b3257749',
  getAlbum: 'b9bfabef66ed756e5e13f68a942deb60bd4125ec1f1be8cc42769dc0259b4b10',
  queryArtistOverview: '7f86ff63e38c24973a2842b672abe44c910c1973978dc8a4a0cb648edef34527',
  queryArtistDiscographyAll: '5e07d323febb57b4a56a42abbf781490e58764aa45feb6e3dc0591564fc56599',
  searchTracks: 'bc1ca2fcd0ba1013a0fc88e6cc4f190af501851e3dafd3e1ef85840297694428',
  getTrack: '612585ae06ba435ad26369870deaae23b5c8800a256cd8a57e08eddc25a37294',
  areEntitiesInLibrary: '134337999233cc6fdd6b1e6dbf94841409f04a946c5c7b744b09ba0dfe5a85ed',
});

// 授权范围（桌面端数据读取所需；playlist-modify 系供后续写操作扩展）
const OAUTH_SCOPES = [
  'app-remote-control', 'playlist-modify', 'playlist-modify-private', 'playlist-modify-public', 'playlist-read',
  'playlist-read-collaborative', 'playlist-read-private', 'streaming', 'ugc-image-upload', 'user-follow-modify',
  'user-follow-read', 'user-library-modify', 'user-library-read', 'user-modify', 'user-modify-playback-state',
  'user-modify-private', 'user-personalized', 'user-read-birthdate', 'user-read-currently-playing', 'user-read-email',
  'user-read-play-history', 'user-read-playback-position', 'user-read-playback-state', 'user-read-private',
  'user-read-recently-played', 'user-top-read',
].join(' ');

const SESSION_STORE_KEY = 'SPOTIFY_PARTNER_SESSION_V1';
const TRACK_ID_PATTERN = /^[0-9A-Za-z]{22}$/;
const PLAYLIST_URI_PREFIX = 'spotify:playlist:';
const PLAYLIST_URI_PATTERN = /^spotify:playlist:[0-9A-Za-z]{22}$/;
const LIBRARY_URI_PATTERN = /^spotify:(track|album|playlist):[0-9A-Za-z]{22}$/;
// 歌单整读翻页参数：每次 500 行、最多 40 页（上游每页行数不定，按返回行数续读）
const PLAYLIST_READ_PAGE = 500;
const PLAYLIST_READ_MAX_OFFSET = PLAYLIST_READ_PAGE * 40;
// Spotify 歌单名上限与单次变更曲目上限（服务端约束）
const MAX_PLAYLIST_NAME_LENGTH = 100;
const MAX_PLAYLIST_MUTATION_ROWS = 100;
// 写变更哈希（Spotify 预注册；上游换版时报错点名，按名更新）
const GRAPH_CHANGE_HASHES = Object.freeze({
  addToLibrary: '896ebcb47815681340860d121cb5d494e157e2a78d3950385cd54e0393c67148',
  removeFromLibrary: '896ebcb47815681340860d121cb5d494e157e2a78d3950385cd54e0393c67148',
  addItemsToRootlist: 'bd9c5cae1ee80ebca05d7ed12fd394216f49a20ce72d9dc762868df0f14522ea',
  removeItemsFromRootlist: '3422f1866532820a1d8d0560f88542dbdbd35d0377ee5ecd49593590f5f1e86b',
  addToPlaylist: '47b2a1234b17748d332dd0431534f22450e9ecbb3d5ddcdacbd83368636a0990',
  removeFromPlaylist: '47b2a1234b17748d332dd0431534f22450e9ecbb3d5ddcdacbd83368636a0990',
});
// 提前续期余量：距过期不足 60s 即视为需要刷新
const TOKEN_RENEW_MARGIN_MS = 60 * 1000;
const HTTP_TIMEOUT_MS = 30 * 1000;
// 账号摘要（会员档）复读周期
const ACCOUNT_PROFILE_TTL_MS = 10 * 60 * 1000;
// 登录尝试窗口：loopback 服务器最多等这么久
const LOGIN_ATTEMPT_WINDOW_MS = 10 * 60 * 1000;

const toBase64Url = buffer => buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

class PartnerApiError extends Error {
  constructor(code, message, upstreamDetail) {
    super(message);
    this.code = code;
    this.upstreamDetail = upstreamDetail;
  }
}

// ── 会话仓（主进程 safeStorage 加密落盘；渲染层只拿账号摘要）─────────
function createSessionStore({ store, safeStorage, warn }) {
  let hydrated = false;
  let session = null;
  const encryptionAvailable = () =>
    Boolean(safeStorage?.isEncryptionAvailable()) && safeStorage.getSelectedStorageBackend?.() !== 'basic_text';
  const writeThrough = () => {
    try {
      if (!encryptionAvailable()) throw new Error('os-encryption-unavailable');
      store.set(SESSION_STORE_KEY, safeStorage.encryptString(JSON.stringify(session)).toString('base64'));
    } catch {
      // OS 加密不可用（Linux 无 keychain 等）：宁可会话不落盘也不写明文凭据
      store.delete(SESSION_STORE_KEY);
      warn('[SpotifyPartner] 会话仅本次运行有效：OS 加密不可用');
    }
  };
  return {
    read() {
      if (hydrated) return session;
      hydrated = true;
      try {
        const sealed = store.get(SESSION_STORE_KEY);
        if (typeof sealed !== 'string') return null;
        const parsed = JSON.parse(safeStorage.decryptString(Buffer.from(sealed, 'base64')));
        if (parsed?.version === 1 && parsed.credentials?.access_token && parsed.credentials?.refresh_token) {
          session = parsed;
        }
      } catch { /* 密文损坏或被其他系统账号封印：按无会话处理 */ }
      return session;
    },
    write(next) {
      hydrated = true;
      session = { version: 1, credentials: { ...next.credentials }, user: { ...next.user } };
      writeThrough();
    },
    patch(partial) {
      if (!this.read()) return;
      if (partial.credentials) session.credentials = { ...session.credentials, ...partial.credentials };
      if (partial.user) session.user = { ...session.user, ...partial.user };
      writeThrough();
    },
    erase() {
      hydrated = true;
      session = null;
      store.delete(SESSION_STORE_KEY);
    },
  };
}

// ── PKCE 登录（loopback 回调收授权码）──────────────────────────
function createLoginAttemptManager({ fetchImpl, warn, shellOpen }) {
  let attempt = null;

  const exchangeCode = async (fields, keepRefreshToken) => {
    const response = await fetchImpl(OAUTH_TOKEN_URL, {
      method: 'POST',
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: SPOTIFY_OAUTH_CLIENT_ID, ...fields }).toString(),
    });
    const payload = await response.json().catch(() => null);
    if (payload?.error === 'invalid_grant') {
      throw new PartnerApiError('auth-required', 'Spotify 已不再接受本次登录');
    }
    const refreshToken = payload?.refresh_token ?? keepRefreshToken;
    if (!response.ok || typeof payload?.access_token !== 'string' || typeof refreshToken !== 'string') {
      throw new PartnerApiError('invalid-response', `Spotify 未签发 token（HTTP ${response.status}）`);
    }
    return {
      access_token: payload.access_token,
      refresh_token: refreshToken,
      expires_at: Date.now() + Math.max(60, Number(payload.expires_in) || 3600) * 1000,
    };
  };

  const teardown = (running) => {
    clearTimeout(running.timer);
    running.server.close();
    running.server.closeAllConnections?.();
  };
  const discard = () => {
    if (attempt) teardown(attempt);
    attempt = null;
  };

  const handleCallback = (running, request, response) => {
    let callbackUrl = null;
    try { callbackUrl = new URL(request.url, LOOPBACK_REDIRECT); } catch { /* 非 URL 请求按 404 处理 */ }
    if (!callbackUrl || request.method !== 'GET' || callbackUrl.pathname !== LOOPBACK_PATH) {
      response.writeHead(404).end();
      return;
    }
    const page = text => '<!doctype html><meta charset="utf-8"><title>WaveForge</title>'
      + `<body style="margin:0;display:grid;place-items:center;height:100vh;background:#121212;color:#fff;font:16px system-ui,sans-serif">${text}</body>`;
    if (callbackUrl.searchParams.get('state') !== running.state) {
      response.writeHead(200).end(page('登录会话已过期，请回到 WaveForge 重新发起。'));
      return;
    }
    if (running.finishing) {
      response.writeHead(404).end();
      return;
    }
    running.finishing = true;
    const code = callbackUrl.searchParams.get('code');
    if (!code) {
      warn('[SpotifyPartner] 登录未完成：' + (callbackUrl.searchParams.get('error') || 'unknown'));
      response.writeHead(200).end(page('登录未完成，请回到 WaveForge 重试。'));
      running.outcome = { failed: true };
      return;
    }
    exchangeCode({ grant_type: 'authorization_code', code, redirect_uri: LOOPBACK_REDIRECT, code_verifier: running.verifier })
      .then(issued => {
        response.writeHead(200).end(page('已登录 Spotify，可以回到 WaveForge。'));
        running.outcome = { issued };
      })
      .catch(error => {
        warn('[SpotifyPartner] 授权码交换失败: ' + error.message);
        response.writeHead(200).end(page('登录未完成，请回到 WaveForge 重试。'));
        running.outcome = { failed: true };
      });
  };

  return {
    async begin() {
      discard();
      const verifier = toBase64Url(crypto.randomBytes(64));
      const state = toBase64Url(crypto.randomBytes(16));
      const server = http.createServer();
      const running = {
        verifier, state, server,
        windowEndsAt: Date.now() + LOGIN_ATTEMPT_WINDOW_MS,
        outcome: null, finishing: false, timer: null,
      };
      running.authorizeUrl = `${OAUTH_AUTHORIZE_URL}?${new URLSearchParams({
        response_type: 'code',
        client_id: SPOTIFY_OAUTH_CLIENT_ID,
        redirect_uri: LOOPBACK_REDIRECT,
        scope: OAUTH_SCOPES,
        code_challenge_method: 'S256',
        code_challenge: toBase64Url(crypto.createHash('sha256').update(verifier).digest()),
        state,
      })}`;
      server.on('request', (request, response) => handleCallback(running, request, response));
      await new Promise((resolve, reject) => {
        server.once('error', error => reject(new PartnerApiError('unavailable', 'loopback 监听失败: ' + error.code)));
        server.listen(LOOPBACK_PORT, '127.0.0.1', resolve);
      });
      running.timer = setTimeout(() => teardown(running), LOGIN_ATTEMPT_WINDOW_MS);
      running.timer.unref?.();
      attempt = running;
      return { authorizeUrl: running.authorizeUrl, windowMs: LOGIN_ATTEMPT_WINDOW_MS };
    },
    async openInBrowser() {
      if (!attempt || attempt.outcome) return false;
      await shellOpen(attempt.authorizeUrl);
      return true;
    },
    poll() {
      if (!attempt) return { state: 'expired' };
      if (attempt.outcome?.issued) return { state: 'approved', tokens: attempt.outcome.issued };
      if (attempt.outcome) { discard(); return { state: 'error' }; }
      if (Date.now() >= attempt.windowEndsAt) { discard(); return { state: 'expired' }; }
      return { state: 'waiting' };
    },
    complete() { discard(); },
    abort() { discard(); },
    /** 用已有 refresh token 换新（会话续期共用） */
    renew: (refreshToken) => exchangeCode({ grant_type: 'refresh_token', refresh_token: refreshToken }, refreshToken),
    /** 当前是否有正在进行的登录尝试 */
    hasPending() { return Boolean(attempt); },
  };
}

// ── 桥本体 ───────────────────────────────────────────────
function createSpotifyPartnerBridge({ store, safeStorage, fetch: fetchImpl = fetch, log = (...a) => console.log(...a), warn = (...a) => console.warn(...a) } = {}) {
  const sessions = createSessionStore({ store, safeStorage, warn });
  const loginManager = createLoginAttemptManager({
    fetchImpl,
    warn,
    shellOpen: url => require('electron').shell.openExternal(url),
  });
  let tokenRenewal = null;
  let profileTask = null;
  let profileReadAt = 0;

  // 用 refresh token 换新 access token；上游明确撤销时清会话
  const renewAccessToken = session => {
    const refreshToken = session.credentials.refresh_token;
    if (tokenRenewal?.refreshToken === refreshToken) return tokenRenewal.promise;
    const promise = loginManager.renew(refreshToken).then(credentials => {
      if (sessions.read()?.credentials.refresh_token === refreshToken) {
        sessions.patch({ credentials });
        log(`[SpotifyPartner] token 已续期（${Math.round((credentials.expires_at - Date.now()) / 1000)}s）`);
      }
      return credentials.access_token;
    }, error => {
      if (error instanceof PartnerApiError && error.code === 'auth-required' && sessions.read()?.credentials.refresh_token === refreshToken) {
        sessions.erase();
        warn('[SpotifyPartner] 存储的登录已被 Spotify 撤销，已清除');
      }
      throw error;
    }).finally(() => {
      if (tokenRenewal?.promise === promise) tokenRenewal = null;
    });
    tokenRenewal = { refreshToken, promise };
    return promise;
  };

  const currentAccessToken = async (forceRenew = false) => {
    const session = sessions.read();
    if (!session) throw new PartnerApiError('auth-required', '需要先登录 Spotify');
    if (!forceRenew && session.credentials.expires_at - Date.now() > TOKEN_RENEW_MARGIN_MS) {
      return session.credentials.access_token;
    }
    return renewAccessToken(session);
  };

  const authorizedRequest = async (url, { bearer, emptyOk, ...init } = {}) => {
    const send = async token => fetchImpl(url, {
      ...init,
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      headers: { Accept: 'application/json', ...init.headers, Authorization: `Bearer ${token}` },
    });
    let response = await send(bearer ?? await currentAccessToken());
    if (response.status === 401 && !bearer) response = await send(await currentAccessToken(true));
    if (response.status === 404 && emptyOk !== undefined) return emptyOk;
    if (!response.ok) throw new PartnerApiError('unavailable', `HTTP ${response.status}`);
    return response.json();
  };

  const graphQuery = async (queryName, variables, bearer) => {
    const hash = GRAPH_QUERY_HASHES[queryName];
    if (!hash) throw new PartnerApiError('unsupported', `未知查询 ${queryName}`);
    const answer = await authorizedRequest(QUERY_ENDPOINT, {
      bearer,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ variables, operationName: queryName, extensions: { persistedQuery: { version: 1, sha256Hash: hash } } }),
    });
    const errorText = Array.isArray(answer?.errors)
      ? answer.errors.map(item => item?.message).filter(Boolean).join(' | ').slice(0, 160)
      : '';
    return { data: answer?.data, errorText };
  };

  const runQuery = async (queryName, variables, bearer) => {
    const { data, errorText } = await graphQuery(queryName, variables, bearer);
    if (!data) throw new PartnerApiError('invalid-response', `${queryName}: ${errorText || '无数据'}`);
    if (errorText) warn(`[SpotifyPartner] ${queryName} 部分应答: ${errorText}`);
    return data;
  };

  // 账号摘要（用户名 + 会员档）：登录/播种时读一次，之后按 TTL 复读
  const readAccountSummary = async bearer => {
    const profile = await runQuery('profileAttributes', {}, bearer);
    const me = profile?.me?.profile;
    if (typeof me?.username !== 'string' || !me.username) {
      throw new PartnerApiError('invalid-response', '账号摘要缺少用户名');
    }
    const pictures = Array.isArray(me.avatar?.sources) ? me.avatar.sources : [];
    const largest = pictures.reduce((best, item) => ((item?.width ?? 0) > (best?.width ?? -1) ? item : best), null);
    return {
      id: crypto.createHash('sha256').update(`wf-spotify:${me.username}`).digest('hex').slice(0, 24),
      // username = Spotify 账号原生标识（歌单 ownerV2.username 与之同源）：
      // 渲染层判"歌单是否本人创建"必须拿它，哈希 id 不行
      username: me.username,
      nickname: String(me.name || 'Spotify'),
      avatarUrl: typeof largest?.url === 'string' ? largest.url : '',
    };
  };
  const refreshAccountSummary = (maxAgeMs = ACCOUNT_PROFILE_TTL_MS) => {
    if (!sessions.read()) return Promise.resolve();
    if (profileTask) return profileTask;
    if (Date.now() - profileReadAt < maxAgeMs) return Promise.resolve();
    profileReadAt = Date.now();
    const session = sessions.read();
    const task = readAccountSummary().then(summary => {
      // 期间会话被换号/清除则丢弃本次结果
      if (sessions.read()?.credentials.refresh_token === session?.credentials.refresh_token) {
        sessions.patch({ user: { ...summary, ...session?.user?.premium !== undefined ? { premium: session.user.premium } : {} } });
      }
    }, error => warn('[SpotifyPartner] 账号摘要刷新失败: ' + error.message)).finally(() => {
      if (profileTask === task) profileTask = null;
    });
    profileTask = task;
    return task;
  };

  const handlers = {
    // ── 登录 ──
    // 已登录时短路：不开 loopback 服务器、不弹系统浏览器。会话由 OAuth 授权播种
    // （seed_session）建立后，任何残留/误触的 login_start 调用都不得再打开浏览器。
    async login_start() {
      if (sessions.read()) {
        return { state: 'already-logged-in', authorizeUrl: '', windowMs: 0 };
      }
      const info = await loginManager.begin();
      void loginManager.openInBrowser().catch(() => {});
      return info;
    },
    login_check() { return loginManager.poll(); },
    async login_finish() {
      const poll = loginManager.poll();
      if (poll.state !== 'approved') return poll;
      const credentials = poll.tokens;
      let user = { nickname: 'Spotify' };
      try {
        user = await readAccountSummary(credentials.access_token);
      } catch { /* 摘要失败不阻塞登录 */ }
      sessions.write({ credentials, user });
      loginManager.complete();
      log('[SpotifyPartner] 登录完成');
      return { state: 'approved', user };
    },
    login_cancel() { loginManager.abort(); return true; },
    login_status() {
      const session = sessions.read();
      // 旧会话摘要缺 username（升级前落的盘）：后台补读一次，不阻塞本调用
      if (session?.user && typeof session.user.username !== 'string') {
        void refreshAccountSummary(0);
      }
      return { loggedIn: Boolean(session), user: session?.user ?? null };
    },
    async logout() { sessions.erase(); return true; },

    // OAuth 授权成功后由渲染层直接播种同账号 token（同 client 下 token 通用，
    // 免去用户再到系统浏览器点一次授权）。已有会话时不覆盖。
    async seed_session(params) {
      const accessToken = String(params?.accessToken || '');
      const refreshToken = String(params?.refreshToken || '');
      if (!accessToken || !refreshToken) {
        throw new PartnerApiError('invalid-response', 'seed_session 需要 access/refresh token');
      }
      const existing = sessions.read();
      if (existing?.credentials?.refresh_token) {
        return { state: 'existing', user: existing.user ?? null };
      }
      const credentials = {
        access_token: accessToken,
        refresh_token: refreshToken,
        expires_at: Date.now() + Math.max(60, Number(params?.expiresIn) || 3600) * 1000,
      };
      let user = { nickname: 'Spotify' };
      try {
        user = await readAccountSummary(credentials.access_token);
      } catch { /* 摘要失败时回填 OAuth 响应里的昵称 */ }
      if (params?.user?.nickname && user.nickname === 'Spotify') user = { ...user, ...params.user };
      sessions.write({ credentials, user });
      log('[SpotifyPartner] 会话已从 OAuth 授权播种');
      return { state: 'seeded', user };
    },

    // 通用 GraphQL 查询（白名单 = GRAPH_QUERY_HASHES 的键）
    async query(params) {
      const queryName = typeof params?.name === 'string' ? params.name : '';
      if (!Object.hasOwn(GRAPH_QUERY_HASHES, queryName)) {
        throw new PartnerApiError('unsupported', `未知查询 ${queryName}`);
      }
      void refreshAccountSummary();
      return runQuery(queryName, params.variables ?? {});
    },

    // 行级歌词（spclient color-lyrics；需 app-platform 头，缺它上游 400）
    async lyrics(params) {
      if (typeof params?.id !== 'string' || !TRACK_ID_PATTERN.test(params.id)) {
        throw new PartnerApiError('invalid-response', '非法曲目 id');
      }
      const answer = await authorizedRequest(
        `${LYRICS_ENDPOINT}/color-lyrics/v2/track/${params.id}?format=json&vocalRemoval=false&market=from_token`,
        { emptyOk: null, headers: { 'app-platform': 'WebPlayer' } },
      );
      const lines = Array.isArray(answer?.lyrics?.lines) ? answer.lyrics.lines : [];
      if (lines.length === 0) return null;
      return {
        timed: answer.lyrics.syncType === 'LINE_SYNCED',
        lines: lines.map(line => ({ startMs: Number(line?.startTimeMs) || 0, words: String(line?.words ?? '') })),
      };
    },

    // ── 音乐库/歌单写操作（spclient 接口；接口地址与请求体形态为服务端事实）────────
    // 写变更共用同一 GraphQL 端点，按名取哈希；上游对每个变更返回一个以操作名命名的键。
    async changeMutation(mutationName, variables) {
      const hash = GRAPH_CHANGE_HASHES[mutationName];
      if (!hash) throw new PartnerApiError('unsupported', `未知写变更 ${mutationName}`);
      const answer = await authorizedRequest(QUERY_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ variables, operationName: mutationName, extensions: { persistedQuery: { version: 1, sha256Hash: hash } } }),
      });
      const errorText = Array.isArray(answer?.errors)
        ? answer.errors.map(item => item?.message).filter(Boolean).join(' | ').slice(0, 160)
        : '';
      if (errorText) throw new PartnerApiError('unavailable', `Spotify 拒绝写变更: ${errorText}`);
      const values = answer?.data && typeof answer.data === 'object' ? Object.values(answer.data) : [];
      if (values.length === 0 || values.some(value => value === null)) {
        throw new PartnerApiError('unavailable', `写变更无结果: ${mutationName}`);
      }
      return true;
    },

    // 收藏/取消收藏到音乐库：歌曲与专辑走一对变更，歌单走 rootlist（不能收藏自己的歌单）
    async library(params) {
      const kind = typeof params?.uri === 'string' ? LIBRARY_URI_PATTERN.exec(params.uri)?.[1] : undefined;
      if (!kind || typeof params?.saved !== 'boolean') {
        throw new PartnerApiError('invalid-response', '非法音乐库写请求');
      }
      if (kind === 'playlist') {
        const list = (await runQuery('fetchPlaylist', { uri: params.uri, offset: 0, limit: 1, enableWatchFeedEntrypoint: false }))?.playlistV2;
        const owner = list?.ownerV2?.data?.username;
        if (!owner) throw new PartnerApiError('unavailable', 'Spotify 未返回歌单创建者');
        const session = sessions.read();
        // 自己的歌单无需"收藏"（移出库=删除歌单），如实拒绝
        if (owner === session?.user?.username || list.currentUserCapabilities?.canAdministratePermissions === true) {
          throw new PartnerApiError('unsupported', '不能收藏自己的歌单');
        }
        await this.changeMutation(params.saved ? 'addItemsToRootlist' : 'removeItemsFromRootlist', { uris: [params.uri] });
      } else {
        await this.changeMutation(params.saved ? 'addToLibrary' : 'removeFromLibrary', { libraryItemUris: [params.uri] });
      }
      log(`[SpotifyPartner] ${kind} ${params.saved ? '加入' : '移出'}音乐库`);
      return true;
    },

    // 歌单加/删曲：add 去重（上游会重复追加），remove 按 Spotify 行 uid 删全部同名行
    async playlist_edit(params) {
      const playlistId = String(params?.id ?? '');
      const uri = PLAYLIST_URI_PREFIX + playlistId;
      if (!PLAYLIST_URI_PATTERN.test(uri)) throw new PartnerApiError('invalid-response', '非法歌单 id');
      const action = params?.action;
      const trackIds = Array.isArray(params?.tracks) ? [...new Set(params.tracks.map(String).filter(id => TRACK_ID_PATTERN.test(id)))] : [];
      if (!['add', 'remove'].includes(action) || trackIds.length === 0 || trackIds.length > MAX_PLAYLIST_MUTATION_ROWS) {
        throw new PartnerApiError('invalid-response', '非法歌单写请求');
      }
      // 先整单读行（行 uid 是删除的凭据；add 需要判重）
      const existingRows = new Map();
      const stripPrefix = value => String(value ?? '').replace('spotify:track:', '');
      for (let offset = 0; offset < PLAYLIST_READ_MAX_OFFSET; offset += PLAYLIST_READ_PAGE) {
        const page = await runQuery('fetchPlaylist', { uri, offset, limit: PLAYLIST_READ_PAGE, enableWatchFeedEntrypoint: false });
        const rows = page?.playlistV2?.content?.items ?? [];
        if (rows.length === 0) break;
        for (const row of rows) {
          const trackId = stripPrefix(row?.itemV2?.data?.uri);
          if (trackId) existingRows.set(trackId, String(row?.uid ?? ''));
        }
        if (rows.length < PLAYLIST_READ_PAGE) break;
      }
      if (action === 'add') {
        const fresh = trackIds.filter(id => !existingRows.has(id)).map(id => `spotify:track:${id}`);
        if (fresh.length === 0) return true;
        await this.changeMutation('addToPlaylist', {
          playlistItemUris: fresh,
          playlistUri: uri,
          newPosition: { moveType: 'BOTTOM_OF_PLAYLIST', fromUid: null },
        });
      } else {
        const uids = trackIds.flatMap(id => existingRows.has(id) ? [existingRows.get(id)] : []).filter(Boolean);
        if (uids.length === 0) return true;
        await this.changeMutation('removeFromPlaylist', { playlistUri: uri, uids });
      }
      log(`[SpotifyPartner] 歌单 ${action} ${trackIds.length} 首`);
      return true;
    },

    // 新建歌单（spclient playlist/v2：建空歌单 + 收进音乐库两步）
    async playlist_create(params) {
      const name = String(params?.name ?? '').trim();
      if (!name || name.length > MAX_PLAYLIST_NAME_LENGTH) {
        throw new PartnerApiError('invalid-response', '歌单名为空或超长');
      }
      const made = await authorizedRequest(`${LYRICS_ENDPOINT}/playlist/v2/playlist?format=json`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ops: [{ kind: 'UPDATE_LIST_ATTRIBUTES', updateListAttributes: { newAttributes: { values: { name } } } }] }),
      });
      if (!PLAYLIST_URI_PATTERN.test(String(made?.uri ?? ''))) {
        throw new PartnerApiError('invalid-response', 'Spotify 未返回新歌单 uri');
      }
      await this.changeMutation('addItemsToRootlist', { uris: [made.uri] });
      log('[SpotifyPartner] 歌单已创建并入库');
      return { uri: made.uri };
    },

    // 电台：以一首曲目为种子生成"类似"歌单，返回歌单 uri
    // 官方首页 feed：官方桌面客户端把 home 数据经原生层拉取（xpui renderer 无 HTTP 请求可抓）。
    // 这里返回的是从官方客户端运行时 react-query 缓存导出的官方真实 payload（desktop/spotify-home-*.json，
    // 由 scripts/export-official-home.cjs 从带调试端口的官方客户端导出；官方客户端开着时数据自动更新）。
    // 参数 facet: 'all' | 'music'（官方首页「全部/音乐/播客」页签口径）。
    async home_snapshot(params) {
      const facet = String(params?.facet ?? 'all');
      const file = facet === 'music' ? path.join(__dirname, 'spotify-home-music-snapshot.json') : path.join(__dirname, 'spotify-home-snapshot.json');
      try {
        const raw = await fs.promises.readFile(file, 'utf8');
        return JSON.parse(raw);
      } catch {
        const fallbackFile = path.join(__dirname, 'spotify-home-snapshot.json');
        try {
          return JSON.parse(await fs.promises.readFile(fallbackFile, 'utf8'));
        } catch {
          return null;
        }
      }
    },

    async radio(params) {
      if (typeof params?.id !== 'string' || !TRACK_ID_PATTERN.test(params.id)) {
        throw new PartnerApiError('invalid-response', '非法曲目 id');
      }
      const answer = await authorizedRequest(
        `${LYRICS_ENDPOINT}/inspiredby-mix/v2/seed_to_playlist/spotify:track:${params.id}?response-format=json`,
        { emptyOk: null },
      );
      const uri = answer?.mediaItems?.[0]?.uri;
      return typeof uri === 'string' && uri.startsWith(PLAYLIST_URI_PREFIX) ? { uri } : null;
    },

    // 统一分发入口（IPC 'spotify-partner:request'）：操作名即 handlers 方法表，
    // 渲染层 spotifyPartnerClient.request(operation, params) 走这里。
    async request(operation, params) {
      const name = String(operation || '');
      const handler = handlers[name];
      if (typeof handler !== 'function') {
        throw new PartnerApiError('unsupported', `未知 Spotify partner 操作: ${name}`);
      }
      return handler.call(handlers, params);
    },
  };

  return { request: (operation, params) => handlers.request(operation, params) };
}

module.exports = { createSpotifyPartnerBridge };

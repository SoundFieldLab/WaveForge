/**
 * 私有模块（Private Module）—— 见仓库根 PRIVATE-LICENSE.md。
 * 版权所有（c）2026 WaveForge 澜音工坊，保留所有权利；未经书面授权禁止复制/移植/再分发。
 */
/**
 * AI 混音模型（DJTransGAN）一键下载/安装/删除管理器
 *
 * 目标：点「下载模型」后自动装好**可直接使用的完整引擎**（国内网络环境可用）：
 *   1. 复用应用内置的 Python 3.13（resources/python-embed）→ 复制到
 *      userData/ai-mix-engine/（可写副本，不污染应用目录；缺失时从华为云/python.org 下载）
 *   2. 增量安装 torch 2.9.1+cpu + torchaudio（阿里云 pytorch-wheels 镜像直下 wheel，
 *      CPU 版 ~110MB）与 torchlibrosa / joblib / pyloudnorm（清华 PyPI 镜像）
 *   3. DJTransGAN 仓库（ChenPaulYu/DJtransGAN，GitHub + gh-proxy.com / ghfast.top /
 *      ghproxy.net 加速镜像）→ 解压后应用 7 处兼容补丁（torchaudio 2.x / 去 madmom /
 *      去 asteroid/openunmix / 去 acoustics / 节拍注入）
 *   4. 预训练权重 djtransgan_minmax.pt（Google Drive；net.request 走系统代理，
 *      有代理的用户可直接下载；无代理时会尝试多个代理源）
 *
 * 已在本机（国内网络）实测：torch 2.9.1+cpu + 补丁仓库，get_generator / preprocess /
 * infer 全链路跑通。进度经 webContents 广播（'ai-model:progress'）；支持暂停（中止当前
 * 阶段，可从该阶段续传）/取消（清理半成品）；已完成阶段跳过。
 */

const { app, BrowserWindow, net } = require('electron')
const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')
const AdmZip = require('adm-zip')

// ── 各组件源（顺序即优先级：国内镜像在前，官方兜底）────────────────────────

const PY_VERSION = '3.13.15'
const PY_SHORT = '313'
const PYTHON_URLS = [
  `https://mirrors.huaweicloud.com/python/${PY_VERSION}/python-${PY_VERSION}-embed-amd64.zip`,
  `https://www.python.org/ftp/python/${PY_VERSION}/python-${PY_VERSION}-embed-amd64.zip`,
]
const TORCH_VERSION = '2.9.1'
const TORCH_WHEEL_URLS = [
  `https://mirrors.aliyun.com/pytorch-wheels/cpu/torch-${TORCH_VERSION}%2Bcpu-cp${PY_SHORT}-cp${PY_SHORT}-win_amd64.whl`,
  `https://download.pytorch.org/whl/cpu/torch-${TORCH_VERSION}%2Bcpu-cp${PY_SHORT}-cp${PY_SHORT}-win_amd64.whl`,
]
const TORCHAUDIO_WHEEL_URLS = [
  `https://mirrors.aliyun.com/pytorch-wheels/cpu/torchaudio-${TORCH_VERSION}%2Bcpu-cp${PY_SHORT}-cp${PY_SHORT}-win_amd64.whl`,
  `https://download.pytorch.org/whl/cpu/torchaudio-${TORCH_VERSION}%2Bcpu-cp${PY_SHORT}-cp${PY_SHORT}-win_amd64.whl`,
]
const PYPI_INDEX = 'https://pypi.tuna.tsinghua.edu.cn/simple'
const EXTRA_PYPI_PKGS = ['torchlibrosa', 'joblib', 'pyloudnorm']

const REPO_OWNER = 'ChenPaulYu'
const REPO_NAME = 'DJtransGAN'
// 固定到本机已验证可运行的上游 commit，避免 main 漂移后补丁静默失效。
const REPO_REF = '64228931f3b4514f289fbbbc0e5675adb57aeb88'
const REPO_ARCHIVE_BYTES = 72523006
const REPO_ARCHIVE_SHA256 = 'c2a938c0868e83c85d7c1c6c8408b7335d7b6906dd6f0180b9e22efbd8616894'
const REPO_ZIP_URLS = [
  `https://gh-proxy.com/https://github.com/${REPO_OWNER}/${REPO_NAME}/archive/${REPO_REF}.zip`,
  `https://ghfast.top/https://github.com/${REPO_OWNER}/${REPO_NAME}/archive/${REPO_REF}.zip`,
  `https://ghproxy.net/https://github.com/${REPO_OWNER}/${REPO_NAME}/archive/${REPO_REF}.zip`,
  `https://github.com/${REPO_OWNER}/${REPO_NAME}/archive/${REPO_REF}.zip`,
]
// 预训练权重（djtransgan_minmax.pt）Google Drive 文件 ID（作者仓库 download_pretrained）
const WEIGHTS_FILE_ID = '1JtBUJL3sERl5HaM7sSH7p2Tw5Wnejvtt'
const WEIGHTS_BYTES = 139935693
const WEIGHTS_SHA256 = '495987d70bd873fb94838b3af705be85d368a6639659f2ffcc2b05a9740e8fd2'
const WEIGHTS_URLS = [
  `https://drive.usercontent.google.com/download?id=${WEIGHTS_FILE_ID}&export=download&confirm=t`,
  `https://drive.google.com/u/0/uc?id=${WEIGHTS_FILE_ID}&export=download&confirm=t`,
  // 常见 GD 代理（国内可达性各异，按序兜底）
  `https://gd.1314171.xyz/1JtBUJL3sERl5HaM7sSH7p2Tw5Wnejvtt`,
  `https://drive.vercel.app/api/raw/?path=%2F&fileName=djtransgan_minmax.pt&id=${WEIGHTS_FILE_ID}`,
]

const PHASE_LABEL = {
  python: '准备 Python 运行环境',
  deps: '安装 AI 依赖（torch 等，约 150MB）',
  repo: '下载 DJTransGAN 仓库',
  weights: '下载预训练权重',
}
// 阶段权重（按体量粗估）
const PHASE_WEIGHT = { python: 0.05, deps: 0.5, repo: 0.1, weights: 0.35 }

// ── 路径 ───────────────────────────────────────────────────────────────────

function getModelRoot() {
  // 模型放「应用安装目录」（打包版 = 安装目录，开发版 = electron dist），
  // 不占系统用户目录（用户明确要求不放 C 盘 AppData）。
  return path.join(path.dirname(app.getPath('exe')), 'ai-mix-engine')
}
function getPythonPath() {
  return path.join(getModelRoot(), 'python.exe')
}
function getSitePackages() {
  return path.join(getModelRoot(), 'Lib', 'site-packages')
}
function getModelDir() {
  return path.join(getModelRoot(), 'DJTransGAN')
}
function getWeightsPath() {
  return path.join(getModelDir(), 'pretrained', 'djtransgan_minmax.pt')
}
function getWeightsMarkerPath() {
  return `${getWeightsPath()}.verified.json`
}
function getRepoMarkerPath() {
  return path.join(getModelDir(), '.waveforge-source.json')
}

function pythonExists() { return fs.existsSync(getPythonPath()) }
function depsReady() {
  return fs.existsSync(path.join(getSitePackages(), 'torch'))
    && fs.existsSync(path.join(getSitePackages(), 'torchlibrosa'))
}
function repoReady() {
  try {
    const marker = JSON.parse(fs.readFileSync(getRepoMarkerPath(), 'utf8'))
    return marker.repoRef === REPO_REF
      && marker.archiveSha256 === REPO_ARCHIVE_SHA256
      && fs.existsSync(path.join(getModelDir(), 'djtransgan', 'model', '__init__.py'))
  } catch { return false }
}
function weightsReady() {
  try {
    const stat = fs.statSync(getWeightsPath())
    const marker = JSON.parse(fs.readFileSync(getWeightsMarkerPath(), 'utf8'))
    return stat.isFile()
      && stat.size === WEIGHTS_BYTES
      && marker.sha256 === WEIGHTS_SHA256
      && marker.bytes === WEIGHTS_BYTES
      && marker.mtimeMs === stat.mtimeMs
  } catch { return false }
}

async function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = require('crypto').createHash('sha256')
    fs.createReadStream(filePath)
      .on('data', chunk => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')))
  })
}

async function verifyWeights() {
  let stat
  try { stat = fs.statSync(getWeightsPath()) } catch { return false }
  if (!stat.isFile() || stat.size !== WEIGHTS_BYTES) return false
  if ((await sha256File(getWeightsPath())) !== WEIGHTS_SHA256) return false
  const markerPath = getWeightsMarkerPath()
  const temporary = `${markerPath}.tmp`
  fs.writeFileSync(temporary, JSON.stringify({ bytes: WEIGHTS_BYTES, sha256: WEIGHTS_SHA256, mtimeMs: stat.mtimeMs }))
  fs.renameSync(temporary, markerPath)
  return true
}

/** 是否存在可用的 torch Python（与 render-runtime.cjs 的 aiPythonCandidates 一致） */
function pythonCandidates() {
  const candidates = []
  if (process.env.WAVEFORGE_AI_MIX_PYTHON) candidates.push(process.env.WAVEFORGE_AI_MIX_PYTHON)
  candidates.push(path.join(__dirname, '..', '..', 'DJTransGAN', '.venv', 'Scripts', 'python.exe'))
  candidates.push(getPythonPath())
  return candidates.filter((c) => typeof c === 'string' && fs.existsSync(c))
}

function getStatus() {
  const pythonFound = pythonCandidates().length > 0
  const repoOk = repoReady()
  const weightsOk = weightsReady()
  return {
    installed: pythonFound && depsReady() && repoOk && weightsOk,
    repoReady: repoOk,
    weightsReady: weightsOk,
    pythonFound,
    depsReady: depsReady(),
    engineAvailable: pythonFound && depsReady() && repoOk && weightsOk,
    repoDir: getModelDir(),
  }
}

// ── 下载状态机 ─────────────────────────────────────────────────────────────

const state = {
  status: 'idle',
  phase: null,
  phasePercent: 0,
  overallPercent: 0,
  error: null,
  controller: null,
  running: null,
  done: false,
  // 下载速率/剩余时间（仅文件下载阶段有效；pip 安装阶段无此信息，置 0/null）
  downloadBytes: 0,
  downloadTotal: 0,
  downloadSpeed: 0,
  downloadEta: null,
}

function emitProgress(win) {
  const payload = {
    status: state.status,
    phase: state.phase,
    phasePercent: Math.round(state.phasePercent),
    overallPercent: Math.round(state.overallPercent),
    error: state.error,
    done: state.done,
    phaseLabel: state.phase ? PHASE_LABEL[state.phase] || state.phase : null,
    downloadSpeed: state.downloadSpeed,
    downloadEta: state.downloadEta,
  }
  if (win && !win.isDestroyed()) win.webContents.send('ai-model:progress', payload)
}
function broadcastProgress() {
  try {
    for (const win of BrowserWindow.getAllWindows()) emitProgress(win)
  } catch { /* 广播失败不阻断下载流程 */ }
}

let automixLogger = null
function setAutomixLogger(fn) { automixLogger = fn }
function logMessage(message) {
  if (typeof automixLogger === 'function') {
    try { automixLogger('aimix-model', String(message).slice(0, 300)) } catch { /* ignore */ }
  }
}

/** 下载单个文件：多源按序尝试；返回 true 成功 */
async function downloadFile(urls, destPath) {
  // A previous pause/crash may have left a complete weight file under .part. Verify and promote
  // it before sending an invalid Range bytes=size- request.
  if (destPath === getWeightsPath()) {
    const part = `${destPath}.part`
    try {
      if (fs.statSync(part).size === WEIGHTS_BYTES && await sha256File(part) === WEIGHTS_SHA256) {
        fs.rmSync(destPath, { force: true })
        fs.renameSync(part, destPath)
        return true
      }
    } catch { /* incomplete/missing partial continues through normal resume */ }
  }
  let proxySession = null
  // 代理自动配置开启时，显式路由到本地代理会话（不依赖系统代理设置）
  try {
    const { getState, getProxySession } = require('./proxy-manager.cjs')
    if (getState().enabled) proxySession = await getProxySession()
  } catch { /* 代理模块不可用则直连 */ }
  return new Promise((resolve) => {
    const tryUrl = (index) => {
      if (index >= urls.length) { state.error = '所有下载源均失败'; resolve(false); return }
      const url = urls[index]
      let aborted = false
      // Electron 42：setRedirectMode 已移除；不监听 'redirect' 事件时自动跟随重定向（默认）
      const request = proxySession ? net.request({ url, session: proxySession }) : net.request(url)
      fs.mkdirSync(path.dirname(destPath), { recursive: true })
      const partPath = destPath + '.part'
      let resumeOffset = 0
      try { resumeOffset = fs.statSync(partPath).size } catch { /* no partial file */ }
      if (resumeOffset > 0) request.setHeader('Range', `bytes=${resumeOffset}-`)
      const abort = () => { aborted = true; request.abort() }
      state.controller.onAbort = abort
      request.on('response', (response) => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          logMessage(`${url} HTTP ${response.statusCode}`)
          response.resume()
          tryUrl(index + 1)
          return
        }
        const responseBytes = Number(response.headers['content-length'] || 0)
        // 206 表示服务端接受断点；200 表示忽略 Range，必须从零重写，不能把整文件追加到 part。
        const resumed = resumeOffset > 0 && response.statusCode === 206
        if (resumeOffset > 0 && !resumed) {
          try { fs.rmSync(partPath, { force: true }) } catch { /* restart from zero */ }
          resumeOffset = 0
        }
        const total = resumed && responseBytes > 0 ? resumeOffset + responseBytes : responseBytes
        let received = resumeOffset
        // 本次文件的速率采样窗口（约每 500ms 采一次，避免逐 chunk 抖动）
        let lastSpeedAt = Date.now()
        let lastSpeedBytes = received
        state.downloadBytes = received
        state.downloadTotal = total
        state.downloadSpeed = 0
        state.downloadEta = null
        const writeStream = fs.createWriteStream(partPath, { flags: resumed ? 'a' : 'w' })
        let finished = false
        const cleanup = () => { if (!finished) { finished = true; try { writeStream.destroy() } catch { /* ignore */ } } }
        writeStream.on('error', () => { cleanup(); if (!aborted) { state.error = `写入失败: ${destPath}`; resolve(false) } })
        response.on('data', (chunk) => {
          if (aborted) return
          received += chunk.length
          state.downloadBytes = received
          if (total > 0) state.phasePercent = (received / total) * 100
          else state.phasePercent = Math.min(99, state.phasePercent + 0.05)
          // 速率与剩余时间：带宽变化时按最近 500ms 采样估计
          const now = Date.now()
          const dt = now - lastSpeedAt
          if (dt >= 500) {
            state.downloadSpeed = Math.round(((received - lastSpeedBytes) * 1000) / dt)
            if (total > 0 && state.downloadSpeed > 0) {
              state.downloadEta = Math.max(0, Math.round((total - received) / state.downloadSpeed))
            }
            lastSpeedAt = now
            lastSpeedBytes = received
          }
          state.overallPercent = cumulativePercent()
          if (!writeStream.write(chunk)) { response.pause(); writeStream.once('drain', () => response.resume()) }
        })
        response.on('end', () => {
          if (aborted) { cleanup(); resolve(false); return }
          writeStream.end(() => {
            finished = true
            fs.renameSync(partPath, destPath)
            state.phasePercent = 100
            state.downloadSpeed = 0
            state.downloadEta = null
            state.overallPercent = cumulativePercent()
            resolve(true)
          })
        })
        response.on('error', () => { cleanup(); if (!aborted) { state.error = `下载中断: ${url}`; resolve(false) } })
      })
      request.on('error', () => { if (!aborted) { logMessage(`请求失败: ${url}`); tryUrl(index + 1) } else resolve(false) })
      request.end()
    }
    tryUrl(0)
  })
}

function cumulativePercent() {
  const order = ['python', 'deps', 'repo', 'weights']
  const idx = order.indexOf(state.phase)
  let sum = 0
  for (let i = 0; i < idx; i += 1) sum += PHASE_WEIGHT[order[i]]
  return (sum + (PHASE_WEIGHT[state.phase] || 0) * (state.phasePercent / 100)) * 100
}

/** 执行命令并捕获输出（解析 pip 下载进度百分比）；返回退出码 */
function runProcess(command, args, { cwd } = {}) {
  return new Promise((resolve) => {
    // pip 安装阶段没有文件下载速率信息，清空避免残留上一阶段的数值
    state.downloadSpeed = 0
    state.downloadEta = null
    const child = spawn(command, args, { cwd, windowsHide: true })
    let buffer = ''
    state.controller.onAbort = () => { try { child.kill() } catch { /* ignore */ } }
    child.stdout.on('data', (data) => {
      buffer += data.toString()
      const match = buffer.match(/(\d+)%/g)
      if (match) {
        const last = parseInt(match[match.length - 1], 10)
        if (Number.isFinite(last)) { state.phasePercent = last; state.overallPercent = cumulativePercent() }
      }
    })
    child.stderr.on('data', () => { /* 错误由退出码判断 */ })
    child.on('error', () => resolve(-1))
    child.on('close', (code) => resolve(code === null ? -1 : code))
  })
}

async function setupPython() {
  if (pythonExists()) return true
  state.phase = 'python'
  state.phasePercent = 0
  // 优先复制应用内置 Python（resources/python-embed），缺失才下载。
  // 开发版在项目目录下，打包版在 resourcesPath（extraResources），双路径兼容不同安装位置
  const bundledCandidates = [
    path.join(__dirname, '..', 'resources', 'python-embed'),
    path.join(process.resourcesPath, 'python-embed'),
  ]
  const bundled = bundledCandidates.find((p) => fs.existsSync(path.join(p, 'python.exe')))
  if (bundled) {
    fs.mkdirSync(getModelRoot(), { recursive: true })
    try {
      // 递归复制（跳过 __pycache__）
      const copyDir = (src, dst) => {
        fs.mkdirSync(dst, { recursive: true })
        for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
          if (entry.name === '__pycache__') continue
          const s = path.join(src, entry.name)
          const d = path.join(dst, entry.name)
          if (entry.isDirectory()) copyDir(s, d)
          else fs.copyFileSync(s, d)
        }
      }
      copyDir(bundled, getModelRoot())
      logMessage('复用内置 Python 3.13')
    } catch (error) {
      state.error = `复制内置 Python 失败: ${error?.message || error}`
      return false
    }
  } else {
    const zipPath = path.join(getModelRoot(), 'python-embed.zip')
    const ok = await downloadFile(PYTHON_URLS, zipPath)
    if (!ok || state.status === 'cancelled' || state.status === 'paused') return false
    try { new AdmZip(zipPath).extractAllTo(getModelRoot(), true) } catch (error) {
      state.error = `解压 Python 失败: ${error?.message || error}`; return false
    } finally { try { fs.rmSync(zipPath, { force: true }) } catch { /* ignore */ } }
  }
  return pythonExists()
}

async function installDeps() {
  if (depsReady()) return true
  state.phase = 'deps'
  state.phasePercent = 0
  const python = getPythonPath()
  // 1) torch / torchaudio CPU wheel：阿里云直下（可靠）→ 本地安装
  const torchWheel = path.join(getModelRoot(), `torch-${TORCH_VERSION}+cpu-cp${PY_SHORT}-cp${PY_SHORT}-win_amd64.whl`)
  const taWheel = path.join(getModelRoot(), `torchaudio-${TORCH_VERSION}+cpu-cp${PY_SHORT}-cp${PY_SHORT}-win_amd64.whl`)
  if (!fs.existsSync(torchWheel)) {
    const ok = await downloadFile(TORCH_WHEEL_URLS, torchWheel)
    if (!ok || state.status === 'cancelled' || state.status === 'paused') return false
  }
  state.phasePercent = 30
  state.overallPercent = cumulativePercent()
  if (!fs.existsSync(taWheel)) {
    const ok = await downloadFile(TORCHAUDIO_WHEEL_URLS, taWheel)
    if (!ok || state.status === 'cancelled' || state.status === 'paused') return false
  }
  state.phasePercent = 40
  state.overallPercent = cumulativePercent()
  // 2) pip 本地装 torch/torchaudio + 其余依赖（清华源）
  const code = await runProcess(python, [
    '-m', 'pip', 'install', '--no-warn-script-location', '--disable-pip-version-check',
    `--index-url`, PYPI_INDEX, torchWheel, taWheel, ...EXTRA_PYPI_PKGS,
  ])
  if (state.status === 'cancelled' || state.status === 'paused') return false
  if (code !== 0 || !depsReady()) {
    state.error = '依赖安装失败（网络或兼容问题），请重试'
    return false
  }
  try { fs.rmSync(torchWheel, { force: true }); fs.rmSync(taWheel, { force: true }) } catch { /* ignore */ }
  state.phasePercent = 100
  state.overallPercent = cumulativePercent()
  return true
}

// ── 仓库兼容补丁（torch 2.x / Py3.13 环境）──────────────────────────────────

function applyRepoPatches(repoDir) {
  const read = (rel) => fs.readFileSync(path.join(repoDir, rel), 'utf-8')
  const write = (rel, s) => fs.writeFileSync(path.join(repoDir, rel), s, 'utf-8')
  const replace = (rel, from, to) => {
    const s = read(rel)
    if (!s.includes(from)) throw new Error(`补丁未命中: ${rel} (${from.slice(0, 40)}…)`)
    write(rel, s.split(from).join(to))
  }
  // 按行前缀删除（对行尾换行/空白差异稳健）
  const dropLines = (rel, prefixes) => {
    write(rel, read(rel).split('\n').filter((l) => !prefixes.some((p) => l.startsWith(p))).join('\n'))
  }
  // 1) torchaudio 2.x 移除 set_audio_backend
  replace('djtransgan/utils/utils.py',
    "torchaudio.set_audio_backend('soundfile')",
    "try:\n    torchaudio.set_audio_backend('soundfile')\nexcept Exception:\n    pass  # torchaudio 2.x 已移除")
  // 2) utils/__init__.py：去掉 visualize（IPython/matplotlib）与 download（gdown）
  dropLines('djtransgan/utils/__init__.py', ['from djtransgan.utils.visualize', 'from djtransgan.utils.download'])
  // 3) frontend/__init__.py：只保留默认 torchlibrosa（去掉 asteroid→openunmix、nnaudio）
  dropLines('djtransgan/frontend/__init__.py', ['from djtransgan.frontend.asteroid', 'from djtransgan.frontend.nnaudio'])
  // 4) frontend/utils.py
  replace('djtransgan/frontend/utils.py', "from djtransgan.frontend    import AsteroidSTFT\n", '')
  replace('djtransgan/frontend/utils.py', "from djtransgan.frontend    import NNaudioSTFT\n", '')
  replace('djtransgan/frontend/utils.py',
    "    return {\n        'nnaudio' : NNaudioSTFT(**kargs),\n        'asteroid': AsteroidSTFT(**kargs), \n        'torchlibrosa': TorchlibrosaSTFT(**kargs), \n    }[stft_type]",
    "    return TorchlibrosaSTFT(**kargs)")
  // 5) process/__init__.py：去掉 beat（madmom 无 wheel，节拍由 App 分析注入）
  dropLines('djtransgan/process/__init__.py', ['from djtransgan.process.beat'])
  // 6) process/process.py：estimate_beat → 注入的 plan 节拍
  replace('djtransgan/process/process.py',
    "from djtransgan.process import estimate_beat, select_cue_points, correct_cue",
    "from djtransgan.process import select_cue_points, correct_cue")
  replace('djtransgan/process/process.py',
    "    _, prev_bpm, _, prev_downbeat = estimate_beat(prev_audio)\n    _, next_bpm, _, next_downbeat = estimate_beat(next_audio)",
    "    prev_bpm, prev_downbeat = _plan_beats('prev')\n    next_bpm, next_downbeat = _plan_beats('next')")
  replace('djtransgan/process/process.py',
    "def preprocess(prev_audio, \n               next_audio, \n               prev_cue, \n               next_cue):",
    "_injected = {'prev': None, 'next': None}\n\ndef _plan_beats(key):\n    info = _injected.get(key)\n    if not info:\n        raise RuntimeError(f'beat data missing for {key}')\n    import numpy as _np\n    return info['bpm'], _np.asarray(info['downbeats'], dtype=_np.float64)\n\ndef preprocess(prev_audio, \n               next_audio, \n               prev_cue, \n               next_cue,\n               plan_beats=None):\n    if plan_beats:\n        _injected['prev'] = plan_beats.get('prev')\n        _injected['next'] = plan_beats.get('next')")
  // 7) dataset/noise.py：numpy 噪声替代 acoustics（依赖 scipy 已移除的 sph_harm）
  write('djtransgan/dataset/noise.py',
    "import torch\nimport random\nimport numpy as np\nfrom djtransgan.config   import settings\n\n\nrandom.seed(settings.RANDOM_SEED)\n\n\ndef _noise(n, color):\n    rng = np.random.RandomState(settings.RANDOM_SEED)\n    if color == 'pink':\n        white = rng.randn(n)\n        out = np.zeros(n)\n        for _ in range(int(np.log2(n)) + 1):\n            step = max(1, 2 ** np.random.randint(0, 10))\n            out += white[np.arange(n) // step]\n        return out / np.sqrt(int(np.log2(n)) + 1)\n    if color == 'brown':\n        out = np.cumsum(rng.randn(n))\n        return out / (np.max(np.abs(out)) + 1e-9)\n    return rng.randn(n)\n\n\ndef generate_noise(secs, color='white'):\n    return torch.from_numpy(_noise(int(secs * settings.SR), color)).to(torch.float32)\n")
  // 8) utils/manipulate.py：time_stretch 改用 librosa（pyrubberband 需外部 rubberband CLI，无法自动安装）
  replace('djtransgan/utils/manipulate.py', "import pyrubberband as pyrb\n", '')
  replace('djtransgan/utils/manipulate.py',
    "    if isinstance(audio, torch.Tensor): \n        stretched = torch.from_numpy(pyrb.time_stretch(squeeze_dim(audio).numpy(), sr, ratio)).unsqueeze(0)\n    else:\n        stretched = pyrb.time_stretch(audio, sr, ratio)",
    "    import librosa\n    if isinstance(audio, torch.Tensor): \n        stretched = torch.from_numpy(librosa.effects.time_stretch(squeeze_dim(audio).numpy(), rate=ratio)).unsqueeze(0)\n    else:\n        stretched = librosa.effects.time_stretch(audio, rate=ratio)")
}

function assertSafeArchive(zip, targetRoot) {
  const root = path.resolve(targetRoot) + path.sep
  for (const entry of zip.getEntries()) {
    const resolved = path.resolve(targetRoot, entry.entryName)
    if (!resolved.startsWith(root)) throw new Error(`压缩包包含不安全路径: ${entry.entryName}`)
  }
}

async function downloadRepo() {
  state.phase = 'repo'
  state.phasePercent = 0
  const zipPath = path.join(getModelRoot(), 'repo.zip')
  const ok = await downloadFile(REPO_ZIP_URLS, zipPath)
  if (!ok || state.status === 'cancelled' || state.status === 'paused') return false
  try {
    const stat = fs.statSync(zipPath)
    if (stat.size !== REPO_ARCHIVE_BYTES || await sha256File(zipPath) !== REPO_ARCHIVE_SHA256) {
      state.error = 'DJTransGAN 源码归档大小或 SHA-256 校验失败'
      fs.rmSync(zipPath, { force: true })
      return false
    }
  } catch (error) {
    state.error = `DJTransGAN 源码归档校验失败: ${error?.message || error}`
    return false
  }
  const extracted = path.join(getModelRoot(), 'repo-src')
  if (fs.existsSync(extracted)) fs.rmSync(extracted, { recursive: true, force: true })
  try {
    const zip = new AdmZip(zipPath)
    assertSafeArchive(zip, extracted)
    zip.extractAllTo(extracted, true)
  } catch (error) {
    state.error = `解压仓库失败: ${error?.message || error}`; return false
  } finally { try { fs.rmSync(zipPath, { force: true }) } catch { /* ignore */ } }
  // zip 内层目录名可能是 DJtransGAN-main / DJTransGAN-main / 直接 djtransgan
  let src = null
  for (const name of fs.readdirSync(extracted)) {
    const p = path.join(extracted, name)
    if (fs.statSync(p).isDirectory() && fs.existsSync(path.join(p, 'djtransgan', 'model', '__init__.py'))) { src = p; break }
  }
  if (!src) { state.error = '仓库结构异常（缺少 djtransgan 包）'; return false }
  if (fs.existsSync(getModelDir())) fs.rmSync(getModelDir(), { recursive: true, force: true })
  fs.mkdirSync(path.dirname(getModelDir()), { recursive: true })
  fs.renameSync(src, getModelDir())
  try { fs.rmSync(extracted, { recursive: true, force: true }) } catch { /* ignore */ }
  // 应用兼容补丁
  try {
    applyRepoPatches(getModelDir())
    logMessage('仓库兼容补丁已应用')
  } catch (error) {
    state.error = `仓库补丁失败: ${error?.message || error}`
    return false
  }
  return repoReady()
}

async function downloadWeights() {
  state.phase = 'weights'
  state.phasePercent = 0
  // 旧安装没有 marker 时先完整哈希一次；验证成功后写 marker，之后启动只做身份快检。
  if (await verifyWeights()) return true
  if (fs.existsSync(getWeightsPath())) {
    try { fs.rmSync(getWeightsPath(), { force: true }) } catch { /* overwrite path cleanup */ }
  }
  const ok = await downloadFile(WEIGHTS_URLS, getWeightsPath())
  if (!ok) {
    state.error = `预训练权重下载失败（Google Drive 在国内网络受限）。其余部分已就绪：`
      + `请在有代理/加速的网络下重试，或将权重文件放入 ${getWeightsPath()}`
    return false
  }
  if (!await verifyWeights()) {
    try { fs.rmSync(getWeightsPath(), { force: true }) } catch { /* invalid file removed */ }
    state.error = '预训练权重大小或 SHA-256 校验失败，请重试下载'
    return false
  }
  return true
}

async function runDownload() {
  state.status = 'downloading'
  state.done = false
  state.error = null
  broadcastProgress()
  // 下载/安装阶段内部按 chunk 更新 state 但不逐 chunk 广播（避免 IPC 风暴），
  // 用 500ms 定时器统一广播，UI 进度条才能实时走动
  const progressTimer = setInterval(() => broadcastProgress(), 500)
  try {
    const ok = await setupPython()
    if (!ok || state.status === 'cancelled' || state.status === 'paused') {
      if (state.status !== 'cancelled' && state.status !== 'paused') state.status = 'error'
      broadcastProgress(); return
    }
    const okDeps = await installDeps()
    if (!okDeps || state.status === 'cancelled' || state.status === 'paused') {
      if (state.status !== 'cancelled' && state.status !== 'paused') state.status = 'error'
      broadcastProgress(); return
    }
    if (!repoReady()) {
      const okRepo = await downloadRepo()
      if (!okRepo || state.status === 'cancelled' || state.status === 'paused') {
        if (state.status !== 'cancelled' && state.status !== 'paused') state.status = 'error'
        broadcastProgress(); return
      }
    }
    if (!weightsReady()) {
      const okWeights = await downloadWeights()
      if (!okWeights || state.status === 'cancelled' || state.status === 'paused') {
        if (state.status !== 'cancelled' && state.status !== 'paused') state.status = 'error'
        broadcastProgress(); return
      }
    }
    state.status = 'done'
    state.done = true
    state.phase = null
    state.phasePercent = 100
    state.overallPercent = 100
    broadcastProgress()
  } catch (error) {
    // 任何意外异常都落到 error 状态（而不是卡在 downloading）
    if (state.status !== 'cancelled' && state.status !== 'paused') {
      state.status = 'error'
      state.error = error instanceof Error ? error.message : String(error)
      broadcastProgress()
    }
  } finally {
    clearInterval(progressTimer)
  }
}

async function startDownload() {
  if (state.status === 'downloading') return { ok: true, already: true }
  if (state.running) {
    try { await state.running } catch { /* state carries the failure */ }
  }
  state.controller = { abort: null, onAbort: null }
  state.controller.abort = () => {
    if (typeof state.controller.onAbort === 'function') {
      try { state.controller.onAbort() } catch { /* ignore */ }
    }
  }
  const running = runDownload()
  state.running = running
  void running.finally(() => { if (state.running === running) state.running = null }).catch(() => undefined)
  return { ok: true }
}

async function pauseDownload() {
  if (state.status !== 'downloading') return { ok: false }
  const running = state.running
  state.controller?.abort()
  state.status = 'paused'
  broadcastProgress()
  if (running) await running.catch(() => undefined)
  state.status = 'paused'
  broadcastProgress()
  return { ok: true }
}

async function cancelDownload() {
  if (state.status !== 'downloading' && state.status !== 'paused') return { ok: false }
  const running = state.running
  state.controller?.abort()
  state.status = 'cancelled'
  if (running) await running.catch(() => undefined)
  state.phase = null
  state.phasePercent = 0
  state.overallPercent = 0
  cleanupPartial()
  broadcastProgress()
  return { ok: true }
}

function cleanupPartial() {
  const root = getModelRoot()
  if (!fs.existsSync(root)) return
  for (const name of fs.readdirSync(root)) {
    // 只清下载残留（.part）与临时 zip/脚本；绝不删 python313.zip（内置 Python 标准库）
    if (name.endsWith('.part') || name === 'repo.zip' || name === 'python-embed.zip'
      || name === 'get-pip.py' || name === 'repo-src') {
      try { fs.rmSync(path.join(root, name), { recursive: true, force: true }) } catch { /* ignore */ }
    }
  }
}

async function deleteModel() {
  const running = state.running
  state.controller?.abort()
  if (running) await running.catch(() => undefined)
  const root = getModelRoot()
  if (fs.existsSync(root)) {
    // 删除可能耗时（数 GB 目录/数万文件）：先广播 deleting 状态让界面显示「删除中…」，
    // 用异步 rm 避免同步递归删除期间卡死主进程
    state.status = 'deleting'
    state.phase = 'delete'
    state.phasePercent = 0
    state.error = null
    broadcastProgress()
    try {
      await fs.promises.rm(root, { recursive: true, force: true })
    } catch (error) {
      state.status = 'idle'
      state.phase = null
      state.phasePercent = 0
      broadcastProgress()
      return { ok: false, error: `删除失败: ${error?.message || error}` }
    }
  }
  state.status = 'idle'
  state.done = false
  state.phase = null
  state.phasePercent = 0
  broadcastProgress()
  return { ok: true }
}

function setupAiModelIPC(ipcMain, automixLogFn) {
  if (automixLogFn) setAutomixLogger(automixLogFn)
  cleanupLegacyLocation()
  // Existing/manual installs are not trusted by name or size alone. Verify once asynchronously
  // and write the identity marker before exposing engineAvailable=true.
  if (!weightsReady() && fs.existsSync(getWeightsPath())) {
    void verifyWeights().then(ok => {
      if (!ok) logMessage('现有 DJTransGAN 权重完整性校验失败，保持扩展不可用')
      broadcastProgress()
    }).catch(() => undefined)
  }
  ipcMain.handle('ai-model:get-status', async () => {
    if (!weightsReady() && fs.existsSync(getWeightsPath())) await verifyWeights().catch(() => false)
    return getStatus()
  })
  ipcMain.handle('ai-model:download', () => startDownload())
  ipcMain.handle('ai-model:pause', () => pauseDownload())
  ipcMain.handle('ai-model:cancel', () => cancelDownload())
  ipcMain.handle('ai-model:delete', () => deleteModel())
}

/** 清理旧位置（userData/ai-mix-engine）残留：模型位置改到应用安装目录后，C 盘用户目录里的旧副本作废 */
function cleanupLegacyLocation() {
  try {
    const old = path.join(app.getPath('userData'), 'ai-mix-engine')
    const current = getModelRoot()
    if (old !== current && fs.existsSync(old)) {
      fs.rmSync(old, { recursive: true, force: true })
      logMessage('已清理旧位置模型残留（userData/ai-mix-engine）')
    }
  } catch { /* 清理失败不阻断 */ }
}

module.exports = {
  setupAiModelIPC,
  getStatus,
  getModelDir,
  getWeightsPath,
  pythonCandidates,
  applyRepoPatches,
  _assertSafeArchive: assertSafeArchive,
  _assetInfo: {
    repoRef: REPO_REF,
    repoArchiveBytes: REPO_ARCHIVE_BYTES,
    repoArchiveSha256: REPO_ARCHIVE_SHA256,
    weightsBytes: WEIGHTS_BYTES,
    weightsSha256: WEIGHTS_SHA256,
  },
}

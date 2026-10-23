import hmac
import os
from pathlib import Path

LOCAL_SERVICE_TOKEN = os.environ.get('WAVEFORGE_LOCAL_TOKEN', '')


def is_authorized_local_request(supplied_token: str = '') -> bool:
    if not LOCAL_SERVICE_TOKEN:
        return True
    return hmac.compare_digest(str(supplied_token or ''), LOCAL_SERVICE_TOKEN)


def _cache_root() -> Path:
    configured = os.environ.get('WAVEFORGE_CACHE_PATH', '').strip()
    if configured:
        return Path(configured).expanduser()
    if os.name == 'nt':
        base = os.environ.get('LOCALAPPDATA', '').strip() or os.environ.get('APPDATA', '').strip()
        if base:
            return Path(base) / 'WaveForge' / 'cache'
    xdg_cache = os.environ.get('XDG_CACHE_HOME', '').strip()
    return (Path(xdg_cache) if xdg_cache else Path.home() / '.cache') / 'waveforge'


def _allowed_roots() -> list:
    """信任根列表：主白名单根 + 已知的「另一半」缓存位置。

    背景（真机 2026-10-22/10-24 两轮实锤）：dev 启动器拉起本服务**早于** Electron 主进程
    的 ConfigManager 跑完（Flask 00:37:36 起、主进程 00:37:50 起），此时 WAVEFORGE_CACHE_PATH
    是启动器根据 config.json 猜的；主进程随后做 legacy 判定/迁移后，AudioCache 实际落盘的
    根可能与之不同（C 盘 profile cache vs D 盘项目根 cache）——单一白名单根必然与实际下载
    目录劈叉，渲染层 POST /analyze 全部 400。

    修法：白名单同时信任「环境变量根」与「另一侧已知位置」。两个根都是 WaveForge 自有
    的可再生产缓存目录，多信任一个不扩大攻击面（路径校验仍要求 resolve(strict=True) 后
    是真实存在的文件且严格位于根下）。未知路径依旧拒绝。
    """
    roots = [_cache_root()]
    if os.name == 'nt':
        base = os.environ.get('LOCALAPPDATA', '').strip() or os.environ.get('APPDATA', '').strip()
        if base:
            roots.append(Path(base) / 'WaveForge' / 'cache')
        # dev 便携默认：仓库根 cache\（启动器/主进程的 legacy 回退目标）
        env_root = os.environ.get('WAVEFORGE_PROJECT_ROOT', '').strip()
        if env_root:
            roots.append(Path(env_root) / 'cache')
    xdg_cache = os.environ.get('XDG_CACHE_HOME', '').strip()
    roots.append((Path(xdg_cache) if xdg_cache else Path.home() / '.cache') / 'waveforge')
    # 去重（大小写不敏感的 Windows 下 resolve 前先按字符串去重即可，resolve 后再最终判定）
    seen = set()
    unique = []
    for root in roots:
        key = str(root).lower()
        if key not in seen:
            seen.add(key)
            unique.append(root)
    return unique


def is_allowed_audio_path(candidate: str) -> bool:
    """HTTP services may only read files materialized below WaveForge's cache roots."""
    if not isinstance(candidate, str) or not candidate.strip():
        return False
    try:
        audio_path = Path(candidate).expanduser().resolve(strict=True)
        if not audio_path.is_file():
            return False
        for root in _allowed_roots():
            try:
                cache_root = root.resolve(strict=True)
            except (OSError, RuntimeError, ValueError):
                continue
            if audio_path == cache_root or cache_root in audio_path.parents:
                return True
        return False
    except (OSError, RuntimeError, ValueError):
        return False

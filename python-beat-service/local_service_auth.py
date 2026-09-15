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


def is_allowed_audio_path(candidate: str) -> bool:
    """HTTP services may only read files materialized below WaveForge's cache root."""
    if not isinstance(candidate, str) or not candidate.strip():
        return False
    try:
        cache_root = _cache_root().resolve(strict=True)
        audio_path = Path(candidate).expanduser().resolve(strict=True)
        return audio_path.is_file() and (audio_path == cache_root or cache_root in audio_path.parents)
    except (OSError, RuntimeError, ValueError):
        return False

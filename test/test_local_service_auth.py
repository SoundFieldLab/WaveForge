import importlib.util
import os
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
AUTH_PATH = ROOT / 'python-beat-service' / 'local_service_auth.py'


def load_auth(token):
    previous = os.environ.get('WAVEFORGE_LOCAL_TOKEN')
    try:
        if token is None:
            os.environ.pop('WAVEFORGE_LOCAL_TOKEN', None)
        else:
            os.environ['WAVEFORGE_LOCAL_TOKEN'] = token
        spec = importlib.util.spec_from_file_location(f'waveforge_local_auth_{token}', AUTH_PATH)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module
    finally:
        if previous is None:
            os.environ.pop('WAVEFORGE_LOCAL_TOKEN', None)
        else:
            os.environ['WAVEFORGE_LOCAL_TOKEN'] = previous


class LocalServiceAuthTests(unittest.TestCase):
    def test_audio_path_must_resolve_inside_configured_cache(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            cache = root / 'cache'
            outside = root / 'outside'
            cache.mkdir()
            outside.mkdir()
            cached_audio = cache / 'cached.wav'
            outside_audio = outside / 'system.wav'
            cached_audio.write_bytes(b'audio')
            outside_audio.write_bytes(b'secret')
            previous = os.environ.get('WAVEFORGE_CACHE_PATH')
            os.environ['WAVEFORGE_CACHE_PATH'] = str(cache)
            try:
                auth = load_auth(None)
                self.assertTrue(auth.is_allowed_audio_path(str(cached_audio)))
                self.assertFalse(auth.is_allowed_audio_path(str(outside_audio)))
                link = cache / 'escape'
                try:
                    link.symlink_to(outside, target_is_directory=True)
                except OSError:
                    link = None
                if link is not None:
                    self.assertFalse(auth.is_allowed_audio_path(str(link / outside_audio.name)))
            finally:
                if previous is None:
                    os.environ.pop('WAVEFORGE_CACHE_PATH', None)
                else:
                    os.environ['WAVEFORGE_CACHE_PATH'] = previous

    def test_standalone_development_without_token_remains_compatible(self):
        auth = load_auth(None)
        self.assertTrue(auth.is_authorized_local_request(''))

    def test_health_requires_exact_token_in_token_mode(self):
        auth = load_auth('secret')
        self.assertFalse(auth.is_authorized_local_request(''))
        self.assertTrue(auth.is_authorized_local_request('secret'))

    def test_business_routes_require_exact_token(self):
        auth = load_auth('secret')
        self.assertFalse(auth.is_authorized_local_request(''))
        self.assertFalse(auth.is_authorized_local_request('wrong'))
        self.assertTrue(auth.is_authorized_local_request('secret'))


if __name__ == '__main__':
    unittest.main()

import os
import tempfile
import unittest
from pathlib import Path

os.environ.setdefault('WAVEFORGE_LOCAL_TOKEN', 'test-token')

import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'python-beat-service'))
from beat_analyzer import get_cache_key


class BeatAnalyzerCacheKeyTests(unittest.TestCase):
    def test_cache_key_changes_with_file_identity_and_source_signature(self):
        with tempfile.TemporaryDirectory() as directory:
            first = Path(directory) / 'first.wav'
            second = Path(directory) / 'second.wav'
            first.write_bytes(b'first')
            second.write_bytes(b'second')

            first_key = get_cache_key('track', 120, str(first), 'source-a')
            self.assertEqual(first_key, get_cache_key('track', 120, str(first), 'source-a'))
            self.assertNotEqual(first_key, get_cache_key('track', 120, str(second), 'source-a'))
            self.assertNotEqual(first_key, get_cache_key('track', 120, str(first), 'source-b'))

            first.write_bytes(b'first-updated')
            self.assertNotEqual(first_key, get_cache_key('track', 120, str(first), 'source-a'))

    def test_windows_path_case_is_normalized_when_platform_supports_it(self):
        with tempfile.TemporaryDirectory() as directory:
            audio = Path(directory) / 'track.wav'
            audio.write_bytes(b'audio')
            key = get_cache_key('track', 60, str(audio))
            self.assertEqual(key, get_cache_key('track', 60, str(audio.resolve())))


if __name__ == '__main__':
    unittest.main()

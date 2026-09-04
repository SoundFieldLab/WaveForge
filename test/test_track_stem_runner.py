import importlib.util
import struct
import sys
import tempfile
import unittest
import wave
from pathlib import Path
from unittest import mock

import numpy as np


ROOT = Path(__file__).parents[1]
WORKERS = ROOT / "desktop" / "workers"
sys.path.insert(0, str(WORKERS))
RUNNER_PATH = WORKERS / "track_stem_runner.py"
SPEC = importlib.util.spec_from_file_location("track_stem_runner", RUNNER_PATH)
runner = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(runner)


def write_pcm_wav(path: Path, seconds: int = 40, sample_rate: int = 100) -> None:
    frames = seconds * sample_rate
    values = np.linspace(-0.5, 0.5, frames, dtype=np.float32)
    pcm = np.clip(values * 32767, -32768, 32767).astype("<i2")
    with wave.open(str(path), "wb") as output:
        output.setnchannels(2)
        output.setsampwidth(2)
        output.setframerate(sample_rate)
        output.writeframes(np.repeat(pcm[:, None], 2, axis=1).tobytes())


def read_float32_wav(path: Path) -> np.ndarray:
    data = path.read_bytes()
    offset = data.index(b"data")
    size = struct.unpack_from("<I", data, offset + 4)[0]
    return np.frombuffer(data[offset + 8:offset + 8 + size], dtype="<f4").reshape(-1, 2).T


class TrackStemRunnerTests(unittest.TestCase):
    def test_window_context_chunk_lengths_atomicity_and_reconstruction(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            input_path = root / "track.wav"
            output_dir = root / "output"
            write_pcm_wav(input_path)
            observed = {}

            def fake_load(path, ffmpeg, mode, duration, start):
                observed.update(path=path, duration=duration, start=start)
                frames = round(duration * runner.demucs.SAMPLE_RATE)
                values = np.linspace(-0.25, 0.25, frames, dtype=np.float32)
                return np.repeat(values[None, :], 2, axis=0), runner.demucs.SAMPLE_RATE, start

            def fake_separate(_session, audio):
                weights = np.array([0.1, 0.2, 0.4, 0.3], dtype=np.float32)
                return np.stack([audio * weight for weight in weights]), 1024

            with mock.patch.object(runner.demucs, "load_audio_excerpt", side_effect=fake_load), \
                    mock.patch.object(runner.demucs, "separate", side_effect=fake_separate):
                result = runner.separate_core(object(), {
                    "inputPath": str(input_path),
                    "outputDir": str(output_dir),
                    "coreStart": 10,
                    "coreDuration": 12,
                    "contextSeconds": 2,
                    "chunkSeconds": 5,
                    "sampleRate": runner.demucs.SAMPLE_RATE,
                })

            self.assertEqual(observed["start"], 8)
            self.assertEqual(observed["duration"], 16)
            self.assertEqual([chunk["duration"] for chunk in result["chunks"]], [5, 5, 2])
            self.assertEqual(result["coreDuration"], 12)
            self.assertEqual(result["readDuration"], 16)
            self.assertFalse(list(output_dir.rglob("*.tmp")))
            for chunk in result["chunks"]:
                stems = [read_float32_wav(Path(chunk["files"][name])) for name in runner.demucs.STEM_NAMES]
                self.assertTrue(all(stem.shape[1] == chunk["frames"] for stem in stems))
                start_frame = round((chunk["startSeconds"] - 8) * runner.demucs.SAMPLE_RATE)
                expected_frames = chunk["frames"]
                full = np.linspace(-0.25, 0.25, 16 * runner.demucs.SAMPLE_RATE, dtype=np.float32)
                expected = np.repeat(full[None, start_frame:start_frame + expected_frames], 2, axis=0)
                np.testing.assert_allclose(sum(stems), expected, atol=1e-6)

    def test_rejects_invalid_chunk_and_core_lengths(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            input_path = root / "track.wav"
            write_pcm_wav(input_path)
            base = {
                "inputPath": str(input_path),
                "outputDir": str(root / "output"),
                "coreStart": 0,
                "coreDuration": 5,
            }
            with self.assertRaisesRegex(ValueError, "5 or 10"):
                runner.separate_core(object(), {**base, "chunkSeconds": 7})
            with self.assertRaisesRegex(ValueError, "<= 20"):
                runner.separate_core(object(), {**base, "coreDuration": 21})


if __name__ == "__main__":
    unittest.main()

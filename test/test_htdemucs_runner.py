import importlib.util
import json
import os
import struct
import tempfile
import time
import unittest
import wave
from pathlib import Path

import numpy as np


RUNNER_PATH = Path(__file__).parents[1] / "desktop" / "workers" / "htdemucs_runner.py"
SPEC = importlib.util.spec_from_file_location("htdemucs_runner", RUNNER_PATH)
runner = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(runner)


class _Tensor:
    name = "mix"
    shape = [1, 2, 16]


class FakeSession:
    def __init__(self):
        self.calls = 0

    def get_inputs(self):
        return [_Tensor()]

    def run(self, _outputs, feeds):
        self.calls += 1
        source = feeds["mix"]
        return [np.repeat(source[:, None, :, :], 4, axis=1)]


class HTDemucsRunnerTests(unittest.TestCase):
    def test_extract_tail_and_resample_to_stereo(self):
        mono = np.arange(80, dtype=np.float32)[None, :]
        excerpt, start = runner.extract_excerpt(mono, 10, "tail", 3)
        self.assertEqual(excerpt.shape, (1, 30))
        self.assertEqual(start, 5.0)
        stereo = runner.ensure_stereo(excerpt)
        converted = runner.resample_linear(stereo, 10, 20)
        self.assertEqual(converted.shape, (2, 60))
        np.testing.assert_array_equal(converted[0], converted[1])

    def test_overlap_add_uses_model_shape_and_preserves_length(self):
        session = FakeSession()
        audio = np.linspace(-0.5, 0.5, 40, dtype=np.float32)[None, :]
        audio = np.repeat(audio, 2, axis=0)
        stems, segment = runner.separate(session, audio)
        self.assertEqual(segment, 16)
        self.assertEqual(stems.shape, (4, 2, 40))
        self.assertGreater(session.calls, 1)
        self.assertTrue(np.isfinite(stems).all())
        for stem in stems:
            np.testing.assert_allclose(stem, audio, atol=1e-5)

    def test_writes_ieee_float32_wav(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "stem.wav"
            audio = np.zeros((2, 32), dtype=np.float32)
            runner.write_float32_wav(output, audio)
            data = output.read_bytes()
            self.assertEqual(data[:4], b"RIFF")
            self.assertEqual(data[8:12], b"WAVE")
            self.assertEqual(struct.unpack_from("<H", data, 20)[0], 3)
            self.assertEqual(struct.unpack_from("<I", data, 24)[0], 44_100)
            self.assertEqual(struct.unpack_from("<H", data, 34)[0], 32)

    def test_extracts_an_explicit_plan_window(self):
        audio = np.arange(100, dtype=np.float32)[None, :]
        excerpt, start = runner.extract_excerpt(audio, 10, "tail", 2, start_time=3.5)
        self.assertEqual(start, 3.5)
        np.testing.assert_array_equal(excerpt[0], np.arange(35, 55, dtype=np.float32))

    def test_explicit_window_near_end_does_not_shift_backwards(self):
        audio = np.arange(100, dtype=np.float32)[None, :]
        excerpt, start = runner.extract_excerpt(audio, 10, "head", 3, start_time=9)
        self.assertEqual(start, 9)
        np.testing.assert_array_equal(excerpt[0], np.arange(90, 100, dtype=np.float32))

    def test_wav_reader_decodes_only_the_requested_window(self):
        with tempfile.TemporaryDirectory() as directory:
            input_path = Path(directory) / "window.wav"
            values = np.arange(100, dtype=np.int16)
            with wave.open(str(input_path), "wb") as output:
                output.setnchannels(1)
                output.setsampwidth(2)
                output.setframerate(10)
                output.writeframes(values.astype("<i2").tobytes())
            excerpt, rate, start = runner.read_wav_excerpt(input_path, "head", 1, 7)
            self.assertEqual(rate, 10)
            self.assertEqual(start, 7)
            self.assertEqual(excerpt.shape, (1, 10))
            np.testing.assert_array_equal(excerpt[0], values[70:80].astype(np.float32) / 32768.0)

    def test_stem_evidence_is_absolute_and_finite(self):
        audio = np.zeros((2, runner.SAMPLE_RATE), dtype=np.float32)
        audio[:, runner.SAMPLE_RATE // 2:] = 0.1
        evidence = runner.stem_evidence(audio, 12.5)
        self.assertEqual(len(evidence), 20)
        self.assertAlmostEqual(evidence[0]["time"], 12.5)
        self.assertLessEqual(evidence[0]["db"], -100)
        self.assertGreater(evidence[-1]["activity"], 0)

    def test_residual_other_reconstructs_original_mix(self):
        rng = np.random.default_rng(42)
        excerpt = rng.normal(0, 0.1, (2, 64)).astype(np.float32)
        drums = rng.normal(0, 0.02, (2, 64)).astype(np.float32)
        bass = rng.normal(0, 0.02, (2, 64)).astype(np.float32)
        vocals = rng.normal(0, 0.02, (2, 64)).astype(np.float32)
        other = excerpt - drums - bass - vocals
        np.testing.assert_allclose(drums + bass + vocals + other, excerpt, atol=1e-7)

    def test_rejects_duration_over_thirty_seconds(self):
        with self.assertRaisesRegex(ValueError, "<= 30"):
            runner.extract_excerpt(np.zeros((2, 100), dtype=np.float32), 10, "head", 30.1)


@unittest.skipUnless(os.environ.get("WAVEFORGE_RUN_HTDEMUCS_BENCHMARK") == "1", "set WAVEFORGE_RUN_HTDEMUCS_BENCHMARK=1")
class HTDemucsRealModelBenchmark(unittest.TestCase):
    def test_local_folia_model_separates_audio(self):
        appdata = Path(os.environ.get("APPDATA", ""))
        models = appdata / "Folia" / "models"
        model = models / "htdemucs.onnx"
        if not model.is_file():
            self.skipTest(f"model not found: {model}")
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            input_path = root / "input.wav"
            output_dir = root / "stems"
            sample_count = runner.SAMPLE_RATE
            t = np.arange(sample_count, dtype=np.float32) / runner.SAMPLE_RATE
            tone = (0.1 * np.sin(2 * np.pi * 220 * t)).astype(np.float32)
            pcm = np.clip(tone * 32767, -32768, 32767).astype("<i2")
            with wave.open(str(input_path), "wb") as output:
                output.setnchannels(2)
                output.setsampwidth(2)
                output.setframerate(runner.SAMPLE_RATE)
                output.writeframes(np.repeat(pcm[:, None], 2, axis=1).tobytes())
            started = time.perf_counter()
            manifest = runner.run({
                "inputPath": str(input_path),
                "modelPath": str(model),
                "outputDir": str(output_dir),
                "mode": "head",
                "duration": 1,
            })
            elapsed = time.perf_counter() - started
            self.assertEqual(manifest["frames"], sample_count)
            self.assertEqual(manifest["sampleRate"], 44_100)
            self.assertTrue(manifest["validation"]["finite"])
            self.assertTrue(all(Path(value).is_file() for value in manifest["files"].values()))
            print(json.dumps({"htdemucsBenchmarkSeconds": round(elapsed, 3), "frames": sample_count}))


if __name__ == "__main__":
    unittest.main()

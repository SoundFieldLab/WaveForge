import importlib.util
import tempfile
import unittest
from pathlib import Path

import numpy as np
import soundfile as sf


WORKER_PATH = Path(__file__).parents[1] / "desktop" / "workers" / "render_worker.py"
SPEC = importlib.util.spec_from_file_location("render_worker", WORKER_PATH)
worker = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(worker)


class StemRenderTests(unittest.TestCase):
    def test_piecewise_gain_hits_keyframes(self):
        gain = worker._piecewise_gain([
            {"time": 0, "gain": 1},
            {"time": 0.5, "gain": 1},
            {"time": 0.506, "gain": 0},
            {"time": 1, "gain": 0},
        ], 1001, 1000)
        self.assertAlmostEqual(float(gain[0]), 1, places=6)
        self.assertAlmostEqual(float(gain[500]), 1, places=6)
        self.assertAlmostEqual(float(gain[506]), 0, places=6)
        self.assertTrue(np.isfinite(gain).all())

    def test_stem_mix_uses_independent_envelopes_and_reports_finite_audio(self):
        sr = 1000
        frames = 1000
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            files = {"source": {}, "target": {}}
            levels = {"vocals": 0.1, "drums": 0.2, "bass": 0.3, "other": 0.4}
            for side, sign in (("source", 1), ("target", -1)):
                for stem, level in levels.items():
                    path = root / f"{side}-{stem}.wav"
                    sf.write(path, np.full((frames, 2), sign * level, dtype=np.float32), sr, subtype="FLOAT")
                    files[side][stem] = str(path)
            choreography = {
                "vocals": {"source": [{"time": 0, "gain": 1}, {"time": 0.4, "gain": 0}], "target": [{"time": 0, "gain": 0}, {"time": 0.6, "gain": 1}]},
                "drums": {"source": [{"time": 0, "gain": 1}, {"time": 0.5, "gain": 1}, {"time": 0.506, "gain": 0}], "target": [{"time": 0, "gain": 0}, {"time": 0.5, "gain": 0}, {"time": 0.506, "gain": 1}]},
                "bass": {"source": [{"time": 0, "gain": 1}, {"time": 0.7, "gain": 0}], "target": [{"time": 0, "gain": 0}, {"time": 0.7, "gain": 1}]},
                "other": {"source": [{"time": 0, "gain": 1}, {"time": 1, "gain": 0}], "target": [{"time": 0, "gain": 0}, {"time": 1, "gain": 1}]},
            }
            plan = {
                "sourceStartTime": 0, "sourceEndTime": 1,
                "targetStartTime": 0, "targetEndTime": 1,
                "sourceBeatTimes": [0, 0.5, 1], "targetBeatTimes": [0, 0.5, 1],
                "gainOffsetDb": 0,
                "v2": {
                    "withoutBeatGrid": True,
                    "stemChoreography": choreography,
                    "stemArtifacts": {
                        "source": {"startSeconds": 0, "files": files["source"]},
                        "target": {"startSeconds": 0, "files": files["target"]},
                    },
                },
            }
            output = worker._render_stem_mix(plan, sr, frames, [0.5, 0.5], True)
            self.assertIsNotNone(output)
            self.assertEqual(output.shape, (2, frames))
            self.assertTrue(np.isfinite(output).all())
            # Before all handoffs source is positive; after all handoffs target is negative.
            self.assertGreater(float(np.mean(output[:, :100])), 0)
            self.assertLess(float(np.mean(output[:, -100:])), 0)
    def test_v2_renderer_rejects_a_folia_plan(self):
        result = worker.render_transition_v2({
            "plan": {
                "sourceTrackKey": "source", "targetTrackKey": "target",
                "sourceStartTime": 0, "sourceEndTime": 1,
                "targetStartTime": 0, "targetEndTime": 1,
                "v2": {"backend": "folia-htdemucs"},
            },
            "sourceAudioPath": "missing-source.wav",
            "targetAudioPath": "missing-target.wav",
            "outputPath": "missing-output.wav",
        })
        self.assertFalse(result["success"])
        self.assertIn("render_folia", result["error"])

    def test_render_folia_uses_only_stem_artifacts_and_reports_backend(self):
        sr = 1000
        frames = 1000
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            files = {"source": {}, "target": {}}
            for side, sign in (("source", 1), ("target", -1)):
                for stem, level in {"vocals": 0.1, "drums": 0.2, "bass": 0.3, "other": 0.4}.items():
                    path = root / f"{side}-{stem}.wav"
                    sf.write(path, np.full((frames, 2), sign * level, dtype=np.float32), sr, subtype="FLOAT")
                    files[side][stem] = str(path)
            choreography = {
                stem: {
                    "source": [{"time": 0, "gain": 1}, {"time": 1, "gain": 0}],
                    "target": [{"time": 0, "gain": 0}, {"time": 1, "gain": 1}],
                }
                for stem in ("vocals", "drums", "bass", "other")
            }
            output_path = root / "folia.wav"
            plan = {
                "sourceTrackKey": "source", "targetTrackKey": "target",
                "sourceStartTime": 0, "sourceEndTime": 1,
                "targetStartTime": 0, "targetEndTime": 1,
                "beatCount": 2, "sourceBpm": 120, "targetBpm": 120,
                "sourceBeatTimes": [0, 0.5, 1], "targetBeatTimes": [0, 0.5, 1],
                "gainOffsetDb": 0, "rendererVersion": "folia-test",
                "v2": {
                    "backend": "folia-htdemucs", "beatProvider": "beat_this",
                    "withoutBeatGrid": True, "stemChoreography": choreography,
                    "stemArtifacts": {
                        "source": {"startSeconds": 0, "files": files["source"]},
                        "target": {"startSeconds": 0, "files": files["target"]},
                    },
                },
            }
            result = worker.render_transition_folia({
                "plan": plan,
                "sourceAudioPath": files["source"]["vocals"],
                "targetAudioPath": str(root / "missing-full-mix.wav"),
                "outputPath": str(output_path),
            })
            self.assertTrue(result["success"])
            self.assertEqual(result["backend"], "folia-htdemucs")
            self.assertEqual(result["beatProvider"], "beat_this")
            self.assertTrue(result["stemMixApplied"])
            self.assertFalse(result["djEffectsApplied"])
            self.assertEqual(result["targetResumeTime"], 1)
            audio, rate = sf.read(output_path, always_2d=True)
            self.assertEqual(rate, sr)
            self.assertTrue(np.isfinite(audio).all())


if __name__ == "__main__":
    unittest.main()

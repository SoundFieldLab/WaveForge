#!/usr/bin/env python3
"""Dependency-light contract tests for the Beat This analysis worker."""

import importlib.util
import os
from pathlib import Path


WORKER_PATH = Path(__file__).with_name("analysis_worker.py")
_spec = importlib.util.spec_from_file_location("analysis_worker", WORKER_PATH)
_worker = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_worker)


def test_normalize_timing_is_finite_and_ascending():
    assert _worker.normalize_timing([2.0, float("nan"), 1.0, 2.0, float("inf"), -1.0]) == [-1.0, 1.0, 2.0]


def test_normalize_confidence_matches_timing_count():
    assert _worker.normalize_confidence([0.4, float("nan")], 4) == [0.4, 0.0, 0.0, 0.0]


def test_status_failed_when_model_is_unavailable(monkeypatch):
    monkeypatch.setattr(_worker, "BEAT_THIS_AVAILABLE", False)
    monkeypatch.setattr(_worker, "BEAT_THIS_IMPORT_ERROR", "Beat This import unavailable")
    worker = _worker.AnalysisWorker()
    status = worker.get_status()
    assert status["status"] == "failed"
    assert status["beatThisAvailable"] is False
    assert status["model"] == Path(os.environ.get("BEAT_THIS_CHECKPOINT", "final0")).name
    assert status["provider"] == "unavailable"
    assert "\\" not in status.get("error", "")


def test_checkpoint_comes_from_environment(monkeypatch):
    monkeypatch.setenv("BEAT_THIS_CHECKPOINT", "checkpoints/custom")
    monkeypatch.setattr(_worker, "BEAT_THIS_AVAILABLE", False)
    worker = _worker.AnalysisWorker()
    assert worker.checkpoint_path == "checkpoints/custom"
    assert worker.get_status()["model"] == "custom"


def test_safe_error_removes_full_paths():
    assert _worker.safe_error(FileNotFoundError("Audio file not found: C:\\Users\\private\\song.wav")) == "song.wav"


if __name__ == "__main__":
    raise SystemExit("Run with pytest")

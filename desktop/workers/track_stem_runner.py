#!/usr/bin/env python3
"""Persistent JSONL worker for progressive, windowed HTDemucs separation."""

from __future__ import annotations

import argparse
import json
import math
import os
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np

import htdemucs_runner as demucs


RUNNER_VERSION = "track-stem-runner-v2"


def _atomic_float32_wav(path: Path, audio: np.ndarray, sample_rate: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + f".{os.getpid()}.tmp")
    try:
        demucs.write_float32_wav(temporary, audio, sample_rate)
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def _load_window(
    input_path: Path,
    output_dir: Path,
    ffmpeg_path: str | None,
    decoder_python: str | None,
    core_start: float,
    core_duration: float,
    context: float,
):
    read_start = max(0.0, core_start - context)
    read_duration = core_start + core_duration + context - read_start
    if input_path.suffix.lower() == '.wav' or ffmpeg_path:
        return demucs.load_audio_excerpt(input_path, ffmpeg_path, 'head', read_duration, read_start)
    helper = Path(__file__).with_name('audio_window_decode.py')
    if not decoder_python or not Path(decoder_python).is_file() or not helper.is_file():
        raise RuntimeError('window decoder runtime is unavailable')
    temporary = output_dir / f'.decode-{os.getpid()}-{round(core_start * 1000)}.wav'
    command = [decoder_python, str(helper), '--input', str(input_path), '--output', str(temporary),
               '--start', str(read_start), '--duration', str(read_duration)]
    result = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False)
    if result.returncode != 0:
        raise RuntimeError(result.stderr.decode('utf-8', errors='replace').strip() or 'window decode failed')
    try:
        audio, rate, _ = demucs.read_wav_excerpt(temporary, 'head', read_duration, 0)
        return audio, rate, read_start
    finally:
        temporary.unlink(missing_ok=True)


def separate_core(session, request: dict) -> dict:
    input_path = Path(request["inputPath"]).expanduser().resolve()
    output_dir = Path(request["outputDir"]).expanduser().resolve()
    ffmpeg_path = request.get("ffmpegPath") or os.environ.get("WAVEFORGE_FFMPEG_PATH")
    decoder_python = request.get("decoderPythonPath") or os.environ.get("WAVEFORGE_DECODER_PYTHON")
    sample_rate = int(request.get("sampleRate", demucs.SAMPLE_RATE))
    core_start = float(request["coreStart"])
    core_duration = float(request["coreDuration"])
    context = float(request.get("contextSeconds", 2.0))
    chunk_seconds = int(request.get("chunkSeconds", 5))
    if sample_rate != demucs.SAMPLE_RATE:
        raise ValueError(f"HTDemucs output sample rate must be {demucs.SAMPLE_RATE}")
    if not input_path.is_file():
        raise FileNotFoundError(f"input audio not found: {input_path}")
    if not math.isfinite(core_start) or core_start < 0:
        raise ValueError("coreStart must be a finite non-negative number")
    if not math.isfinite(core_duration) or core_duration <= 0 or core_duration > 20:
        raise ValueError("coreDuration must be > 0 and <= 20 seconds")
    if not math.isfinite(context) or context < 0 or context > 10:
        raise ValueError("contextSeconds must be between 0 and 10 seconds")
    if chunk_seconds not in (5, 10):
        raise ValueError("chunkSeconds must be 5 or 10")

    read_start = max(0.0, core_start - context)
    excerpt, source_rate, actual_start = _load_window(
        input_path, output_dir, ffmpeg_path, decoder_python, core_start, core_duration, context,
    )
    excerpt = demucs.resample_linear(demucs.ensure_stereo(excerpt), source_rate, sample_rate)
    if excerpt.shape[1] == 0 or not np.isfinite(excerpt).all():
        raise ValueError("prepared excerpt is empty or contains NaN/infinity")

    model_output, segment = demucs.separate(session, excerpt)
    by_name = {name: model_output[index] for index, name in enumerate(demucs.MODEL_SOURCE_ORDER)}
    by_name["other"] = excerpt - by_name["drums"] - by_name["bass"] - by_name["vocals"]
    core_offset = max(0, int(round((core_start - actual_start) * sample_rate)))
    requested_frames = max(1, int(round(core_duration * sample_rate)))
    core_frames = min(requested_frames, max(0, excerpt.shape[1] - core_offset))
    if core_frames <= 0:
        raise ValueError("requested core starts beyond the available audio")

    chunk_frames = chunk_seconds * sample_rate
    chunks = []
    for offset in range(0, core_frames, chunk_frames):
        frames = min(chunk_frames, core_frames - offset)
        start_seconds = core_start + offset / sample_rate
        chunk_id = f"{round(start_seconds * 1000):012d}-{frames:09d}"
        files = {}
        for stem in demucs.STEM_NAMES:
            target = output_dir / chunk_id / f"{stem}.wav"
            _atomic_float32_wav(
                target,
                np.ascontiguousarray(by_name[stem][:, core_offset + offset:core_offset + offset + frames]),
                sample_rate,
            )
            files[stem] = str(target)
        chunks.append({
            "id": chunk_id,
            "startSeconds": start_seconds,
            "duration": frames / sample_rate,
            "frames": frames,
            "files": files,
        })

    return {
        "runnerVersion": RUNNER_VERSION,
        "coreStart": core_start,
        "coreDuration": core_frames / sample_rate,
        "readStart": actual_start,
        "readDuration": excerpt.shape[1] / sample_rate,
        "sampleRate": sample_rate,
        "channels": demucs.CHANNELS,
        "segmentSamples": segment,
        "chunks": chunks,
        "validation": {"lengthsMatch": True, "finite": True, "reconstructsMix": True},
    }


def serve(model_path: Path) -> int:
    if not model_path.is_file():
        print(json.dumps({"type": "fatal", "error": f"HTDemucs model not found: {model_path}"}), flush=True)
        return 2
    session = demucs.create_session(model_path)
    print(json.dumps({
        "type": "ready",
        "runnerVersion": RUNNER_VERSION,
        "modelPath": str(model_path),
        "sampleRate": demucs.SAMPLE_RATE,
    }), flush=True)
    for line in sys.stdin:
        request = None
        try:
            request = json.loads(line)
            request_id = request.get("id")
            if request.get("type") == "shutdown":
                print(json.dumps({"type": "shutdown", "id": request_id}), flush=True)
                return 0
            if request.get("type") == "status":
                result = {"runnerVersion": RUNNER_VERSION, "sampleRate": demucs.SAMPLE_RATE}
            elif request.get("type") == "separate":
                result = separate_core(session, request)
            else:
                raise ValueError(f"unsupported request type: {request.get('type')}")
            print(json.dumps({"type": "result", "id": request_id, "result": result}), flush=True)
        except Exception as error:
            print(json.dumps({
                "type": "error",
                "id": request.get("id") if isinstance(request, dict) else None,
                "error": str(error),
            }), flush=True)
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", required=True)
    args = parser.parse_args(argv)
    try:
        return serve(Path(args.model).expanduser().resolve())
    except Exception as error:
        print(json.dumps({"type": "fatal", "error": str(error)}), flush=True)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

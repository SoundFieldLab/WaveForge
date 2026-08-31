#!/usr/bin/env python3
# 私有模块（Private Module）—— 见仓库根 PRIVATE-LICENSE.md。
"""Run the local HTDemucs ONNX model for a short head or tail excerpt."""

from __future__ import annotations

import argparse
import json
import math
import os
import struct
import subprocess
import sys
import wave
from pathlib import Path

import numpy as np


SAMPLE_RATE = 44_100
CHANNELS = 2
MAX_DURATION_SECONDS = 30.0
OVERLAP = 0.25
STEM_NAMES = ("drums", "bass", "vocals", "other")
# The published HTDemucs tensor order differs from the product-facing order.
MODEL_SOURCE_ORDER = ("drums", "bass", "other", "vocals")


def _decode_pcm(raw: bytes, sample_width: int) -> np.ndarray:
    if sample_width == 1:
        return (np.frombuffer(raw, dtype=np.uint8).astype(np.float32) - 128.0) / 128.0
    if sample_width == 2:
        return np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
    if sample_width == 3:
        values = np.frombuffer(raw, dtype=np.uint8).reshape(-1, 3).astype(np.int32)
        values = values[:, 0] | (values[:, 1] << 8) | (values[:, 2] << 16)
        values = np.where(values & 0x800000, values - 0x1000000, values)
        return values.astype(np.float32) / 8388608.0
    if sample_width == 4:
        return np.frombuffer(raw, dtype="<i4").astype(np.float32) / 2147483648.0
    raise ValueError(f"unsupported PCM sample width: {sample_width}")


def read_wav_excerpt(
    path: Path,
    mode: str,
    duration: float,
    start_time: float | None,
) -> tuple[np.ndarray, int, float]:
    """Read only the requested PCM WAV window, never the whole track."""
    with wave.open(str(path), "rb") as source:
        if source.getcomptype() != "NONE":
            raise ValueError(f"compressed WAV is unsupported: {source.getcomptype()}")
        channels = source.getnchannels()
        sample_rate = source.getframerate()
        width = source.getsampwidth()
        total = source.getnframes()
        requested = max(1, int(round(duration * sample_rate)))
        if start_time is not None:
            start = min(max(0, int(round(start_time * sample_rate))), max(0, total - 1))
        else:
            start = 0 if mode == "head" else max(0, total - requested)
        count = min(requested, total - start)
        source.setpos(start)
        raw = source.readframes(count)
    audio = _decode_pcm(raw, width)
    if channels <= 0 or audio.size % channels:
        raise ValueError("invalid WAV channel layout")
    audio = audio.reshape(-1, channels).T
    if not np.isfinite(audio).all():
        raise ValueError("input audio contains NaN or infinity")
    return np.ascontiguousarray(audio, dtype=np.float32), sample_rate, start / sample_rate


def _decode_with_ffmpeg(
    input_path: Path,
    ffmpeg_path: str,
    mode: str,
    duration: float,
    start_time: float | None,
) -> tuple[np.ndarray, int, float]:
    command = [ffmpeg_path, "-v", "error"]
    if start_time is not None:
        command += ["-ss", str(start_time)]
        actual_start = start_time
    elif mode == "tail":
        command += ["-sseof", str(-duration)]
        actual_start = 0.0  # exact absolute start is unavailable without probing; renderer uses WAV inputs.
    else:
        actual_start = 0.0
    command += ["-i", str(input_path), "-t", str(duration), "-f", "s16le",
                "-acodec", "pcm_s16le", "-ar", str(SAMPLE_RATE), "-ac", str(CHANNELS), "-"]
    result = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False)
    if result.returncode != 0:
        detail = result.stderr.decode("utf-8", errors="replace").strip()
        raise RuntimeError(f"ffmpeg audio decode failed: {detail or result.returncode}")
    samples = np.frombuffer(result.stdout, dtype="<i2").astype(np.float32) / 32768.0
    if samples.size % CHANNELS:
        raise ValueError("ffmpeg returned an incomplete audio frame")
    return np.ascontiguousarray(samples.reshape(-1, CHANNELS).T), SAMPLE_RATE, actual_start


def load_audio_excerpt(
    input_path: Path,
    ffmpeg_path: str | None,
    mode: str,
    duration: float,
    start_time: float | None,
) -> tuple[np.ndarray, int, float]:
    if input_path.suffix.lower() == ".wav":
        try:
            return read_wav_excerpt(input_path, mode, duration, start_time)
        except (wave.Error, ValueError):
            if not ffmpeg_path:
                raise
    if not ffmpeg_path:
        raise RuntimeError("non-PCM WAV input requires an injected ffmpegPath")
    return _decode_with_ffmpeg(input_path, ffmpeg_path, mode, duration, start_time)


def ensure_stereo(audio: np.ndarray) -> np.ndarray:
    if audio.shape[0] == 1:
        return np.repeat(audio, 2, axis=0)
    if audio.shape[0] == 2:
        return audio
    # Music is normally stereo; use the front pair for multichannel files.
    return audio[:2]


def resample_linear(audio: np.ndarray, source_rate: int, target_rate: int = SAMPLE_RATE) -> np.ndarray:
    if source_rate == target_rate:
        return np.ascontiguousarray(audio, dtype=np.float32)
    if source_rate <= 0 or audio.shape[1] == 0:
        raise ValueError("invalid source sample rate or empty audio")
    output_frames = max(1, int(round(audio.shape[1] * target_rate / source_rate)))
    source_positions = np.arange(audio.shape[1], dtype=np.float64)
    target_positions = np.arange(output_frames, dtype=np.float64) * source_rate / target_rate
    target_positions = np.minimum(target_positions, audio.shape[1] - 1)
    return np.stack([
        np.interp(target_positions, source_positions, channel).astype(np.float32)
        for channel in audio
    ])


def extract_excerpt(
    audio: np.ndarray,
    sample_rate: int,
    mode: str,
    duration: float,
    start_time: float | None = None,
) -> tuple[np.ndarray, float]:
    duration = float(duration)
    if not math.isfinite(duration) or duration <= 0 or duration > MAX_DURATION_SECONDS:
        raise ValueError(f"duration must be > 0 and <= {MAX_DURATION_SECONDS:g} seconds")
    requested = max(1, int(round(duration * sample_rate)))
    if start_time is not None:
        start_seconds = float(start_time)
        if not math.isfinite(start_seconds) or start_seconds < 0:
            raise ValueError("startTime must be a finite non-negative number")
        start = min(max(0, int(round(start_seconds * sample_rate))), max(0, audio.shape[1] - 1))
        count = min(requested, audio.shape[1] - start)
    else:
        count = min(requested, audio.shape[1])
        start = 0 if mode == "head" else audio.shape[1] - count
    return np.ascontiguousarray(audio[:, start:start + count]), start / sample_rate


def create_session(model_path: Path):
    import onnxruntime as ort

    options = ort.SessionOptions()
    options.intra_op_num_threads = 4
    options.inter_op_num_threads = 1
    options.enable_cpu_mem_arena = False
    options.enable_mem_reuse = False
    options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
    return ort.InferenceSession(str(model_path), sess_options=options, providers=["CPUExecutionProvider"])


def model_segment_samples(session) -> tuple[str, int]:
    inputs = session.get_inputs()
    if len(inputs) != 1:
        raise ValueError(f"expected one model input, found {len(inputs)}")
    shape = inputs[0].shape
    if len(shape) != 3 or shape[0] not in (1, "1") or shape[1] not in (2, "2"):
        raise ValueError(f"unsupported HTDemucs input shape: {shape}")
    try:
        segment = int(shape[2])
    except (TypeError, ValueError) as error:
        raise ValueError(f"HTDemucs model requires a fixed segment shape: {shape}") from error
    if segment <= 0:
        raise ValueError(f"invalid HTDemucs segment length: {segment}")
    return inputs[0].name, segment


def separate(session, audio: np.ndarray) -> tuple[np.ndarray, int]:
    input_name, segment = model_segment_samples(session)
    frame_count = audio.shape[1]
    overlap = max(1, segment // 4)
    hop = segment - overlap
    # 25% edge overlap-add: linear ramps only inside the shared quarters, flat in the middle.
    window = np.ones(segment, dtype=np.float32)
    # Keep a non-zero endpoint so OLA preserves every input sample without post-hoc copying.
    ramp = np.linspace(1.0 / overlap, 1.0, overlap, dtype=np.float32)
    window[:overlap] = ramp
    window[-overlap:] = ramp[::-1]
    output = np.zeros((4, CHANNELS, frame_count), dtype=np.float32)
    weights = np.zeros(frame_count, dtype=np.float32)
    raw_audio = np.ascontiguousarray(audio, dtype=np.float32)

    chunk_count = max(1, math.ceil(frame_count / hop))
    starts = [index * hop for index in range(chunk_count)]
    for start in starts:
        end = min(start + segment, frame_count)
        if end <= start:
            break
        available = end - start
        model_input = np.zeros((1, CHANNELS, segment), dtype=np.float32)
        model_input[0, :, :available] = raw_audio[:, start:end]
        prediction = np.asarray(session.run(None, {input_name: model_input})[0], dtype=np.float32)
        if prediction.shape != (1, 4, CHANNELS, segment):
            raise ValueError(f"unexpected HTDemucs output shape: {prediction.shape}")
        prediction = prediction[0, :, :, :available]
        current_window = window[:available]
        output[:, :, start:start + available] += prediction * current_window[None, None, :]
        weights[start:start + available] += current_window

    if np.any(weights <= 0):
        raise RuntimeError("overlap-add left uncovered output samples")
    output /= weights[None, None, :]
    return output, segment


def stem_evidence(audio: np.ndarray, start_seconds: float, sample_rate: int = SAMPLE_RATE) -> list[dict]:
    """Compact 50ms dB/activity evidence consumed by the pure TypeScript stem planner."""
    hop = max(1, int(round(0.05 * sample_rate)))
    mono = np.mean(audio, axis=0)
    points = []
    previous_db = -120.0
    for offset in range(0, mono.size, hop):
        frame = mono[offset:min(mono.size, offset + hop)]
        rms = float(np.sqrt(np.mean(frame * frame))) if frame.size else 0.0
        db = max(-120.0, 20.0 * math.log10(max(rms, 1e-12)))
        onset = max(0.0, min(1.0, (db - previous_db) / 18.0))
        presence = max(0.0, min(1.0, (db + 60.0) / 48.0))
        points.append({
            "time": round(start_seconds + offset / sample_rate, 4),
            "db": round(db, 3),
            "activity": round(max(presence, onset), 4),
        })
        previous_db = db
    return points


def write_float32_wav(path: Path, audio: np.ndarray, sample_rate: int = SAMPLE_RATE) -> None:
    if audio.ndim != 2 or audio.shape[0] != CHANNELS:
        raise ValueError("stem output must be stereo")
    interleaved = np.ascontiguousarray(audio.T, dtype="<f4").tobytes()
    byte_rate = sample_rate * CHANNELS * 4
    block_align = CHANNELS * 4
    fmt = struct.pack("<HHIIHH", 3, CHANNELS, sample_rate, byte_rate, block_align, 32)
    riff_size = 4 + (8 + len(fmt)) + (8 + len(interleaved))
    with path.open("wb") as output:
        output.write(struct.pack("<4sI4s", b"RIFF", riff_size, b"WAVE"))
        output.write(struct.pack("<4sI", b"fmt ", len(fmt)))
        output.write(fmt)
        output.write(struct.pack("<4sI", b"data", len(interleaved)))
        output.write(interleaved)


def run(config: dict) -> dict:
    input_path = Path(config["inputPath"]).expanduser().resolve()
    model_path = Path(config["modelPath"]).expanduser().resolve()
    output_dir = Path(config["outputDir"]).expanduser().resolve()
    mode = str(config.get("mode", "head")).lower()
    duration = float(config.get("duration", MAX_DURATION_SECONDS))
    start_time = config.get("startTime")
    ffmpeg_path = config.get("ffmpegPath") or os.environ.get("WAVEFORGE_FFMPEG_PATH")
    if mode not in ("head", "tail"):
        raise ValueError("mode must be 'head' or 'tail'")
    if not input_path.is_file():
        raise FileNotFoundError(f"input audio not found: {input_path}")
    if not model_path.is_file():
        raise FileNotFoundError(f"HTDemucs model not found: {model_path}")
    output_dir.mkdir(parents=True, exist_ok=True)

    excerpt, source_rate, start_seconds = load_audio_excerpt(
        input_path, ffmpeg_path, mode, duration, start_time,
    )
    source_channels = int(excerpt.shape[0])
    excerpt = resample_linear(ensure_stereo(excerpt), source_rate)
    if excerpt.shape[1] == 0 or not np.isfinite(excerpt).all():
        raise ValueError("prepared excerpt is empty or contains NaN/infinity")

    session = create_session(model_path)
    model_output, segment = separate(session, excerpt)
    if model_output.shape[2] != excerpt.shape[1] or not np.isfinite(model_output).all():
        raise RuntimeError("stem output length mismatch or NaN/infinity detected")

    by_name = {name: model_output[index] for index, name in enumerate(MODEL_SOURCE_ORDER)}
    # Preserve exact reconstruction for automation: the residual is the original excerpt minus
    # drums/bass/vocals. This prevents model stem-sum error from changing overall tone/loudness.
    by_name["other"] = excerpt - by_name["drums"] - by_name["bass"] - by_name["vocals"]
    files = {}
    evidence = {}
    for name in STEM_NAMES:
        stem_path = output_dir / f"{name}.wav"
        write_float32_wav(stem_path, by_name[name])
        files[name] = str(stem_path)
        evidence[name] = stem_evidence(by_name[name], start_seconds)

    manifest = {
        "version": 1,
        "engine": "htdemucs-onnx-cpu",
        "inputPath": str(input_path),
        "modelPath": str(model_path),
        "mode": mode,
        "requestedDuration": duration,
        "startSeconds": start_seconds,
        "duration": excerpt.shape[1] / SAMPLE_RATE,
        "sourceSampleRate": source_rate,
        "sourceChannels": source_channels,
        "sampleRate": SAMPLE_RATE,
        "channels": CHANNELS,
        "frames": int(excerpt.shape[1]),
        "segmentSamples": segment,
        "overlap": OVERLAP,
        "files": files,
        "evidence": evidence,
        "validation": {"lengthsMatch": True, "finite": True},
    }
    manifest_path = output_dir / "manifest.json"
    manifest["manifestPath"] = str(manifest_path)
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    return manifest


def parse_config(argv: list[str] | None = None) -> dict:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("config", nargs="?", help="JSON config file")
    parser.add_argument("--config", dest="config_option", help="JSON config file")
    parser.add_argument("--input", dest="inputPath")
    parser.add_argument("--model", dest="modelPath")
    parser.add_argument("--output", dest="outputDir")
    parser.add_argument("--mode", choices=("head", "tail"), default=None)
    parser.add_argument("--duration", type=float, default=None)
    parser.add_argument("--start-time", dest="startTime", type=float, default=None)
    parser.add_argument("--ffmpeg", dest="ffmpegPath", default=None)
    args = parser.parse_args(argv)
    config_path = args.config_option or args.config
    config = {}
    if config_path:
        config = json.loads(Path(config_path).read_text(encoding="utf-8"))
    for key in ("inputPath", "modelPath", "outputDir", "mode", "duration", "startTime", "ffmpegPath"):
        value = getattr(args, key)
        if value is not None:
            config[key] = value
    missing = [key for key in ("inputPath", "modelPath", "outputDir") if not config.get(key)]
    if missing:
        parser.error("missing required configuration: " + ", ".join(missing))
    return config


def main(argv: list[str] | None = None) -> int:
    try:
        manifest = run(parse_config(argv))
        print(json.dumps(manifest, ensure_ascii=False), flush=True)
        return 0
    except Exception as error:
        print(json.dumps({"error": str(error)}, ensure_ascii=False), file=sys.stderr, flush=True)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

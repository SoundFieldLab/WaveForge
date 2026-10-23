"""Turn the MIT KEMAR compact WAV archive into a reproducible Worklet data module.

The archive contains only the positive azimuth hemisphere. The runtime mirrors
negative azimuths by swapping ears, preserving every measured direction.
"""

from __future__ import annotations

import base64
import json
from pathlib import Path
import re
import wave
import zipfile
from io import BytesIO


ROOT = Path(__file__).resolve().parents[1]
ARCHIVE = ROOT / "vendor/kemar/compact.zip"
OUTPUT = ROOT / "src/services/waveforge-engine-v3/src/spatial/kemarData.ts"
NAME = re.compile(r"^elev(-?\d+)/H-?\d+e(\d+)a\.wav$")


def main() -> None:
    rings: dict[int, list[tuple[int, bytes]]] = {}
    with zipfile.ZipFile(ARCHIVE) as archive:
        for name in archive.namelist():
            match = NAME.fullmatch(name)
            if not match:
                continue
            elevation, azimuth = map(int, match.groups())
            with wave.open(BytesIO(archive.read(name))) as wav:
                if (wav.getframerate(), wav.getnchannels(), wav.getsampwidth(), wav.getnframes()) != (44100, 2, 2, 128):
                    raise ValueError(f"Unexpected KEMAR format: {name}")
                pcm = wav.readframes(128)
            rings.setdefault(elevation, []).append((azimuth, pcm))

    if sorted(rings) != list(range(-40, 91, 10)) or sum(map(len, rings.values())) != 368:
        raise ValueError("The KEMAR archive is incomplete")

    metadata = []
    pcm = bytearray()
    for elevation, directions in sorted(rings.items()):
        directions.sort()
        azimuths = [az for az, _ in directions]
        if azimuths[0] != 0 or len(azimuths) != len(set(azimuths)):
            raise ValueError(f"Invalid KEMAR azimuths at elevation {elevation}")
        metadata.append({"elevation": elevation, "azimuths": azimuths})
        for _, samples in directions:
            pcm.extend(samples)

    encoded = base64.b64encode(pcm).decode("ascii")
    lines = [f"  '{encoded[i:i + 100]}'" for i in range(0, len(encoded), 100)]
    output = (
        "/**\n"
        " * MIT KEMAR compact HRIR measurements, 1994: Bill Gardner and Keith Martin,\n"
        " * MIT Media Lab Machine Listening Group. The archive permits use without\n"
        " * restriction when the authors are cited in research or commercial use.\n"
        " * Source: vendor/kemar/compact.zip; regenerate with scripts/generate-kemar-hrtf.py.\n"
        " * Original samples: 44.1 kHz, 128 stereo PCM16 frames per direction.\n"
        " * This generated data contains the 368 measured positive-azimuth directions.\n"
        " */\n"
        f"export const KEMAR_RINGS: {{ elevation: number; azimuths: number[] }}[] = {json.dumps(metadata, separators=(',', ':'))}\n"
        "export const KEMAR_PCM_BASE64 =\n"
        + " +\n".join(lines)
        + "\n"
    )
    OUTPUT.write_text(output, encoding="utf-8", newline="\n")
    print(f"Generated {OUTPUT.relative_to(ROOT)} from {len(pcm)} PCM bytes")


if __name__ == "__main__":
    main()

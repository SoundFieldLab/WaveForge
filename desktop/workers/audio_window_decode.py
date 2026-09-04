#!/usr/bin/env python3
"""Decode one bounded audio window with Pedalboard for the HTDemucs runtime."""

import argparse
from pedalboard.io import AudioFile


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--input', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--start', required=True, type=float)
    parser.add_argument('--duration', required=True, type=float)
    args = parser.parse_args()
    with AudioFile(args.input) as source:
        rate = source.samplerate
        channels = source.num_channels
        start = max(0, int(round(args.start * rate)))
        frames = max(1, min(int(round(args.duration * rate)), max(0, source.frames - start)))
        source.seek(start)
        audio = source.read(frames)
    with AudioFile(args.output, 'w', rate, num_channels=channels) as output:
        output.write(audio)


if __name__ == '__main__':
    main()

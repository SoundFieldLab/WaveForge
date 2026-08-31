import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { detectOffsetFromBeats } from '../src/services/mvAlignment'

const source = process.env.WAVEFORGE_MV_ALIGNMENT_AUDIO
const negative = process.env.WAVEFORGE_MV_ALIGNMENT_NEGATIVE_AUDIO
const run = source && negative && fs.existsSync(source) && fs.existsSync(negative) ? describe : describe.skip

run('MV alignment with real audio', () => {
  it('measures zero and signed five-second offsets and rejects another song', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'waveforge-mv-align-'))
    const python = path.resolve('resources/python-embed/python.exe')
    const helper = path.join(tempDir, 'measure.py')
    const output = path.join(tempDir, 'beats.json')
    fs.writeFileSync(helper, `
import json, os, sys
import numpy as np
from pedalboard.io import AudioFile
sys.path.insert(0, os.path.abspath('python-beat-service'))
from beat_analyzer import analyze_audio_file

source, negative, out_dir, output = sys.argv[1:]
with AudioFile(source) as reader:
    rate = reader.samplerate
    audio = reader.read(reader.frames)

def write(name, data):
    target = os.path.join(out_dir, name)
    with AudioFile(target, 'w', rate, num_channels=data.shape[0]) as writer:
        writer.write(data)
    return target

silence = np.zeros((audio.shape[0], rate * 5), dtype=np.float32)
plus = write('plus-five.wav', np.concatenate([silence, audio], axis=1))
minus = write('minus-five.wav', audio[:, rate * 5:])
result = {
    'source': analyze_audio_file(source, 'real-source')['beats'],
    'same': analyze_audio_file(source, 'real-same')['beats'],
    'plus': analyze_audio_file(plus, 'real-plus')['beats'],
    'minus': analyze_audio_file(minus, 'real-minus')['beats'],
    'negative': analyze_audio_file(negative, 'real-negative')['beats'],
}
with open(output, 'w', encoding='utf-8') as handle:
    json.dump(result, handle)
`)
    try {
      execFileSync(python, [helper, source!, negative!, tempDir, output], {
        cwd: path.resolve('.'),
        stdio: 'pipe',
        timeout: 300_000,
      })
      const beats = JSON.parse(fs.readFileSync(output, 'utf8')) as Record<string, number[]>
      const same = detectOffsetFromBeats(beats.source, beats.same)
      const plus = detectOffsetFromBeats(beats.source, beats.plus)
      const minus = detectOffsetFromBeats(beats.plus, beats.source)
      const other = detectOffsetFromBeats(beats.source, beats.negative)
      expect(same?.offsetSeconds).toBeCloseTo(0, 1)
      expect(plus?.offsetSeconds).toBeCloseTo(5, 0)
      expect(minus?.offsetSeconds).toBeCloseTo(-5, 0)
      expect(other).toBeNull()
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  }, 320_000)
})

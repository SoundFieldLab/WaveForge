# -*- coding: utf-8 -*-
"""从 candidates.json × 包络库构建全类型评测集(all-type-eval-set.json)"""
import json, re, collections, sys, io, os
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, '..', '..', '.tmp-kg-align'))
sg = json.load(open(os.path.join(ROOT, 'song-envs.json'), encoding='utf-8'))
cand = json.load(open(os.path.join(ROOT, 'candidates.json'), encoding='utf-8'))

envs = {}
jsonl = os.path.join(ROOT, 'mv-envs-new.jsonl')
if os.path.exists(jsonl):
    with open(jsonl, encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if not line: continue
            try:
                o = json.loads(line)
                if o.get('bvid'): envs[o['bvid']] = o
            except Exception: pass

pairs = []
for song_key, c in cand.items():
    if c.get('status') not in ('auto', 'confirm'): continue
    song = c.get('song', {})
    song_env = sg.get(song_key) or sg.get(song.get('mid'))
    if not song_env: continue
    for item in ([c.get('best')] if c.get('best') else []) + list(c.get('chain', [])):
        if not item: continue
        mvv = envs.get(item.get('bvid'))
        if not mvv: continue
        pairs.append({'songKey': song_key, 'songName': song.get('name'), 'artist': song.get('artist'),
                      'bvid': item.get('bvid'), 'title': str(item.get('title', ''))[:70],
                      'type': item.get('type') or 'unknown',
                      'mvDur': float(mvv.get('dur') or 0), 'songDur': float(song.get('duration') or 0)})
seen = set(); uniq = []
for p in pairs:
    k = (p['songKey'], p['bvid'])
    if k in seen: continue
    seen.add(k); uniq.append(p)
out = os.path.join(HERE, 'all-type-eval-set.json')
json.dump(uniq, open(out, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
by_type = collections.Counter(p['type'] for p in uniq)
print(f'全类型配对 {len(uniq)} → all-type-eval-set.json')
print('按类型:', dict(by_type))

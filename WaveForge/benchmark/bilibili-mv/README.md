# Bilibili MV matching benchmark

This benchmark samples real Bilibili search results while reusing WaveForge's production scoring functions. It is deliberately separate from the application matching cache, remembered overrides, blacklist, login state, and playback APIs.

## Corpus

`corpus.json` contains development and holdout cases across game music, anime OP/ED, Vocaloid, Project SEKAI, multilingual pop, and classical recordings. Durations are frozen benchmark inputs and must be checked against the source music-platform record before treating a run as a release baseline.

Candidate labels use these meanings:

- `exact`: the intended recording/version.
- `acceptable`: the same recording in a suitable official or high-quality visual form.
- `partial-tv`: a TV-size OP/ED for a longer source track.
- `alternate-recording`: same work, different singer, ensemble, live take, or game arrangement.
- `derived-edit`: fan extension, loop, remix, speed or pitch edit.
- `wrong-work`: unrelated or same-title different work.

## Run

```bash
npm run benchmark:mv -- --limit=2 --output=benchmark/bilibili-mv/reports/smoke.json
npm run benchmark:mv -- --split=dev --output=benchmark/bilibili-mv/reports/dev.json
npm run benchmark:mv -- --split=holdout --output=benchmark/bilibili-mv/reports/holdout.json
```

The runner starts a read-only Bilibili API on an isolated port and calls the production `findBestBilibiliMv` path. It writes JSON progress after every case and a Markdown Top-5 summary at completion. Requests are serialized before dispatch to limit bursts. A run with failed cases exits non-zero after preserving its report; pass `--allow-failures` only when collecting diagnostic partial data.

Reports include the Git commit, dirty-tree flag, scoring/corpus source hash and fixed matcher settings. `lyricsProvider` is intentionally omitted, so this represents the cold-start path before platform lyrics are available.

Set `BILIBILI_BENCHMARK_DELAY_SCALE=0.1` only for local smoke tests; normal collection should retain the default pacing.

`source-registry.json` is an evidence registry, not a blanket keyword allowlist. Add a Bilibili MID only after verifying it through an official project, publisher, artist, or label source. Scope each source to the relevant artist or franchise.
